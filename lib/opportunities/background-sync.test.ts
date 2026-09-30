/**
 * Phase 2C: the Dashboard's opportunity sync runs after the response, off
 * the blocking render path - lib/opportunities/background-sync.ts.
 * Performance Pass 2: inside that after() task, claim_opportunity_sync gates
 * the sync to at most once per organization per 5 minutes.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/opportunities/background-sync.test.ts
 */
import { test, before, after as afterAll } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(path.join(process.cwd(), "package.json"));
const { scheduleOpportunitySync }: typeof import("./background-sync") = require(path.join(process.cwd(), "lib/opportunities/background-sync.ts"));

const ORG = "11111111-1111-4111-8111-111111111111";
const TOKEN = "header.eyJzdWIiOiJ1c2VyLWEifQ.signature";

function requestClient(session: { access_token: string } | null | "throws") {
  return {
    auth: {
      getSession: async () => {
        if (session === "throws") throw new Error("cookie store unavailable");
        return { data: { session }, error: null };
      },
    },
    from: () => {
      throw new Error("the request's own client must never be used by the background sync");
    },
  } as unknown as SupabaseClient;
}

type ClaimReply = { data: unknown; error: { message: string } | null } | "throws" | "never";

/** The token client's rpc() stand-in for claim_opportunity_sync; defaults to a won claim. */
function harness(overrides: { sync?: (client: SupabaseClient, organizationId: string) => Promise<unknown>; claim?: ClaimReply } = {}) {
  const tasks: (() => Promise<void>)[] = [];
  const logs: { message: string; context: Record<string, unknown> }[] = [];
  const syncCalls: { client: SupabaseClient; organizationId: string }[] = [];
  const tokenClients: string[] = [];
  const clients: SupabaseClient[] = [];
  const rpcCalls: { client: SupabaseClient; fn: string; args: unknown }[] = [];
  const claim = overrides.claim ?? { data: true, error: null };
  const deps = {
    after: (task: () => Promise<void>) => void tasks.push(task),
    sync:
      overrides.sync ??
      (async (client: SupabaseClient, organizationId: string) => {
        syncCalls.push({ client, organizationId });
        return { created: 0, refreshed: 0, resolved: 0, unchanged: 0, suppressed: 0 };
      }),
    createClient: (accessToken: string) => {
      tokenClients.push(accessToken);
      const client = {
        tokenClient: accessToken,
        rpc: async (fn: string, args: unknown) => {
          rpcCalls.push({ client: client as unknown as SupabaseClient, fn, args });
          if (claim === "throws") throw new Error("network down");
          if (claim === "never") return new Promise(() => {});
          return claim;
        },
      } as unknown as SupabaseClient;
      clients.push(client);
      return client;
    },
    log: (message: string, context: Record<string, unknown>) => void logs.push({ message, context }),
  };
  return { deps, tasks, logs, syncCalls, tokenClients, clients, rpcCalls };
}

test("background invocation: the sync is handed to after() and does not run until after() runs it", async () => {
  const h = harness();
  await scheduleOpportunitySync(requestClient({ access_token: TOKEN }), ORG, h.deps);
  assert.equal(h.tasks.length, 1, "exactly one after() task scheduled");
  assert.equal(h.syncCalls.length, 0, "nothing synced during render");
  await h.tasks[0]();
  assert.equal(h.syncCalls.length, 1);
  assert.equal(h.syncCalls[0].organizationId, ORG);
});

test("tenant isolation: the post-response sync runs on a client built from this session's own access token - never the request client, never a service-role client", async () => {
  const h = harness();
  await scheduleOpportunitySync(requestClient({ access_token: TOKEN }), ORG, h.deps);
  await h.tasks[0]();
  assert.deepEqual(h.tokenClients, [TOKEN]);
  assert.equal(h.syncCalls[0].client, h.clients[0], "the sync runs on the one client built from the token");
  assert.equal((h.syncCalls[0].client as unknown as { tokenClient: string }).tokenClient, TOKEN);
});

test("render independence: a sync that never finishes cannot hold up the caller", async () => {
  const h = harness({ sync: () => new Promise(() => {}) });
  // Even with an after() that starts the task immediately (worst case), scheduling returns at once.
  const eagerAfter = (task: () => Promise<void>) => void task();
  const started = Date.now();
  await scheduleOpportunitySync(requestClient({ access_token: TOKEN }), ORG, { ...h.deps, after: eagerAfter });
  assert.ok(Date.now() - started < 200, "scheduleOpportunitySync resolved without waiting for the stalled sync");
});

test("error isolation: a rejecting sync is caught and logged - the after() task resolves and nothing reaches the page", async () => {
  const h = harness({ sync: async () => { throw new Error("detector exploded"); } });
  await scheduleOpportunitySync(requestClient({ access_token: TOKEN }), ORG, h.deps);
  await assert.doesNotReject(h.tasks[0]());
  assert.equal(h.logs.length, 1);
  assert.equal(h.logs[0].message, "[opportunities] background sync failed");
  assert.deepEqual(h.logs[0].context, { organizationId: ORG, error: "detector exploded" });
});

test("no session, or a session read that throws: nothing is scheduled, it is logged, and scheduleOpportunitySync still resolves", async () => {
  for (const session of [null, "throws"] as const) {
    const h = harness();
    await assert.doesNotReject(scheduleOpportunitySync(requestClient(session), ORG, h.deps));
    assert.equal(h.tasks.length, 0, String(session));
    assert.equal(h.logs.length, 1, String(session));
    assert.match(h.logs[0].message, /^\[opportunities\] background sync not scheduled/);
  }
});

// ---------------------------------------------------------------------------
// Performance Pass 2: the claim gate inside the after() task
// ---------------------------------------------------------------------------

test("claim won: claim_opportunity_sync is called with exactly the caller's organization, on the same token client the sync then runs on", async () => {
  const h = harness({ claim: { data: true, error: null } });
  await scheduleOpportunitySync(requestClient({ access_token: TOKEN }), ORG, h.deps);
  await h.tasks[0]();
  assert.deepEqual(h.rpcCalls.map((c) => [c.fn, c.args]), [["claim_opportunity_sync", { p_organization_id: ORG }]], "one claim, organization id only - no cooldown or other input");
  assert.equal(h.clients.length, 1, "the client is created once");
  assert.equal(h.rpcCalls[0].client, h.clients[0]);
  assert.equal(h.syncCalls.length, 1);
  assert.equal(h.syncCalls[0].client, h.clients[0]);
  assert.equal(h.logs.length, 0);
});

test("claim lost (another request synced within 5 minutes, or not eligible): the sync is skipped quietly - no log, no error", async () => {
  for (const data of [false, null]) {
    const h = harness({ claim: { data, error: null } });
    await scheduleOpportunitySync(requestClient({ access_token: TOKEN }), ORG, h.deps);
    await assert.doesNotReject(h.tasks[0]());
    assert.equal(h.rpcCalls.length, 1, String(data));
    assert.equal(h.syncCalls.length, 0, `${data}: no sync`);
    assert.equal(h.logs.length, 0, `${data}: nothing logged`);
  }
});

test("claim RPC returns an error: logged as 'background sync skipped: claim failed' and the sync is skipped - never a blind sync", async () => {
  const h = harness({ claim: { data: null, error: { message: "function public.claim_opportunity_sync(uuid) does not exist" } } });
  await scheduleOpportunitySync(requestClient({ access_token: TOKEN }), ORG, h.deps);
  await assert.doesNotReject(h.tasks[0]());
  assert.equal(h.syncCalls.length, 0);
  assert.deepEqual(h.logs, [{ message: "[opportunities] background sync skipped: claim failed", context: { organizationId: ORG, error: "function public.claim_opportunity_sync(uuid) does not exist" } }]);
});

test("claim RPC throws: logged the same way, the sync is skipped, and the after() task still resolves", async () => {
  const h = harness({ claim: "throws" });
  await scheduleOpportunitySync(requestClient({ access_token: TOKEN }), ORG, h.deps);
  await assert.doesNotReject(h.tasks[0]());
  assert.equal(h.syncCalls.length, 0);
  assert.deepEqual(h.logs, [{ message: "[opportunities] background sync skipped: claim failed", context: { organizationId: ORG, error: "network down" } }]);
});

test("nothing runs before after() fires: no client, no claim, no sync during render", async () => {
  const h = harness();
  await scheduleOpportunitySync(requestClient({ access_token: TOKEN }), ORG, h.deps);
  assert.equal(h.tasks.length, 1);
  assert.deepEqual([h.tokenClients.length, h.rpcCalls.length, h.syncCalls.length], [0, 0, 0], "render did no claim work at all");
  await h.tasks[0]();
  assert.deepEqual([h.tokenClients.length, h.rpcCalls.length, h.syncCalls.length], [1, 1, 1]);
});

test("render independence holds for the claim too: a claim that never answers cannot hold up the caller", async () => {
  const h = harness({ claim: "never" });
  const eagerAfter = (task: () => Promise<void>) => void task();
  const started = Date.now();
  await scheduleOpportunitySync(requestClient({ access_token: TOKEN }), ORG, { ...h.deps, after: eagerAfter });
  assert.ok(Date.now() - started < 200, "scheduleOpportunitySync resolved without waiting for the stalled claim");
  assert.equal(h.syncCalls.length, 0);
});

// ---------------------------------------------------------------------------
// The access-token client, for real: supabase-js against a local fake server.
// ---------------------------------------------------------------------------

const seen: { authorization: string | undefined; apikey: string | undefined; cookie: string | undefined; path: string }[] = [];
const server = http.createServer((req, res) => {
  seen.push({ authorization: req.headers.authorization, apikey: req.headers.apikey as string | undefined, cookie: req.headers.cookie, path: new URL(req.url ?? "/", "http://x").pathname });
  res.writeHead(200, { "content-type": "application/json", "content-range": "0-0/0" }).end("[]");
});

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "fake-anon-key-for-local-test-only";
});
afterAll(() => server.close());

test("createAccessTokenClient: every query carries the user's own JWT and the anon key - no cookies, no service role", async () => {
  const { createAccessTokenClient }: typeof import("@/lib/supabase/access-token-client") = require(path.join(process.cwd(), "lib/supabase/access-token-client.ts"));
  const client = createAccessTokenClient(TOKEN);
  await client.from("opportunities").select("id").eq("organization_id", ORG);
  await client.from("opportunities").insert({ organization_id: ORG });
  assert.equal(seen.length, 2);
  for (const request of seen) {
    assert.equal(request.authorization, `Bearer ${TOKEN}`);
    assert.equal(request.apikey, "fake-anon-key-for-local-test-only");
    assert.equal(request.cookie, undefined);
    assert.equal(request.path, "/rest/v1/opportunities");
  }
});

test("createAccessTokenClient: the claim RPC is sent to /rest/v1/rpc/claim_opportunity_sync with the user's own JWT and the anon key", async () => {
  const { createAccessTokenClient }: typeof import("@/lib/supabase/access-token-client") = require(path.join(process.cwd(), "lib/supabase/access-token-client.ts"));
  seen.length = 0;
  await createAccessTokenClient(TOKEN).rpc("claim_opportunity_sync", { p_organization_id: ORG });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].path, "/rest/v1/rpc/claim_opportunity_sync");
  assert.equal(seen[0].authorization, `Bearer ${TOKEN}`);
  assert.equal(seen[0].apikey, "fake-anon-key-for-local-test-only");
  assert.equal(seen[0].cookie, undefined);
});

// ---------------------------------------------------------------------------
// Structural guards
// ---------------------------------------------------------------------------

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("critical-path removal: /today never awaits (or directly calls) syncOpportunities again", () => {
  const page = read("app/(app)/today/page.tsx");
  assert.doesNotMatch(page, /syncOpportunities/, "the Dashboard must not call the sync on its render path");
  assert.doesNotMatch(page, /await scheduleOpportunitySync/, "scheduling runs inside the page's single parallel batch, not as its own blocking step");
  const batch = page.slice(page.indexOf("await Promise.all(["), page.indexOf("]);", page.indexOf("await Promise.all([")));
  assert.match(batch, /scheduleOpportunitySync\(supabase, membership\.organizationId\),/);
});

test("the background path uses next/server after(), a token-scoped client, and never the service role", () => {
  const sync = read("lib/opportunities/background-sync.ts");
  assert.match(sync, /^import \{ after \} from "next\/server";/m);
  // Pass 2: one token client per task, claimed first, then synced - all inside the after() callback.
  const task = sync.slice(sync.indexOf("schedule(async () => {"));
  assert.match(task, /const client = makeClient\(token\);[\s\S]*client\.rpc\("claim_opportunity_sync", \{ p_organization_id: organizationId \}\)[\s\S]*if \(!claimed\) return;[\s\S]*await sync\(client, organizationId\);/);
  assert.equal((sync.match(/claim_opportunity_sync/g) ?? []).length, 1, "the claim is made only inside the after() task");
  assert.ok(sync.indexOf("claim_opportunity_sync") > sync.indexOf("schedule(async () => {"), "never during render");
  const client = read("lib/supabase/access-token-client.ts");
  assert.match(client, /NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  assert.match(client, /accessToken: async \(\) => accessToken/);
  for (const source of [sync, client]) {
    assert.doesNotMatch(source, /SERVICE_ROLE|createServiceRoleClient|next\/headers|cookies\(/);
  }
});

test("syncOpportunities itself is unchanged in its contract: it takes the client and organization it is given", () => {
  assert.match(read("lib/opportunities/detect.ts"), /export async function syncOpportunities\(supabase: SupabaseClient, organizationId: string, now: Date = new Date\(\)\): Promise<OpportunitySyncResult>/);
});

/**
 * Phase 2C: the Dashboard's opportunity sync runs after the response, off
 * the blocking render path - lib/opportunities/background-sync.ts.
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

function harness(overrides: { sync?: (client: SupabaseClient, organizationId: string) => Promise<unknown> } = {}) {
  const tasks: (() => Promise<void>)[] = [];
  const logs: { message: string; context: Record<string, unknown> }[] = [];
  const syncCalls: { client: SupabaseClient; organizationId: string }[] = [];
  const tokenClients: string[] = [];
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
      return { tokenClient: accessToken } as unknown as SupabaseClient;
    },
    log: (message: string, context: Record<string, unknown>) => void logs.push({ message, context }),
  };
  return { deps, tasks, logs, syncCalls, tokenClients };
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
  assert.deepEqual(h.syncCalls[0].client, { tokenClient: TOKEN });
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
  assert.match(sync, /await sync\(makeClient\(token\), organizationId\);/);
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

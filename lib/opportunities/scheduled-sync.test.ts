/**
 * Phase 3D: scheduled opportunity sync - eligibility (payment-active
 * organizations only), per-organization isolation, the shared 5-minute
 * throttle maintained by the service role, overlap/repeat safety, scan
 * failure, CRON_SECRET authorization of the route, liveness recording and
 * the absence of any outbound-messaging path.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/opportunities/scheduled-sync.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const { runScheduledOpportunitySync, SCHEDULED_SYNC_COOLDOWN_MS }: typeof import("./scheduled-sync") = require(path.join(ROOT, "lib/opportunities/scheduled-sync.ts"));
const { GET, POST }: typeof import("@/app/api/automation/opportunity-sync/route") = require(path.join(ROOT, "app/api/automation/opportunity-sync/route.ts"));
const { NextRequest }: typeof import("next/server") = require("next/server");

type Call = { table: string; calls: string[] };
type State = Map<string, string>;

/**
 * A fake service-role client: `organizations` returns `orgs` only when the
 * read is filtered to payment_status = active (so a missing filter fails the
 * test); `opportunity_sync_state` is a real in-memory map behind
 * select/maybeSingle and upsert.
 */
function fakeService(orgs: string[], state: State = new Map(), options: { scanError?: boolean; stateReadErrorFor?: string } = {}) {
  const calls: Call[] = [];
  const upserts: { organization_id: string; last_started_at: string }[] = [];
  const supabase = {
    from(table: string) {
      const call: Call = { table, calls: [] };
      calls.push(call);
      const filters: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {};
      const chain = (name: string) => (...args: unknown[]) => {
        call.calls.push(`${name} ${args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")}`);
        if (name === "eq") filters[String(args[0])] = args[1];
        return builder;
      };
      for (const name of ["select", "eq", "order"]) builder[name] = chain(name);
      builder.range = (from: number, to: number) => {
        call.calls.push(`range ${from} ${to}`);
        if (options.scanError) return Promise.resolve({ data: null, error: { message: "boom" } });
        const rows = filters.payment_status === "active" ? orgs.map((id) => ({ id })) : [];
        return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
      };
      builder.maybeSingle = () => {
        const org = String(filters.organization_id);
        if (options.stateReadErrorFor === org) return Promise.resolve({ data: null, error: { message: "boom" } });
        const last = state.get(org);
        return Promise.resolve({ data: last ? { last_started_at: last } : null, error: null });
      };
      builder.upsert = (row: { organization_id: string; last_started_at: string }, opts: unknown) => {
        call.calls.push(`upsert ${JSON.stringify(opts)}`);
        upserts.push(row);
        state.set(row.organization_id, row.last_started_at);
        return Promise.resolve({ error: null });
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { supabase, calls, upserts, state };
}

const NOW = new Date("2026-10-02T12:00:00.000Z");
const ok = async () => ({ created: 0, refreshed: 0, resolved: 0, unchanged: 0, suppressed: 0 });
const quiet = () => {};

test("syncs every payment-active organization (the scan is filtered to payment_status = active), sequentially, with the service client", async () => {
  const { supabase, calls } = fakeService(["org-a", "org-b", "org-c"]);
  const synced: string[] = [];
  const result = await runScheduledOpportunitySync(supabase, NOW, { sync: async (client, id) => (assert.equal(client, supabase), synced.push(id), ok()), log: quiet });
  assert.deepEqual(synced, ["org-a", "org-b", "org-c"]);
  assert.deepEqual([result.candidates, result.synced, result.throttled, result.failed, result.scanFailed], [3, 3, 0, 0, false]);
  const scan = calls.find((c) => c.table === "organizations")!;
  assert.ok(scan.calls.includes("eq payment_status active") && scan.calls.includes("order id"), "payment-active only, paged in id order");
});

test("organizations that aren't payment-active are never synced (the fake returns none without the active filter)", async () => {
  const { supabase } = fakeService([]);
  const synced: string[] = [];
  const result = await runScheduledOpportunitySync(supabase, NOW, { sync: async (_c, id) => (synced.push(id), ok()), log: quiet });
  assert.deepEqual([synced, result.candidates], [[], 0]);
});

test("one organization failing - a thrown error, a failed sync result or a throttle-state read error - never stops the others", async () => {
  const { supabase } = fakeService(["org-a", "org-b", "org-c", "org-d"], new Map(), { stateReadErrorFor: "org-d" });
  const synced: string[] = [];
  const result = await runScheduledOpportunitySync(supabase, NOW, {
    sync: async (_c, id) => {
      synced.push(id);
      if (id === "org-a") throw new Error("unexpected");
      if (id === "org-b") return { ...(await ok()), failed: true as const };
      return ok();
    },
    log: quiet,
  });
  assert.deepEqual(synced, ["org-a", "org-b", "org-c"], "org-d's state read failed before its sync; c still ran after a and b failed");
  assert.deepEqual(result.outcomes.map((o) => o.outcome), ["failed", "failed", "synced", "failed"]);
  assert.deepEqual([result.synced, result.failed], [1, 3]);
});

test("the shared 5-minute throttle: a recent claim (e.g. a /today sync) skips the org; an older one is re-claimed with the run's time", async () => {
  const state: State = new Map([
    ["org-recent", new Date(NOW.getTime() - 2 * 60 * 1000).toISOString()],
    ["org-old", new Date(NOW.getTime() - SCHEDULED_SYNC_COOLDOWN_MS).toISOString()],
  ]);
  const { supabase, upserts } = fakeService(["org-recent", "org-old", "org-new"], state);
  const synced: string[] = [];
  const result = await runScheduledOpportunitySync(supabase, NOW, { sync: async (_c, id) => (synced.push(id), ok()), log: quiet });
  assert.deepEqual(synced, ["org-old", "org-new"]);
  assert.deepEqual(result.outcomes.map((o) => o.outcome), ["throttled", "synced", "synced"]);
  assert.deepEqual(upserts, [
    { organization_id: "org-old", last_started_at: NOW.toISOString() },
    { organization_id: "org-new", last_started_at: NOW.toISOString() },
  ]);
});

test("overlap/repeat safety: an immediate second run (or an overlapping one) throttles every organization instead of re-syncing", async () => {
  const { supabase } = fakeService(["org-a", "org-b"]);
  let syncs = 0;
  const deps = { sync: async () => (syncs++, ok()), log: quiet };
  await runScheduledOpportunitySync(supabase, NOW, deps);
  const second = await runScheduledOpportunitySync(supabase, new Date(NOW.getTime() + 60 * 1000), deps);
  assert.equal(syncs, 2);
  assert.deepEqual([second.throttled, second.synced], [2, 0]);
});

test("a failed eligible-organization scan syncs nothing and reports scanFailed", async () => {
  const { supabase } = fakeService(["org-a"], new Map(), { scanError: true });
  let syncs = 0;
  const result = await runScheduledOpportunitySync(supabase, NOW, { sync: async () => (syncs++, ok()), log: quiet });
  assert.deepEqual([syncs, result.scanFailed, result.candidates], [0, true, 0]);
});

test("route: CRON_SECRET authorization fails closed - no header, a wrong secret, or an unset secret all get 401 (GET and POST)", async () => {
  const original = process.env.CRON_SECRET;
  try {
    process.env.CRON_SECRET = "test-secret-value";
    for (const handler of [GET, POST]) {
      assert.equal((await handler(new NextRequest("https://example.test/api/automation/opportunity-sync"))).status, 401);
      assert.equal((await handler(new NextRequest("https://example.test/api/automation/opportunity-sync", { headers: { authorization: "Bearer wrong-secret-value" } }))).status, 401);
    }
    delete process.env.CRON_SECRET;
    assert.equal((await GET(new NextRequest("https://example.test/api/automation/opportunity-sync", { headers: { authorization: "Bearer test-secret-value" } }))).status, 401);
  } finally {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  }
});

test("route: authorizes before creating the service client, and records liveness as 'opportunity-sync' with the candidate count", () => {
  const source = fs.readFileSync(path.join(ROOT, "app/api/automation/opportunity-sync/route.ts"), "utf8");
  assert.ok(source.indexOf("isAuthorizedCronRequest(request)") < source.indexOf("createServiceRoleClient()"));
  assert.match(source, /recordScheduledAutomationRun\(service, "opportunity-sync", result\.candidates\)/);
});

test("no outbound messaging: the scheduled sync, its route and syncOpportunities import nothing that sends SMS, email, notifications or n8n dispatches", () => {
  const forbidden = /@\/lib\/messaging|@\/lib\/notifications|lib\/automation\/(sms|n8n|outbound)|sendOutboundMessage|notifyFounder|triggerN8nWorkflow|twilio|resend/i;
  for (const file of ["lib/opportunities/scheduled-sync.ts", "app/api/automation/opportunity-sync/route.ts", "lib/opportunities/detect.ts"]) {
    const imports = fs.readFileSync(path.join(ROOT, file), "utf8").split("\n").filter((line) => /^\s*import\s/.test(line) || /\bfrom\s+"/.test(line)).join("\n");
    assert.doesNotMatch(imports, forbidden, file);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, "lib/opportunities/scheduled-sync.ts"), "utf8"), /claim_opportunity_sync"\s*,|\.rpc\(/, "the session-only claim RPC is not used");
});

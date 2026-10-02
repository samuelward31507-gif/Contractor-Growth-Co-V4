/**
 * Phase 3D: the once-daily scheduler watchdog - fresh / stale / missing
 * heartbeat, a stale scheduled route, a failed heartbeat read (no alert
 * either way), repeat safety, CRON_SECRET authorization, and proof that it
 * never calls a business automation route, opportunity sync or any
 * messaging path itself.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation-health/scheduler-watchdog.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const { runSchedulerWatchdog }: typeof import("./scheduler-watchdog") = require(path.join(ROOT, "lib/automation-health/scheduler-watchdog.ts"));
const { HEALTH_CHECK_STALE_THRESHOLD_MS }: typeof import("./health") = require(path.join(ROOT, "lib/automation-health/health.ts"));
const { GET }: typeof import("@/app/api/automation/scheduler-watchdog/route") = require(path.join(ROOT, "app/api/automation/scheduler-watchdog/route.ts"));
const { NextRequest }: typeof import("next/server") = require("next/server");

type Liveness = Awaited<ReturnType<NonNullable<Parameters<typeof runSchedulerWatchdog>[2]>["getLiveness"] & {}>>;

/** A read-only fake: only the heartbeat read is answered; any other table, write or RPC is recorded so a test can prove none happened. */
function fakeService(heartbeat: { checked_at: string } | null, error = false) {
  const unexpected: string[] = [];
  const supabase = {
    from(table: string) {
      if (table !== "automation_health_check_runs") unexpected.push(`from ${table}`);
      const builder: Record<string, unknown> = {};
      for (const name of ["select", "order", "limit"]) builder[name] = () => builder;
      for (const name of ["insert", "update", "upsert", "delete"]) builder[name] = () => (unexpected.push(`${name} ${table}`), builder);
      builder.maybeSingle = () => Promise.resolve(error ? { data: null, error: { message: "boom" } } : { data: heartbeat, error: null });
      return builder;
    },
    rpc: (name: string) => (unexpected.push(`rpc ${name}`), Promise.resolve({ data: null, error: null })),
  } as unknown as SupabaseClient;
  return { supabase, unexpected };
}

const NOW = new Date("2026-10-02T14:30:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const liveness = (stale: string[] = []): Liveness =>
  ["appointment-reminders", "estimate-followup", "lost-lead-nurture", "lead-reactivation", "customer-reactivation", "no-show-detection", "opportunity-sync"].map((automationId) => ({
    automationId,
    automationName: automationId,
    state: stale.includes(automationId) ? ("stale" as const) : ("healthy" as const),
    lastRanAt: ago(stale.includes(automationId) ? 2 * 60 * 60 * 1000 : 60 * 1000),
    lastCandidateCount: 0,
  })) as Liveness;

function recorder() {
  const alerts: boolean[] = [];
  return { alerts, evaluateAlert: async (_s: SupabaseClient, isStale: boolean) => (alerts.push(isStale), { notified: isStale ? 1 : 0, resolved: isStale ? 0 : 1 }) };
}

test("fresh heartbeat and every route healthy: not degraded - the existing alert path is told 'not stale' (which resolves any open incident)", async () => {
  const { supabase, unexpected } = fakeService({ checked_at: ago(10 * 60 * 1000) });
  const { alerts, evaluateAlert } = recorder();
  const result = await runSchedulerWatchdog(supabase, NOW, { getLiveness: async () => liveness(), evaluateAlert });
  assert.deepEqual([result.degraded, result.heartbeatStale, result.staleAutomations, alerts], [false, false, [], [false]]);
  assert.deepEqual(unexpected, []);
});

test("stale heartbeat (older than the 45-minute threshold): degraded - the existing degraded-automation alert is raised", async () => {
  const { supabase } = fakeService({ checked_at: ago(HEALTH_CHECK_STALE_THRESHOLD_MS + 60 * 1000) });
  const { alerts, evaluateAlert } = recorder();
  const result = await runSchedulerWatchdog(supabase, NOW, { getLiveness: async () => liveness(), evaluateAlert });
  assert.deepEqual([result.degraded, result.heartbeatStale, alerts], [true, true, [true]]);
});

test("missing heartbeat (the health job never ran): treated as stale - the alert is raised", async () => {
  const { supabase } = fakeService(null);
  const { alerts, evaluateAlert } = recorder();
  const result = await runSchedulerWatchdog(supabase, NOW, { getLiveness: async () => liveness(), evaluateAlert });
  assert.deepEqual([result.degraded, result.heartbeatStale, result.lastHeartbeatAt, alerts], [true, true, null, [true]]);
});

test("fresh heartbeat but a stale scheduled route (e.g. opportunity-sync): degraded, and the route is named", async () => {
  const { supabase } = fakeService({ checked_at: ago(5 * 60 * 1000) });
  const { alerts, evaluateAlert } = recorder();
  const result = await runSchedulerWatchdog(supabase, NOW, { getLiveness: async () => liveness(["opportunity-sync"]), evaluateAlert });
  assert.deepEqual([result.degraded, result.heartbeatStale, result.staleAutomations, alerts], [true, false, ["opportunity-sync"], [true]]);
});

test("a failed heartbeat read is reported, never treated as an outage: no alert is raised or resolved", async () => {
  const { supabase } = fakeService(null, true);
  const { alerts, evaluateAlert } = recorder();
  let livenessRead = false;
  const result = await runSchedulerWatchdog(supabase, NOW, { getLiveness: async () => ((livenessRead = true), liveness()), evaluateAlert });
  assert.deepEqual([result.heartbeatReadFailed, result.degraded, result.alert, alerts, livenessRead], [true, false, null, [], false]);
});

test("repeated invocation is safe: same inputs give the same decision, and the watchdog itself writes nothing (dedup lives in the existing incident fingerprint)", async () => {
  const { supabase, unexpected } = fakeService(null);
  const { alerts, evaluateAlert } = recorder();
  const first = await runSchedulerWatchdog(supabase, NOW, { getLiveness: async () => liveness(), evaluateAlert });
  const second = await runSchedulerWatchdog(supabase, NOW, { getLiveness: async () => liveness(), evaluateAlert });
  assert.deepEqual([first.degraded, second.degraded, alerts], [true, true, [true, true]]);
  assert.deepEqual(unexpected, [], "no table other than the heartbeat, no write, no RPC");
  assert.match(fs.readFileSync(path.join(ROOT, "lib/automation-health/scheduled-automation-alert.ts"), "utf8"), /ON CONFLICT \(organization_id,\s*\n?\s*\*?\s*fingerprint\)/, "the existing alert path's dedup is what makes repeats notification-safe");
});

test("never calls business automation routes, opportunity sync or messaging: no fetch, no automation/opportunity/messaging imports", () => {
  for (const file of ["lib/automation-health/scheduler-watchdog.ts", "app/api/automation/scheduler-watchdog/route.ts"]) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(code, /\bfetch\(|net\.http|\/api\/automation\//, `${file}: never invokes a route`);
    // The shared CRON_SECRET check is the one lib/automation module allowed.
    assert.doesNotMatch(code, /from "@\/lib\/(automation\/(?!cron-auth")|opportunities\/|messaging\/|notifications\/)/, `${file}: no business automation, opportunity or messaging module`);
  }
});

test("route: CRON_SECRET authorization - missing/wrong/unset secret get 401; a valid secret passes auth", async () => {
  const saved = { secret: process.env.CRON_SECRET, url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  try {
    process.env.CRON_SECRET = "test-secret-value";
    assert.equal((await GET(new NextRequest("https://example.test/api/automation/scheduler-watchdog"))).status, 401);
    assert.equal((await GET(new NextRequest("https://example.test/api/automation/scheduler-watchdog", { headers: { authorization: "Bearer wrong-secret-value" } }))).status, 401);
    // Valid secret: point the service client at a closed local port with a
    // dummy key, so this never reaches a real project. The heartbeat read
    // fails, which the watchdog reports without raising or resolving alerts.
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "dummy-not-a-key";
    const authorized = await GET(new NextRequest("https://example.test/api/automation/scheduler-watchdog", { headers: { authorization: "Bearer test-secret-value" } }));
    assert.equal(authorized.status, 200);
    assert.deepEqual(await authorized.json(), { ok: false, degraded: false, heartbeatStale: false, lastHeartbeatAt: null, staleAutomations: [], notified: 0, resolved: 0 });
    delete process.env.CRON_SECRET;
    assert.equal((await GET(new NextRequest("https://example.test/api/automation/scheduler-watchdog", { headers: { authorization: "Bearer test-secret-value" } }))).status, 401);
  } finally {
    for (const [key, value] of [["CRON_SECRET", saved.secret], ["NEXT_PUBLIC_SUPABASE_URL", saved.url], ["SUPABASE_SERVICE_ROLE_KEY", saved.key]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

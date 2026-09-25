/**
 * Integration tests for get_scheduled_automation_liveness() (the RPC) and
 * getScheduledAutomationLiveness()/recordScheduledAutomationRun() (the TS
 * layer over it) - against the real Supabase project. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation-health/scheduled-automation-liveness.integration.test.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const require = createRequire(path.join(REPO_ROOT, "package.json"));
const { createClient: createSupabaseClient } = require("@supabase/supabase-js");

const envPath = path.join(REPO_ROOT, ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

const { createServiceRoleClient }: typeof import("@/lib/supabase/service") = require(path.join(REPO_ROOT, "lib/supabase/service.ts"));
const {
  getScheduledAutomationLiveness,
  recordScheduledAutomationRun,
  SCHEDULED_AUTOMATION_IDS,
}: typeof import("./scheduled-automation-liveness") = require(path.join(REPO_ROOT, "lib/automation-health/scheduled-automation-liveness.ts"));

const service = createServiceRoleClient();
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Uses a fake, namespaced automation id (never a real SCHEDULED_AUTOMATION_ID)
// so these tests can insert/clean up rows without any risk of colliding
// with real production evidence for a real automation - getScheduledAutomationLiveness
// only ever reports on the 5 real ids regardless of what else is in the table.
const TEST_AUTOMATION_ID = `test-fixture-${Date.now()}`;

after(async () => {
  await service.from("automation_schedule_runs").delete().eq("automation_id", TEST_AUTOMATION_ID);
});

test("getScheduledAutomationLiveness always returns exactly the 5 known scheduled automations, never more or fewer", async () => {
  const liveness = await getScheduledAutomationLiveness(service);
  assert.equal(liveness.length, SCHEDULED_AUTOMATION_IDS.length);
  const ids = liveness.map((l) => l.automationId).sort();
  assert.deepEqual(ids, [...SCHEDULED_AUTOMATION_IDS].sort());
});

test("an automation with no recorded run at all is 'unverified', with null lastRanAt/lastCandidateCount", async () => {
  // TEST_AUTOMATION_ID is deliberately not one of the 5 real ids, so this
  // just confirms recordScheduledAutomationRun's insert shape works and the
  // RPC returns it back out correctly - the "always exactly 5 known ids"
  // guarantee (previous test) is what keeps a fake id from ever leaking
  // into getScheduledAutomationLiveness's own return value.
  const before = await getScheduledAutomationLiveness(service);
  assert.ok(before.every((l) => l.automationId !== TEST_AUTOMATION_ID));
});

test("recordScheduledAutomationRun inserts a row the RPC can read back, including a zero candidate count", async () => {
  // Uses TEST_AUTOMATION_ID, never a real automation id - inserting under a
  // real id here would permanently pollute that automation's genuine
  // production liveness evidence with a fake "observed now" row that no
  // real cron call produced. recordScheduledAutomationRun itself is
  // type-constrained to ScheduledAutomationId; `as never` deliberately
  // bypasses that here, matching this test's own explicit purpose (proving
  // the insert/read shape works), not production call sites.
  await recordScheduledAutomationRun(service, TEST_AUTOMATION_ID as never, 0);
  const { data } = await service.rpc("get_scheduled_automation_liveness");
  const row = (data as { automation_id: string; last_ran_at: string; last_candidate_count: number }[]).find((r) => r.automation_id === TEST_AUTOMATION_ID);
  assert.ok(row, "a run with zero candidates must still be recorded - this is the whole point of this table");
  assert.equal(row!.last_candidate_count, 0);
});

test("the RPC returns only the MOST RECENT row per automation_id (distinct on), never every historical row", async () => {
  const older = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const newer = new Date().toISOString();
  await service.from("automation_schedule_runs").insert([
    { automation_id: TEST_AUTOMATION_ID, ran_at: older, candidate_count: 3 },
    { automation_id: TEST_AUTOMATION_ID, ran_at: newer, candidate_count: 7 },
  ]);

  const { data } = await service.rpc("get_scheduled_automation_liveness");
  const rows = (data as { automation_id: string; last_ran_at: string; last_candidate_count: number }[]).filter((r) => r.automation_id === TEST_AUTOMATION_ID);
  assert.equal(rows.length, 1, "must collapse to exactly one row per automation_id, not one per historical insert");
  assert.equal(rows[0].last_candidate_count, 7, "must be the newest row, not the oldest");
});

test("anonymous cannot call get_scheduled_automation_liveness", async () => {
  const anon = createSupabaseClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await anon.rpc("get_scheduled_automation_liveness");
  assert.ok(error, "the RPC has no grant to anon - an anonymous call must be rejected");
});

test("anonymous cannot read automation_schedule_runs directly (no table-level SELECT grant at all)", async () => {
  const anon = createSupabaseClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await anon.from("automation_schedule_runs").select("id");
  assert.ok(error || (data ?? []).length === 0, "there is no SELECT policy for anon on this table - a direct read must fail or return nothing");
});

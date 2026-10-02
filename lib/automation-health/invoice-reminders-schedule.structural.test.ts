/**
 * Phase 3G-2b: static checks on the invoice-reminders scheduler migration
 * (supabase/migrations/20261002162913_invoice_reminders_schedule.sql and its
 * rollback in supabase/pending/). The
 * SQL's runtime behavior is exercised against PGlite by
 * supabase/pending/scratch/validate-invoice-reminders-schedule.mjs.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation-health/invoice-reminders-schedule.structural.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");
const PREVIOUS = read("supabase/migrations/20261002150020_owner_digest_schedule.sql");
const FORWARD = read("supabase/migrations/20261002162913_invoice_reminders_schedule.sql");
const ROLLBACK = read("supabase/pending/invoice_reminders_schedule_rollback.sql");
const sqlCode = (sql: string) => sql.replace(/--.*$/gm, "");
const helper = (sql: string) => sql.slice(sql.indexOf("create or replace function public.invoke_trackpr_scheduled"), sql.indexOf("revoke all on function public.invoke_trackpr_scheduled(text) from service_role;"));

test("the helper is the Phase 3G-1 helper with exactly one change - '/api/automation/invoice-reminders' added; the rollback restores the 3G-1 helper byte-for-byte", () => {
  const expected = helper(PREVIOUS).replace("    '/api/automation/owner-digest'\n", "    '/api/automation/owner-digest',\n    '/api/automation/invoice-reminders'\n");
  assert.notEqual(expected, helper(PREVIOUS));
  assert.equal(helper(FORWARD), expected);
  assert.equal(helper(ROLLBACK), helper(PREVIOUS));
});

test("owner, revoked grants, no SECURITY DEFINER, no literal secret/URL/token - forward and rollback", () => {
  for (const sql of [FORWARD, ROLLBACK]) {
    const code = sqlCode(sql);
    assert.ok(sql.includes("alter function public.invoke_trackpr_scheduled(text) owner to postgres;"));
    for (const role of ["public", "anon", "authenticated", "service_role"]) assert.ok(sql.includes(`revoke all on function public.invoke_trackpr_scheduled(text) from ${role};`), role);
    assert.doesNotMatch(code, /grant\s+(all|execute)|security definer/i);
    assert.deepEqual(code.match(/https?:\/\/[^\s'"]*/g) ?? [], ["https://[A-Za-z0-9.-]+(:[0-9]+)?$"]);
    assert.doesNotMatch(code, /Bearer [A-Za-z0-9]|eyJ[A-Za-z0-9_-]{10,}|vercel\.app|supabase\.co|vault\.create_secret|vault\.update_secret/i);
  }
});

test("schedules only trackpr_invoice_reminders at 9,24,39,54 with the standard guards; never touches other jobs or the cleanup job", () => {
  const code = sqlCode(FORWARD);
  assert.ok(code.includes("v_name constant text := 'trackpr_invoice_reminders';"));
  assert.ok(code.includes("v_schedule constant text := '9,24,39,54 * * * *';"));
  assert.ok(code.includes("v_path constant text := '/api/automation/invoice-reminders';"));
  assert.equal((code.match(/cron\.schedule\(/g) ?? []).length, 1);
  assert.match(code, /j\.username <> current_user/);
  assert.match(code, /expected exactly one job named/);
  assert.match(code, /to_regnamespace\('cron'\) is null/);
  assert.match(code, /s\.name in \('trackpr_base_url', 'trackpr_cron_secret'\)\) < 2/);
  for (const sql of [FORWARD, ROLLBACK]) {
    assert.ok(!sqlCode(sql).includes("trackpr_cron_history_cleanup"));
    assert.ok(!sqlCode(sql).includes("trackpr_owner_digest"), "the owner-digest job is not touched");
    assert.doesNotMatch(sqlCode(sql), /cron\.alter_job|update cron\.job/i);
  }
  assert.ok(PREVIOUS.includes("'8,23,38,53 * * * *'") && !code.includes("'8,23,38,53 * * * *'"), "minute 8 belongs to owner-digest");
  assert.match(sqlCode(ROLLBACK), /perform cron\.unschedule\('trackpr_invoice_reminders'\);/);
  assert.match(ROLLBACK, /Revert\/redeploy the application code first/);
});

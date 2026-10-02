/**
 * Phase 3G-1: static checks on the owner-digest scheduler migration
 * (supabase/migrations/20261002150020_owner_digest_schedule.sql and its
 * rollback in supabase/pending/) and the
 * notify_on_owner_digest setting migration. The SQL's runtime behavior is
 * exercised against PGlite by
 * supabase/pending/scratch/validate-owner-digest-schedule.mjs.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation-health/owner-digest-schedule.structural.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");
const PHASE_3D = read("supabase/migrations/20261002102849_scheduler_version_control.sql");
const FORWARD = read("supabase/migrations/20261002150020_owner_digest_schedule.sql");
const ROLLBACK = read("supabase/pending/owner_digest_schedule_rollback.sql");
const SETTING = read("supabase/migrations/20261002143550_owner_digest_notification_setting.sql");
const SETTING_ROLLBACK = read("supabase/pending/owner_digest_notification_setting_rollback.sql");
const sqlCode = (sql: string) => sql.replace(/--.*$/gm, "");
const helper = (sql: string) => sql.slice(sql.indexOf("create or replace function public.invoke_trackpr_scheduled"), sql.indexOf("revoke all on function public.invoke_trackpr_scheduled(text) from service_role;"));

test("the helper is the Phase 3D helper with exactly one change - '/api/automation/owner-digest' added to the allowlist; the rollback restores the 3D helper byte-for-byte", () => {
  const expected = helper(PHASE_3D).replace("    '/api/automation/opportunity-sync'\n", "    '/api/automation/opportunity-sync',\n    '/api/automation/owner-digest'\n");
  assert.notEqual(expected, helper(PHASE_3D));
  assert.equal(helper(FORWARD), expected);
  assert.equal(helper(ROLLBACK), helper(PHASE_3D));
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

test("schedules only trackpr_owner_digest at 8,23,38,53 with the standard guards; never touches existing jobs or the cleanup job", () => {
  const code = sqlCode(FORWARD);
  assert.ok(code.includes("v_name constant text := 'trackpr_owner_digest';"));
  assert.ok(code.includes("v_schedule constant text := '8,23,38,53 * * * *';"));
  assert.ok(code.includes("v_path constant text := '/api/automation/owner-digest';"));
  assert.match(code, /perform cron\.schedule\(v_name, v_schedule, pg_catalog\.format\('select public\.invoke_trackpr_scheduled\(%L\)', v_path\)\);/);
  assert.equal((code.match(/cron\.schedule\(/g) ?? []).length, 1, "one job only");
  assert.match(code, /j\.username <> current_user/);
  assert.match(code, /expected exactly one job named/);
  assert.match(code, /to_regnamespace\('cron'\) is null/);
  assert.match(code, /s\.name in \('trackpr_base_url', 'trackpr_cron_secret'\)\) < 2/);
  for (const sql of [FORWARD, ROLLBACK]) {
    assert.ok(!sqlCode(sql).includes("trackpr_cron_history_cleanup"));
    assert.doesNotMatch(sqlCode(sql), /cron\.alter_job|update cron\.job/i);
  }
  for (const minute of ["0,15,30,45", "1,16,31,46", "2,17,32,47", "3,18,33,48", "4,19,34,49", "5,20,35,50", "6,21,36,51", "7,22,37,52"]) {
    assert.ok(PHASE_3D.includes(`'${minute} * * * *'`) && !code.includes(`'${minute} * * * *'`), `minute slot ${minute} belongs to an existing job`);
  }
  assert.match(sqlCode(ROLLBACK), /perform cron\.unschedule\('trackpr_owner_digest'\);/);
  assert.match(ROLLBACK, /Revert\/redeploy the application code first/);
});

test("the setting migration adds one boolean column, NOT NULL default true, idempotently; its rollback drops only that column", () => {
  assert.match(sqlCode(SETTING), /alter table public\.notification_settings\s+add column if not exists notify_on_owner_digest boolean not null default true;/);
  assert.doesNotMatch(sqlCode(SETTING), /create policy|drop policy|grant |revoke |create table|drop table/i);
  assert.match(sqlCode(SETTING_ROLLBACK), /alter table public\.notification_settings\s+drop column if exists notify_on_owner_digest;/);
  assert.equal((sqlCode(SETTING_ROLLBACK).match(/drop column/g) ?? []).length, 1);
});

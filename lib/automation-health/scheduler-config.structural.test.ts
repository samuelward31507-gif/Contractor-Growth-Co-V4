/**
 * Phase 3D: static checks on the version-controlled scheduler
 * (supabase/pending/scheduler_version_control.sql and its rollback),
 * vercel.json and the scheduled-automation liveness catalog. The SQL's
 * runtime behavior is exercised separately against PGlite by
 * supabase/pending/scratch/validate-scheduler-version-control.mjs.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation-health/scheduler-config.structural.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");
const FORWARD = read("supabase/pending/scheduler_version_control.sql");
const ROLLBACK = read("supabase/pending/scheduler_version_control_rollback.sql");
const sqlCode = (sql: string) => sql.replace(/--.*$/gm, "");
const { SCHEDULED_AUTOMATION_IDS, SCHEDULED_AUTOMATION_STALE_THRESHOLD_MS }: typeof import("./scheduled-automation-liveness") = require(path.join(ROOT, "lib/automation-health/scheduled-automation-liveness.ts"));

const EXISTING_JOBS: [string, string, string][] = [
  ["trackpr_appointment_reminders", "0,15,30,45 * * * *", "/api/automation/appointment-reminders"],
  ["trackpr_estimate_followups", "1,16,31,46 * * * *", "/api/automation/estimate-followups"],
  ["trackpr_lead_nurture", "2,17,32,47 * * * *", "/api/automation/lead-nurture"],
  ["trackpr_lead_reactivation", "3,18,33,48 * * * *", "/api/automation/lead-reactivation"],
  ["trackpr_customer_reactivation", "4,19,34,49 * * * *", "/api/automation/customer-reactivation"],
  ["trackpr_no_show_detection", "5,20,35,50 * * * *", "/api/automation/no-show-detection"],
  ["trackpr_automation_health", "6,21,36,51 * * * *", "/api/automation/health"],
];
const functionBody = (sql: string) => sql.slice(sql.indexOf("as $function$"), sql.indexOf("$function$;"));

test("the helper's allowlist is the seven existing routes plus opportunity-sync - and that is the ONLY change from the captured production body", () => {
  const forward = functionBody(FORWARD);
  for (const [, , route] of EXISTING_JOBS) assert.ok(forward.includes(`'${route}'`), route);
  assert.ok(forward.includes("'/api/automation/opportunity-sync'"));
  // The rollback carries the exact pre-Phase-3D production body.
  const original = functionBody(ROLLBACK);
  assert.ok(!original.includes("opportunity-sync"));
  assert.equal(forward, original.replace("    '/api/automation/health'\n", "    '/api/automation/health',\n    '/api/automation/opportunity-sync'\n"));
});

test("the helper keeps its production contract: plpgsql, search_path '', invoker (no SECURITY DEFINER), Vault names, https-origin check, GET, Bearer header, 300000 ms timeout, no retry", () => {
  const header = FORWARD.slice(FORWARD.indexOf("create or replace function public.invoke_trackpr_scheduled"), FORWARD.indexOf("as $function$"));
  assert.match(header, /returns bigint\s+language plpgsql\s+set search_path to ''/);
  assert.doesNotMatch(sqlCode(FORWARD), /security definer/i);
  const body = functionBody(FORWARD);
  assert.match(body, /from vault\.decrypted_secrets ds\s+where ds\.name = 'trackpr_base_url'/);
  assert.match(body, /from vault\.decrypted_secrets ds\s+where ds\.name = 'trackpr_cron_secret'/);
  assert.ok(body.includes("if v_base_url !~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?$' then"));
  assert.match(body, /return net\.http_get\(\s+url := v_base_url \|\| p_path,\s+headers := pg_catalog\.jsonb_build_object\('Authorization', 'Bearer ' \|\| v_cron_secret\),\s+timeout_milliseconds := 300000\s+\);/);
  assert.doesNotMatch(body, /\bloop\b|retry|net\.http_post/i);
});

test("no literal secret, token or URL anywhere in the migration or rollback", () => {
  for (const [name, sql] of [["forward", FORWARD], ["rollback", ROLLBACK]] as const) {
    const code = sqlCode(sql);
    const urls = code.match(/https?:\/\/[^\s'"]*/g) ?? [];
    assert.deepEqual(urls, ["https://[A-Za-z0-9.-]+(:[0-9]+)?$"], `${name}: the only URL text is the https-origin pattern`);
    assert.doesNotMatch(code, /Bearer [A-Za-z0-9]/, `${name}: Bearer is only ever concatenated with the Vault value`);
    assert.doesNotMatch(code, /eyJ[A-Za-z0-9_-]{10,}|sk_(live|test)_|vercel\.app|supabase\.co/, `${name}: no keys, tokens or hosts`);
    assert.doesNotMatch(code, /vault\.create_secret|vault\.update_secret|insert into vault/i, `${name}: never writes Vault`);
  }
});

test("the seven existing jobs are re-declared with their exact names, schedules and commands; opportunity sync is added at 7,22,37,52", () => {
  const code = sqlCode(FORWARD);
  for (const [name, schedule, route] of EXISTING_JOBS) {
    assert.ok(code.includes(`['${name}', '${schedule}', '${route}']`), name);
  }
  assert.ok(code.includes("['trackpr_opportunity_sync', '7,22,37,52 * * * *', '/api/automation/opportunity-sync']"));
  assert.match(code, /perform cron\.schedule\(\s+v_jobs\[v_i\]\[1\],\s+v_jobs\[v_i\]\[2\],\s+pg_catalog\.format\('select public\.invoke_trackpr_scheduled\(%L\)', v_jobs\[v_i\]\[3\]\)\s+\);/);
  assert.match(code, /j\.username <> current_user/, "refuses a same-named job owned by another role");
  assert.match(code, /expected exactly one job named/, "verifies no duplicate per name");
  assert.match(code, /to_regnamespace\('cron'\) is null/);
  assert.match(code, /s\.name in \('trackpr_base_url', 'trackpr_cron_secret'\)\) < 2/, "no jobs without both Vault secrets (TEST)");
});

test("trackpr_cron_history_cleanup is never activated, scheduled or altered - by the migration, its rollback or application code", () => {
  for (const sql of [FORWARD, ROLLBACK]) {
    const code = sqlCode(sql);
    assert.ok(!code.includes("trackpr_cron_history_cleanup"));
    assert.doesNotMatch(code, /cron\.alter_job|update cron\.job/i);
  }
  const walk = (dir: string): string[] =>
    fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(rel);
      return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [rel] : [];
    });
  const appFiles = [...walk("app"), ...walk("lib")];
  for (const file of appFiles) assert.doesNotMatch(read(file), /cron_history_cleanup|cron\.alter_job|cron\.schedule|cron\.unschedule/, file);
});

test("function grants stay restricted: owner postgres, EXECUTE revoked from public, anon, authenticated and service_role (forward and rollback)", () => {
  for (const sql of [FORWARD, ROLLBACK]) {
    assert.ok(sql.includes("alter function public.invoke_trackpr_scheduled(text) owner to postgres;"));
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      assert.ok(sql.includes(`revoke all on function public.invoke_trackpr_scheduled(text) from ${role};`), role);
    }
    assert.doesNotMatch(sqlCode(sql), /grant\s+(all|execute)/i);
  }
});

test("vercel.json holds exactly one cron - the daily scheduler watchdog - and no business automation entry", () => {
  const config = JSON.parse(read("vercel.json")) as { crons?: { path: string; schedule: string }[] };
  assert.deepEqual(Object.keys(config), ["crons"]);
  assert.equal(config.crons?.length, 1);
  const [cron] = config.crons!;
  assert.equal(cron.path, "/api/automation/scheduler-watchdog");
  assert.match(cron.schedule, /^\d{1,2} \d{1,2} \* \* \*$/, "once a day (the Hobby plan's limit)");
});

test("liveness: opportunity-sync is a scheduled automation; the 45-minute stale threshold is unchanged", () => {
  assert.deepEqual([...SCHEDULED_AUTOMATION_IDS], ["appointment-reminders", "estimate-followup", "lost-lead-nurture", "lead-reactivation", "customer-reactivation", "no-show-detection", "opportunity-sync"]);
  assert.equal(SCHEDULED_AUTOMATION_STALE_THRESHOLD_MS, 45 * 60 * 1000);
});

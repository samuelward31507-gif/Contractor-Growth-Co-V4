// Validates supabase/pending/scheduler_version_control.sql and its rollback
// against an in-memory Postgres (PGlite), with minimal stand-ins for the
// three Supabase schemas it touches: cron (pg_cron's job table, plus
// schedule/unschedule matching pg_cron's per-user name semantics), vault
// (secrets + decrypted_secrets) and net (http_get, recorded instead of sent).
// Uses dummy values only - no real secret, URL or Supabase project.
//
// Run with:
//   node supabase/pending/scratch/validate-scheduler-version-control.mjs
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const forward = fs.readFileSync(path.join(here, "..", "scheduler_version_control.sql"), "utf8");
const rollback = fs.readFileSync(path.join(here, "..", "scheduler_version_control_rollback.sql"), "utf8");

const ROLES = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
    if not exists (select 1 from pg_roles where rolname = 'other_owner') then create role other_owner; end if;
  end $$;`;

const CRON = `
  create schema cron;
  create table cron.job (
    jobid bigserial primary key, jobname text, schedule text not null, command text not null,
    username text not null default current_user, active boolean not null default true
  );
  create function cron.schedule(job_name text, schedule text, command text) returns bigint language plpgsql as $$
  declare v_id bigint;
  begin
    update cron.job set schedule = $2, command = $3 where jobname = job_name and username = current_user returning jobid into v_id;
    if v_id is null then insert into cron.job (jobname, schedule, command) values (job_name, $2, $3) returning jobid into v_id; end if;
    return v_id;
  end $$;
  create function cron.unschedule(job_name text) returns boolean language plpgsql as $$
  begin delete from cron.job where jobname = job_name and username = current_user; return found; end $$;`;

const VAULT = (withSecrets) => `
  create schema vault;
  create table vault.secrets (name text primary key, secret text not null);
  create view vault.decrypted_secrets as select name, secret as decrypted_secret from vault.secrets;
  ${withSecrets ? "insert into vault.secrets values ('trackpr_base_url', 'https://example.test/'), ('trackpr_cron_secret', 'dummy-not-a-secret');" : ""}`;

const NET = `
  create schema net;
  create table net.calls (id bigserial primary key, url text, headers jsonb, timeout_milliseconds int);
  create function net.http_get(url text, headers jsonb, timeout_milliseconds int) returns bigint language sql as $$
    insert into net.calls (url, headers, timeout_milliseconds) values ($1, $2, $3) returning id $$;`;

const EXISTING_JOBS = [
  ["trackpr_appointment_reminders", "0,15,30,45 * * * *", "/api/automation/appointment-reminders"],
  ["trackpr_estimate_followups", "1,16,31,46 * * * *", "/api/automation/estimate-followups"],
  ["trackpr_lead_nurture", "2,17,32,47 * * * *", "/api/automation/lead-nurture"],
  ["trackpr_lead_reactivation", "3,18,33,48 * * * *", "/api/automation/lead-reactivation"],
  ["trackpr_customer_reactivation", "4,19,34,49 * * * *", "/api/automation/customer-reactivation"],
  ["trackpr_no_show_detection", "5,20,35,50 * * * *", "/api/automation/no-show-detection"],
  ["trackpr_automation_health", "6,21,36,51 * * * *", "/api/automation/health"],
];
const command = (p) => `select public.invoke_trackpr_scheduled('${p}')`;
const seedProductionJobs = (owner = null) =>
  EXISTING_JOBS.map(([n, s, p]) => `insert into cron.job (jobname, schedule, command${owner ? ", username" : ""}) values ('${n}', '${s}', $$${command(p)}$$${owner ? `, '${owner}'` : ""});`).join("\n") +
  "\ninsert into cron.job (jobname, schedule, command, active) values ('trackpr_cron_history_cleanup', '17 3 * * *', 'delete from cron.job_run_details where end_time < now() - interval ''7 days''', false);";

async function db(setup) {
  const pg = new PGlite();
  await pg.exec(ROLES);
  await pg.exec(setup);
  return pg;
}
const jobs = async (pg) => (await pg.query("select jobid, jobname, schedule, command, active from cron.job order by jobid")).rows;

// 1. No pg_cron, no Vault (a fresh project / TEST): the helper is created, no jobs, no error.
{
  const pg = await db(NET);
  await pg.exec(forward);
  const fn = await pg.query("select count(*)::int as n from pg_proc where proname = 'invoke_trackpr_scheduled'");
  assert.equal(fn.rows[0].n, 1);
  console.log("ok 1 - without pg_cron: helper created, job section skipped");
}

// 2. pg_cron present but Vault secrets missing: no jobs.
{
  const pg = await db(CRON + VAULT(false) + NET);
  await pg.exec(forward);
  assert.equal((await jobs(pg)).length, 0);
  console.log("ok 2 - without Vault secrets: no jobs created");
}

// 3. Production-like: the seven jobs + inactive cleanup exist. Apply twice.
{
  const pg = await db(CRON + VAULT(true) + NET + seedProductionJobs());
  const before = await jobs(pg);
  await pg.exec(forward);
  await pg.exec(forward);
  const after = await jobs(pg);
  assert.equal(after.length, 9, "seven existing + cleanup + opportunity sync, nothing duplicated");
  for (const [name, schedule, p] of EXISTING_JOBS) {
    const was = before.find((j) => j.jobname === name);
    const now = after.filter((j) => j.jobname === name);
    assert.equal(now.length, 1, name);
    assert.deepEqual([now[0].jobid, now[0].schedule, now[0].command, now[0].active], [was.jobid, schedule, command(p), true], `${name} unchanged (same jobid)`);
  }
  const cleanup = after.find((j) => j.jobname === "trackpr_cron_history_cleanup");
  assert.deepEqual(cleanup, before.find((j) => j.jobname === "trackpr_cron_history_cleanup"), "cleanup job untouched and still inactive");
  const sync = after.filter((j) => j.jobname === "trackpr_opportunity_sync");
  assert.deepEqual([sync.length, sync[0].schedule, sync[0].command, sync[0].active], [1, "7,22,37,52 * * * *", command("/api/automation/opportunity-sync"), true]);
  console.log("ok 3 - existing jobs updated in place (same ids), opportunity sync added, cleanup untouched, idempotent");

  // Helper behavior: every allowlisted path, the exact URL/header/timeout; unknown paths rejected.
  for (const p of [...EXISTING_JOBS.map((j) => j[2]), "/api/automation/opportunity-sync"]) {
    await pg.query(`select public.invoke_trackpr_scheduled($1)`, [p]);
  }
  const calls = (await pg.query("select url, headers, timeout_milliseconds from net.calls order by id")).rows;
  assert.equal(calls.length, 8);
  assert.ok(calls.every((c) => c.url.startsWith("https://example.test/api/automation/") && c.timeout_milliseconds === 300000));
  assert.ok(calls.every((c) => c.headers.Authorization === "Bearer dummy-not-a-secret"), "trailing slash trimmed, Bearer header from Vault");
  await assert.rejects(pg.query(`select public.invoke_trackpr_scheduled('/api/automation/not-a-route')`), /unknown scheduler path/);
  await pg.exec("update vault.secrets set secret = 'http://insecure.test' where name = 'trackpr_base_url'");
  await assert.rejects(pg.query(`select public.invoke_trackpr_scheduled('/api/automation/health')`), /must be an https origin/);
  await pg.exec("delete from vault.secrets where name = 'trackpr_cron_secret'");
  await assert.rejects(pg.query(`select public.invoke_trackpr_scheduled('/api/automation/health')`), /trackpr_cron_secret is missing/);
  console.log("ok 4 - helper: 8 allowlisted paths, https-origin check, Vault-sourced Bearer header, 300000 ms timeout");

  // Grants: no EXECUTE for public roles.
  const grants = (await pg.query(`select
      has_function_privilege('anon', 'public.invoke_trackpr_scheduled(text)', 'EXECUTE') as anon,
      has_function_privilege('authenticated', 'public.invoke_trackpr_scheduled(text)', 'EXECUTE') as authenticated,
      has_function_privilege('service_role', 'public.invoke_trackpr_scheduled(text)', 'EXECUTE') as service_role`)).rows[0];
  assert.deepEqual(grants, { anon: false, authenticated: false, service_role: false });
  console.log("ok 5 - EXECUTE revoked from anon, authenticated and service_role");

  // Rollback: opportunity sync removed, seven jobs and cleanup intact, allowlist back to seven paths.
  await pg.exec("insert into vault.secrets values ('trackpr_cron_secret', 'dummy-not-a-secret') on conflict do nothing; update vault.secrets set secret = 'https://example.test' where name = 'trackpr_base_url'");
  await pg.exec(rollback);
  const rolledBack = await jobs(pg);
  assert.equal(rolledBack.length, 8);
  assert.ok(!rolledBack.some((j) => j.jobname === "trackpr_opportunity_sync"));
  await assert.rejects(pg.query(`select public.invoke_trackpr_scheduled('/api/automation/opportunity-sync')`), /unknown scheduler path/);
  await pg.query(`select public.invoke_trackpr_scheduled('/api/automation/health')`);
  const grantsAfter = (await pg.query(`select has_function_privilege('anon', 'public.invoke_trackpr_scheduled(text)', 'EXECUTE') as anon`)).rows[0];
  assert.equal(grantsAfter.anon, false);
  console.log("ok 6 - rollback: opportunity sync unscheduled, seven jobs + cleanup kept, allowlist restored, grants still revoked");
}

// 7. A same-named job owned by another role: refuse (a duplicate would be created), nothing changes.
{
  const pg = await db(CRON + VAULT(true) + NET + seedProductionJobs("other_owner"));
  const before = await jobs(pg);
  await assert.rejects(pg.exec(forward), /exists under a different role/);
  await pg.exec("rollback").catch(() => {});
  assert.deepEqual(await jobs(pg), before, "no job created or changed");
  console.log("ok 7 - refuses when an existing job belongs to a different role; nothing changed");
}

console.log("scheduler_version_control: all checks passed");

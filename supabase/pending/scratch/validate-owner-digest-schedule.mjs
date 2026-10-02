// Validates supabase/pending/owner_digest_schedule.sql and its rollback,
// applied on top of the Phase 3D scheduler
// (supabase/migrations/20261002102849_scheduler_version_control.sql)
// against an in-memory Postgres (PGlite), with minimal stand-ins for the
// three Supabase schemas it touches: cron (pg_cron's job table, plus
// schedule/unschedule matching pg_cron's per-user name semantics), vault
// (secrets + decrypted_secrets) and net (http_get, recorded instead of sent).
// Uses dummy values only - no real secret, URL or Supabase project.
//
// Run with:
//   node supabase/pending/scratch/validate-owner-digest-schedule.mjs
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const phase3d = fs.readFileSync(path.join(here, "..", "..", "migrations", "20261002102849_scheduler_version_control.sql"), "utf8");
const forward = fs.readFileSync(path.join(here, "..", "owner_digest_schedule.sql"), "utf8");
const rollback = fs.readFileSync(path.join(here, "..", "owner_digest_schedule_rollback.sql"), "utf8");

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

const helperBody = async (pg) => (await pg.query("select prosrc from pg_proc where proname = 'invoke_trackpr_scheduled'")).rows[0].prosrc;
const PATHS_3D = [...EXISTING_JOBS.map((j) => j[2]), "/api/automation/opportunity-sync"];

// 1. No pg_cron, no Vault (TEST, a fresh project): the helper is re-created, no job, no error.
{
  const pg = await db(NET);
  await pg.exec(phase3d);
  await pg.exec(forward);
  assert.match(await helperBody(pg), /'\/api\/automation\/owner-digest'/);
  console.log("ok 1 - without pg_cron: helper re-created with owner-digest, job section skipped");
}

// 2. pg_cron present but Vault secrets missing: no job.
{
  const pg = await db(CRON + VAULT(false) + NET);
  await pg.exec(phase3d);
  await pg.exec(forward);
  assert.equal((await jobs(pg)).length, 0);
  console.log("ok 2 - without Vault secrets: no job created");
}

// 3. Production-like (3D applied, 8 jobs + inactive cleanup). Apply twice.
{
  const pg = await db(CRON + VAULT(true) + NET + seedProductionJobs());
  await pg.exec(phase3d);
  const before = await jobs(pg);
  await pg.exec(forward);
  await pg.exec(forward);
  const after = await jobs(pg);
  assert.equal(after.length, before.length + 1, "exactly one new job, nothing duplicated");
  for (const job of before) assert.deepEqual(after.find((j) => j.jobid === job.jobid), job, `${job.jobname} untouched`);
  const digest = after.filter((j) => j.jobname === "trackpr_owner_digest");
  assert.deepEqual([digest.length, digest[0].schedule, digest[0].command, digest[0].active], [1, "8,23,38,53 * * * *", command("/api/automation/owner-digest"), true]);
  assert.equal(after.find((j) => j.jobname === "trackpr_cron_history_cleanup").active, false, "cleanup stays inactive");
  console.log("ok 3 - owner-digest job added once at 8,23,38,53; existing jobs and cleanup untouched; idempotent");

  // Helper: all nine paths reach net.http_get with the Vault-built header; unknown paths rejected.
  for (const p of [...PATHS_3D, "/api/automation/owner-digest"]) await pg.query("select public.invoke_trackpr_scheduled($1)", [p]);
  const calls = (await pg.query("select url, headers, timeout_milliseconds from net.calls order by id")).rows;
  assert.equal(calls.length, 9);
  assert.ok(calls.every((c) => c.url.startsWith("https://example.test/api/automation/") && c.timeout_milliseconds === 300000 && c.headers.Authorization === "Bearer dummy-not-a-secret"));
  await assert.rejects(pg.query("select public.invoke_trackpr_scheduled('/api/automation/not-a-route')"), /unknown scheduler path/);
  console.log("ok 4 - helper: 9 allowlisted paths, https origin, Vault-sourced Bearer header, 300000 ms timeout");

  const grants = (await pg.query(`select
      has_function_privilege('anon', 'public.invoke_trackpr_scheduled(text)', 'EXECUTE') as anon,
      has_function_privilege('authenticated', 'public.invoke_trackpr_scheduled(text)', 'EXECUTE') as authenticated,
      has_function_privilege('service_role', 'public.invoke_trackpr_scheduled(text)', 'EXECUTE') as service_role`)).rows[0];
  assert.deepEqual(grants, { anon: false, authenticated: false, service_role: false });
  console.log("ok 5 - EXECUTE still revoked from anon, authenticated and service_role");

  // Rollback: job removed, helper back to the exact 3D body.
  const body3d = await (async () => {
    const ref = await db(NET);
    await ref.exec(phase3d);
    return helperBody(ref);
  })();
  await pg.exec(rollback);
  const rolledBack = await jobs(pg);
  assert.deepEqual(rolledBack, before, "back to the pre-3G-1 jobs exactly");
  assert.equal(await helperBody(pg), body3d, "helper body identical to Phase 3D");
  await assert.rejects(pg.query("select public.invoke_trackpr_scheduled('/api/automation/owner-digest')"), /unknown scheduler path/);
  console.log("ok 6 - rollback: owner-digest unscheduled, helper restored to the exact 3D body, other jobs untouched");
}

// 7. A same-named job owned by another role: refuse, nothing changes.
{
  const pg = await db(CRON + VAULT(true) + NET + seedProductionJobs());
  await pg.exec(phase3d);
  await pg.exec("insert into cron.job (jobname, schedule, command, username) values ('trackpr_owner_digest', '0 0 * * *', 'select 1', 'other_owner')");
  const before = await jobs(pg);
  await assert.rejects(pg.exec(forward), /exists under a different role/);
  await pg.exec("rollback").catch(() => {});
  assert.deepEqual(await jobs(pg), before);
  console.log("ok 7 - refuses when trackpr_owner_digest belongs to a different role; nothing changed");
}

console.log("owner_digest_schedule: all checks passed");

// Disposable validation for supabase/pending/agent_runs.sql and its rollback.
// Applies the forward script to an in-memory Postgres (PGlite) with the
// project's RLS helpers stubbed exactly as defined in production
// (is_org_member, is_agency_admin), then proves: agency admins who are
// members can insert and read their own organization's runs; plain members,
// other organizations, anon and impersonated created_by are refused; there is
// no UPDATE or DELETE path for authenticated; the CHECK constraints hold; the
// script is rerun-safe; the rollback removes everything. Never opens a
// network connection.
// Run: cd supabase/pending/scratch && npm install && node ./validate-agent-runs.mjs
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pending = path.resolve(here, "..");
const forward = readFileSync(path.join(pending, "agent_runs.sql"), "utf8");
const rollback = readFileSync(path.join(pending, "agent_runs_rollback.sql"), "utf8");

const db = new PGlite();
let passed = 0;
let failed = 0;
function check(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}: ${detail}`);
  }
}

async function as(role, uid, fn) {
  await db.query("select set_config('trackpr.test_uid', $1, false)", [uid ?? ""]);
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
    await db.query("select set_config('trackpr.test_uid', '', false)");
  }
}

async function attempt(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";
const ADMIN = "00000000-0000-4000-8000-0000000000a1"; // agency admin, member of A
const MEMBER = "00000000-0000-4000-8000-0000000000a2"; // plain member of A, not an agency admin
const OTHER_ADMIN = "00000000-0000-4000-8000-0000000000b1"; // agency admin, member of B only

const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('trackpr.test_uid', true), '')::uuid
$$;
create table public.organizations (id uuid primary key, name text not null);
create table public.organization_members (organization_id uuid, user_id uuid, role text);
create table public.agency_admins (user_id uuid primary key);
create or replace function public.is_org_member(target_org_id uuid) returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from public.organization_members where organization_id = target_org_id and user_id = auth.uid())
$$;
create or replace function public.is_agency_admin() returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from public.agency_admins where user_id = auth.uid())
$$;
grant usage on schema public, auth to anon, authenticated, service_role;
grant execute on function auth.uid(), public.is_org_member(uuid), public.is_agency_admin() to anon, authenticated, service_role;
-- Supabase's default privileges grant every table privilege to all three roles on each new table.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
insert into public.organizations values ('${ORG_A}', 'A'), ('${ORG_B}', 'B');
insert into public.organization_members values ('${ORG_A}', '${ADMIN}', 'owner'), ('${ORG_A}', '${MEMBER}', 'member'), ('${ORG_B}', '${OTHER_ADMIN}', 'owner');
insert into public.agency_admins values ('${ADMIN}'), ('${OTHER_ADMIN}');
`;

let runCounter = 0;
function insertSql(org, { createdBy = null, agent = "sales", status = "ok", priority = "high", confidence = "high", summary = "Summary." } = {}) {
  runCounter += 1;
  const runId = `00000000-0000-4000-9000-${String(runCounter).padStart(12, "0")}`;
  const createdByColumn = createdBy ? ", created_by" : "";
  const createdByValue = createdBy ? `, '${createdBy}'` : "";
  return `insert into public.agent_runs (organization_id, trace_id, run_id, agent_id, status, summary, priority, confidence, started_at, finished_at, duration_ms${createdByColumn})
          values ('${org}', '00000000-0000-4000-8000-0000000000ff', '${runId}', '${agent}', '${status}', '${summary}', '${priority}', '${confidence}', now(), now(), 5${createdByValue})`;
}

async function main() {
  await db.exec(STUBS);

  console.log("forward script");
  await db.exec(forward);
  check("table exists", (await db.query("select to_regclass('public.agent_runs') t")).rows[0].t !== null);
  const rerun = await attempt(() => db.exec(forward));
  check("forward script is rerun-safe", rerun.ok, rerun.error);

  const policies = (await db.query("select policyname, cmd from pg_policies where tablename = 'agent_runs' order by policyname")).rows;
  check("exactly two policies: select and insert", JSON.stringify(policies) === JSON.stringify([{ policyname: "agent_runs_insert", cmd: "INSERT" }, { policyname: "agent_runs_select", cmd: "SELECT" }]), JSON.stringify(policies));
  check("RLS enabled", (await db.query("select relrowsecurity r from pg_class where oid = 'public.agent_runs'::regclass")).rows[0].r === true);

  console.log("privileges");
  const priv = async (role, p) => (await db.query("select has_table_privilege($1, 'public.agent_runs', $2) ok", [role, p])).rows[0].ok;
  for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"]) check(`anon has no ${p}`, !(await priv("anon", p)));
  check("authenticated has SELECT", await priv("authenticated", "SELECT"));
  check("authenticated has INSERT", await priv("authenticated", "INSERT"));
  for (const p of ["UPDATE", "DELETE", "TRUNCATE"]) check(`authenticated has no ${p}`, !(await priv("authenticated", p)));
  check("service_role keeps SELECT", await priv("service_role", "SELECT"));

  console.log("row-level security");
  const adminInsert = await attempt(() => as("authenticated", ADMIN, () => db.exec(insertSql(ORG_A))));
  check("agency admin member inserts for own organization (created_by defaults to auth.uid())", adminInsert.ok, adminInsert.error);
  const createdBy = (await db.query("select created_by from public.agent_runs limit 1")).rows[0]?.created_by;
  check("created_by recorded as the inserting user", createdBy === ADMIN, createdBy);

  const memberInsert = await attempt(() => as("authenticated", MEMBER, () => db.exec(insertSql(ORG_A))));
  check("plain organization member (not an agency admin) cannot insert", !memberInsert.ok);
  const crossInsert = await attempt(() => as("authenticated", OTHER_ADMIN, () => db.exec(insertSql(ORG_A))));
  check("agency admin cannot insert into an organization they are not a member of", !crossInsert.ok);
  const spoofInsert = await attempt(() => as("authenticated", ADMIN, () => db.exec(insertSql(ORG_A, { createdBy: OTHER_ADMIN }))));
  check("created_by cannot be set to someone else", !spoofInsert.ok);
  const anonInsert = await attempt(() => as("anon", null, () => db.exec(insertSql(ORG_A))));
  check("anon cannot insert", !anonInsert.ok);

  const read = async (role, uid) => (await as(role, uid, () => db.query("select count(*)::int n from public.agent_runs"))).rows[0].n;
  check("agency admin member reads own organization's runs", (await read("authenticated", ADMIN)) === 1);
  check("plain member reads nothing", (await read("authenticated", MEMBER)) === 0);
  check("other organization's agency admin reads nothing", (await read("authenticated", OTHER_ADMIN)) === 0);
  const anonRead = await attempt(() => read("anon", null));
  check("anon cannot read", !anonRead.ok || anonRead.value === 0);

  const update = await attempt(() => as("authenticated", ADMIN, () => db.exec("update public.agent_runs set summary = 'changed'")));
  check("authenticated cannot update (append-only)", !update.ok);
  const del = await attempt(() => as("authenticated", ADMIN, () => db.exec("delete from public.agent_runs")));
  check("authenticated cannot delete (append-only)", !del.ok);
  check("row unchanged", (await db.query("select summary from public.agent_runs")).rows[0].summary === "Summary.");

  console.log("constraints");
  for (const [label, overrides] of [
    ["unknown agent rejected", { agent: "rogue_agent" }],
    ["unknown status rejected", { status: "autonomous" }],
    ["unknown priority rejected", { priority: "urgent" }],
    ["unknown confidence rejected", { confidence: "certain" }],
    ["empty summary rejected", { summary: "" }],
  ]) {
    const result = await attempt(() => db.exec(insertSql(ORG_A, { createdBy: ADMIN, ...overrides })));
    check(label, !result.ok);
  }
  const dupRun = await attempt(() => db.exec(`insert into public.agent_runs select gen_random_uuid(), organization_id, trace_id, run_id, agent_id, status, summary, priority, confidence, requires_approval, finding_count, result, error, started_at, finished_at, duration_ms, created_by, created_at from public.agent_runs limit 1`));
  check("run_id is unique", !dupRun.ok);
  await db.exec("delete from public.organizations where id = '" + ORG_A + "'");
  check("organization delete cascades to its runs", (await db.query("select count(*)::int n from public.agent_runs")).rows[0].n === 0);

  console.log("rollback");
  await db.exec(rollback);
  check("table dropped", (await db.query("select to_regclass('public.agent_runs') t")).rows[0].t === null);
  const rollbackRerun = await attempt(() => db.exec(rollback));
  check("rollback is rerun-safe", rollbackRerun.ok, rollbackRerun.error);
  const reapply = await attempt(() => db.exec(forward));
  check("forward script applies again after rollback", reapply.ok, reapply.error);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

// Disposable validation harness for
// supabase/migrations/20260930025936_opportunity_sync_state.sql
// (Performance Pass 2, opportunity sync throttling; applied to the test
// project as ledger version 20260930025545 and to production as
// 20260930025936; kept runnable so the rules and the rollback stay provable).
//
// Boots an in-memory Postgres (PGlite) with stand-ins for the production
// objects the migration touches - the anon/authenticated/service_role roles,
// auth.uid() driven by a session setting, organizations with the live
// payment_status CHECK, organization_members, and the two live helpers
// is_org_member / organization_payment_active with their production
// definitions (SECURITY DEFINER, search_path=public) - plus the project's
// default privileges (pg_default_acl grants ALL on new tables and EXECUTE on
// new functions to anon/authenticated/service_role), so the migration's
// revokes are really exercised. Then:
//
//   1. applies the forward script and checks the object inventory
//   2. applies it AGAIN and proves the inventory is unchanged (idempotent)
//   3. owner/admin/member of an active organization: first claim wins, a
//      second claim inside the cooldown loses, a claim after >5 minutes wins
//   4. every ineligible caller gets false and writes nothing: non-member,
//      payment_required/suspended/cancelled, null organization, nonexistent
//      organization, no auth.uid()
//   5. a cross-organization claim loses and leaves the other row untouched
//   6. anon cannot execute; public holds no execute; authenticated can
//   7. direct table SELECT/INSERT/UPDATE/DELETE is denied to authenticated
//      and anon; the cooldown cannot be passed in
//   8. deleting an organization cascades its row
//   9. runs the rollback, proves both objects are gone, re-applies
//
// Concurrency is NOT testable here (PGlite is a single connection); the
// "N simultaneous claims -> exactly one true" proof lives in
// lib/opportunities/sync-claim.integration.test.ts against the test project.
//
// It never opens a network connection. Run: npm run validate:opportunity-sync-state
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pending = path.resolve(here, "..");
const migrations = path.join(pending, "..", "migrations");
const forward = readFileSync(path.join(migrations, "20260930025936_opportunity_sync_state.sql"), "utf8");
const rollback = readFileSync(path.join(pending, "opportunity_sync_state_rollback.sql"), "utf8");

const db = new PGlite();
let passed = 0;
let failed = 0;
const failures = [];

async function q(sql, params = []) {
  return (await db.query(sql, params)).rows;
}
async function one(sql, params = []) {
  return (await q(sql, params))[0];
}
function pass(label) {
  passed += 1;
  console.log(`  ok   ${label}`);
}
function fail(label, detail) {
  failed += 1;
  failures.push(`${label}: ${detail}`);
  console.log(`  FAIL ${label}: ${detail}`);
}
function check(label, condition, detail = "") {
  if (condition) pass(label);
  else fail(label, detail || "assertion false");
}

/** Runs `sql` as `role` with auth.uid() = `uid` (null = no user), always restoring the superuser session. */
async function asRole(role, uid, sql, params = []) {
  await q("select set_config('trackpr.test_uid', $1, false)", [uid ?? ""]);
  await db.exec(`set role ${role}`);
  try {
    return await q(sql, params);
  } finally {
    await db.exec("reset role");
    await q("select set_config('trackpr.test_uid', '', false)");
  }
}
async function claim(uid, organizationId) {
  const rows = await asRole("authenticated", uid, "select public.claim_opportunity_sync($1) as claimed", [organizationId]);
  return rows[0].claimed;
}
async function expectDenied(label, role, uid, sql, params = []) {
  try {
    await asRole(role, uid, sql, params);
    fail(label, "expected permission denied but the statement succeeded");
  } catch (error) {
    const message = String(error?.message ?? error);
    if (/permission denied/i.test(message)) pass(label);
    else fail(label, `wrong error: ${message}`);
  }
}
async function stateRow(organizationId) {
  return one("select organization_id, last_started_at from public.opportunity_sync_state where organization_id = $1", [organizationId]);
}
async function backdate(organizationId, interval) {
  await q(`update public.opportunity_sync_state set last_started_at = now() - $2::interval where organization_id = $1`, [organizationId, interval]);
}

const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
grant usage on schema public to anon, authenticated, service_role;
-- The project's default privileges, as read from production pg_default_acl.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('trackpr.test_uid', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  payment_status text not null default 'payment_required'
    check (payment_status = any (array['payment_required'::text, 'active'::text, 'suspended'::text, 'cancelled'::text]))
);
create table public.organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null,
  role text not null check (role = any (array['owner'::text, 'admin'::text, 'member'::text])),
  unique (organization_id, user_id)
);
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
-- Production definitions (md5-identical bodies on production and the test project).
create or replace function public.is_org_member(target_org_id uuid) returns boolean language sql stable security definer set search_path to 'public' as $$
 select exists ( select 1 from public.organization_members om where om.organization_id = target_org_id and om.user_id = auth.uid() );
$$;
create or replace function public.organization_payment_active(target_org_id uuid) returns boolean language sql stable security definer set search_path to 'public' as $$
 select exists ( select 1 from public.organizations o where o.id = target_org_id and o.payment_status = 'active' );
$$;
`;

const ORG = {
  active: "a0000000-0000-4000-8000-000000000001",
  other: "a0000000-0000-4000-8000-000000000002",
  paymentRequired: "a0000000-0000-4000-8000-000000000003",
  suspended: "a0000000-0000-4000-8000-000000000004",
  cancelled: "a0000000-0000-4000-8000-000000000005",
  nonexistent: "a0000000-0000-4000-8000-0000000000ff",
};
const USER = {
  owner: "b0000000-0000-4000-8000-000000000001",
  admin: "b0000000-0000-4000-8000-000000000002",
  member: "b0000000-0000-4000-8000-000000000003",
  otherOwner: "b0000000-0000-4000-8000-000000000004",
  unpaidOwner: "b0000000-0000-4000-8000-000000000005",
  suspendedOwner: "b0000000-0000-4000-8000-000000000006",
  cancelledOwner: "b0000000-0000-4000-8000-000000000007",
  outsider: "b0000000-0000-4000-8000-000000000008",
};

async function seed() {
  await q(
    `insert into public.organizations (id, name, payment_status) values
      ($1, 'Active Org', 'active'), ($2, 'Other Active Org', 'active'),
      ($3, 'Unpaid Org', 'payment_required'), ($4, 'Suspended Org', 'suspended'), ($5, 'Cancelled Org', 'cancelled')`,
    [ORG.active, ORG.other, ORG.paymentRequired, ORG.suspended, ORG.cancelled],
  );
  await q(
    `insert into public.organization_members (organization_id, user_id, role) values
      ($1, $6, 'owner'), ($1, $7, 'admin'), ($1, $8, 'member'),
      ($2, $9, 'owner'), ($3, $10, 'owner'), ($4, $11, 'owner'), ($5, $12, 'owner')`,
    [ORG.active, ORG.other, ORG.paymentRequired, ORG.suspended, ORG.cancelled, USER.owner, USER.admin, USER.member, USER.otherOwner, USER.unpaidOwner, USER.suspendedOwner, USER.cancelledOwner],
  );
}

async function inventory() {
  return {
    table: await one(
      `select c.relrowsecurity as rls, c.relforcerowsecurity as force_rls,
              (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'opportunity_sync_state') as policies,
              (select string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'opportunity_sync_state') as columns
         from pg_class c where c.oid = to_regclass('public.opportunity_sync_state')`,
    ),
    tableGrants: (await q(`select grantee, string_agg(privilege_type, ',' order by privilege_type) as privileges from information_schema.role_table_grants where table_schema = 'public' and table_name = 'opportunity_sync_state' group by grantee order by grantee`)).map((r) => `${r.grantee}=${r.privileges}`),
    fn: await one(
      `select p.prosecdef as security_definer, p.provolatile as volatility, p.pronargs as args, array_to_string(p.proconfig, ',') as config, md5(pg_get_functiondef(p.oid)) as body_md5,
              has_function_privilege('anon', p.oid, 'execute') as anon_exec,
              has_function_privilege('authenticated', p.oid, 'execute') as authenticated_exec,
              has_function_privilege('service_role', p.oid, 'execute') as service_role_exec,
              exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0) as public_exec
         from pg_proc p where p.oid = to_regprocedure('public.claim_opportunity_sync(uuid)')`,
    ),
  };
}

async function main() {
  await db.exec(STUBS);
  await seed();

  console.log("\n[1] apply forward migration");
  await db.exec(forward);
  const inv1 = await inventory();
  check("table exists with RLS enabled, not forced, and zero policies", inv1.table?.rls === true && inv1.table.force_rls === false && inv1.table.policies === 0, JSON.stringify(inv1.table));
  check("columns: organization_id uuid NOT NULL, last_started_at timestamptz NOT NULL", inv1.table?.columns === "organization_id:uuid:NO,last_started_at:timestamp with time zone:NO", inv1.table?.columns);
  check("anon and authenticated hold no table privileges (default privileges revoked); service_role keeps its default", !inv1.tableGrants.some((g) => /^(anon|authenticated|PUBLIC)=/.test(g)) && inv1.tableGrants.some((g) => g.startsWith("service_role=")), inv1.tableGrants.join(" "));
  check("function is SECURITY DEFINER, VOLATILE, one argument, search_path=public", inv1.fn?.security_definer === true && inv1.fn.volatility === "v" && inv1.fn.args === 1 && inv1.fn.config === "search_path=public", JSON.stringify(inv1.fn));
  check("execute: authenticated yes; anon no; PUBLIC no", inv1.fn?.authenticated_exec === true && inv1.fn.anon_exec === false && inv1.fn.public_exec === false, JSON.stringify(inv1.fn));
  const body = (await one("select pg_get_functiondef(to_regprocedure('public.claim_opportunity_sync(uuid)')) as def")).def;
  check("cooldown is the fixed literal interval '5 minutes' inside the function", /interval '5 minutes'/.test(body) && !/p_cooldown|p_interval/i.test(body));
  check("authorization uses the existing helpers (not a copied body) and requires auth.uid()", /public\.is_org_member\(p_organization_id\)/.test(body) && /public\.organization_payment_active\(p_organization_id\)/.test(body) && /auth\.uid\(\) is null/.test(body));

  console.log("\n[2] apply forward migration again (idempotent)");
  await db.exec(forward);
  const inv2 = await inventory();
  check("second apply leaves the inventory unchanged", JSON.stringify(inv2) === JSON.stringify(inv1), JSON.stringify(inv2));

  console.log("\n[3] owner/admin/member of an active organization");
  check("owner: first claim wins", (await claim(USER.owner, ORG.active)) === true);
  const firstRow = await stateRow(ORG.active);
  check("the winning claim wrote exactly one row for the organization", firstRow?.organization_id === ORG.active);
  check("owner: second claim inside the cooldown loses", (await claim(USER.owner, ORG.active)) === false);
  check("admin: claim inside the cooldown loses (the cooldown is per organization, not per user)", (await claim(USER.admin, ORG.active)) === false);
  check("member: claim inside the cooldown loses", (await claim(USER.member, ORG.active)) === false);
  check("a losing claim does not move last_started_at", String((await stateRow(ORG.active)).last_started_at) === String(firstRow.last_started_at));
  await backdate(ORG.active, "4 minutes 59 seconds");
  check("4m59s after the last claim: still inside the cooldown", (await claim(USER.member, ORG.active)) === false);
  await backdate(ORG.active, "5 minutes 1 second");
  check("5m01s after the last claim: member wins", (await claim(USER.member, ORG.active)) === true);
  check("the new claim reset the cooldown: admin loses immediately after", (await claim(USER.admin, ORG.active)) === false);
  await q("delete from public.opportunity_sync_state where organization_id = $1", [ORG.active]);
  check("admin can win a fresh claim", (await claim(USER.admin, ORG.active)) === true);
  await q("delete from public.opportunity_sync_state where organization_id = $1", [ORG.active]);
  check("member can win a fresh claim (any member role, exactly like the opportunities policies)", (await claim(USER.member, ORG.active)) === true);

  console.log("\n[4] ineligible callers get false and write nothing");
  const rowsBefore = (await one("select count(*)::int as n from public.opportunity_sync_state")).n;
  check("non-member of an active organization", (await claim(USER.outsider, ORG.active)) === false);
  check("payment_required organization (its own owner)", (await claim(USER.unpaidOwner, ORG.paymentRequired)) === false);
  check("suspended organization (its own owner)", (await claim(USER.suspendedOwner, ORG.suspended)) === false);
  check("cancelled organization (its own owner)", (await claim(USER.cancelledOwner, ORG.cancelled)) === false);
  check("null organization", (await claim(USER.owner, null)) === false);
  check("nonexistent organization (same answer as any ineligible one - no existence signal)", (await claim(USER.owner, ORG.nonexistent)) === false);
  check("no auth.uid() (authenticated role, no user) on an otherwise eligible organization", (await claim(null, ORG.other)) === false);
  check("none of those wrote a row", (await one("select count(*)::int as n from public.opportunity_sync_state")).n === rowsBefore);

  console.log("\n[5] cross-organization claim");
  check("the other organization's own owner wins its claim", (await claim(USER.otherOwner, ORG.other)) === true);
  await backdate(ORG.other, "10 minutes");
  const otherBefore = await stateRow(ORG.other);
  check("a member of a different organization cannot claim it, even once its cooldown has expired", (await claim(USER.owner, ORG.other)) === false);
  check("the other organization's row is untouched", String((await stateRow(ORG.other)).last_started_at) === String(otherBefore.last_started_at));
  check("its own owner can still claim it (not suppressed)", (await claim(USER.otherOwner, ORG.other)) === true);

  console.log("\n[6] execution privileges");
  await expectDenied("anon cannot execute claim_opportunity_sync", "anon", USER.owner, "select public.claim_opportunity_sync($1)", [ORG.active]);
  try {
    await asRole("authenticated", USER.owner, "select public.claim_opportunity_sync($1, interval '1 second')", [ORG.active]);
    fail("the cooldown cannot be passed in", "a two-argument call succeeded");
  } catch (error) {
    check("the cooldown cannot be passed in (no such signature)", /does not exist/i.test(String(error?.message ?? error)), String(error?.message ?? error));
  }

  console.log("\n[7] direct table access is denied");
  for (const role of ["authenticated", "anon"]) {
    await expectDenied(`${role}: SELECT`, role, USER.owner, "select * from public.opportunity_sync_state");
    await expectDenied(`${role}: INSERT`, role, USER.owner, "insert into public.opportunity_sync_state (organization_id, last_started_at) values ($1, now())", [ORG.cancelled]);
    await expectDenied(`${role}: UPDATE (e.g. to suppress a sync)`, role, USER.owner, "update public.opportunity_sync_state set last_started_at = now() + interval '1 year' where organization_id = $1", [ORG.other]);
    await expectDenied(`${role}: DELETE`, role, USER.owner, "delete from public.opportunity_sync_state where organization_id = $1", [ORG.other]);
  }

  console.log("\n[8] organization deletion cascades");
  check("the active organization has a row", Boolean(await stateRow(ORG.active)));
  await q("delete from public.organizations where id = $1", [ORG.active]);
  check("deleting the organization removed its row", !(await stateRow(ORG.active)));

  console.log("\n[9] rollback, then re-apply");
  await db.exec(rollback);
  const gone = await one("select to_regclass('public.opportunity_sync_state') as t, to_regprocedure('public.claim_opportunity_sync(uuid)') as f");
  check("rollback drops the table and the function", gone.t === null && gone.f === null, JSON.stringify(gone));
  check("the existing helpers are untouched by the rollback", Boolean((await one("select to_regprocedure('public.is_org_member(uuid)') as a, to_regprocedure('public.organization_payment_active(uuid)') as b")).b));
  await db.exec(rollback);
  pass("rollback is itself idempotent");
  await db.exec(forward);
  const inv3 = await inventory();
  check("re-apply after rollback restores the same inventory", JSON.stringify(inv3) === JSON.stringify(inv1), JSON.stringify(inv3));
  check("and works: the other organization's owner can claim", (await claim(USER.otherOwner, ORG.other)) === true);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(failures.map((f) => ` - ${f}`).join("\n"));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("HARNESS ERROR:", error);
  process.exit(2);
});

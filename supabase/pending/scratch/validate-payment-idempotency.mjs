// Disposable validation harness for
// supabase/pending/payment_idempotency_and_invoice_opportunities.sql.
//
// Boots an in-memory Postgres (PGlite), recreates the production starting
// state for the objects involved (the same stand-ins validate.mjs uses, plus
// a faithful opportunities table with the live opportunities_type_check,
// dedup index, member policies and payment gate; then the already-applied
// invoice_foundation and invoice_foundation_grants migrations), then:
//
//   1. applies the forward script
//   2. applies it AGAIN and proves the object inventory is unchanged
//   3. exercises every rule: client_key uniqueness per organization, null
//      keys, key shape, append-only preserved, RLS + grants + payment gate
//      unchanged, the two new opportunity types, unknown types still
//      rejected, opportunity dedup + payment gate
//   4. runs the rollback (guard first, then forced) and proves the inventory
//      is back to the starting state
//   5. applies the forward script once more
//
// It never opens a network connection. Run: npm run validate:idempotency
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pending = path.resolve(here, "..");
const migrations = path.join(pending, "..", "migrations");
const foundation = readFileSync(path.join(migrations, "20260928162500_invoice_foundation.sql"), "utf8");
const grants = readFileSync(path.join(migrations, "20260928163516_invoice_foundation_grants.sql"), "utf8");
const forward = readFileSync(path.join(pending, "payment_idempotency_and_invoice_opportunities.sql"), "utf8");
const rollback = readFileSync(path.join(pending, "payment_idempotency_and_invoice_opportunities_rollback.sql"), "utf8");
const captured = readFileSync(path.join(pending, "reference", "merge_contacts.production.sql"), "utf8");
const capturedBody = captured.slice(captured.indexOf("CREATE OR REPLACE FUNCTION public.merge_contacts"));

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
async function expectError(label, sql, params, pattern) {
  try {
    if (params.length === 0 && sql.includes(";")) await db.exec(sql);
    else await db.query(sql, params);
    fail(label, "expected an error but the statement succeeded");
  } catch (error) {
    const message = String(error?.message ?? error);
    if (pattern && !pattern.test(message)) fail(label, `wrong error: ${message}`);
    else pass(label);
  }
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

const EXISTING_TYPES = [
  "qualified_lead_unbooked",
  "stale_estimate",
  "completed_appointment_no_estimate",
  "dormant_customer",
  "no_show",
  "completed_job_no_referral_request",
  "completed_job_no_review_request",
  "cancelled_appointment_no_rebooking",
  "uncontacted_lead",
  "accepted_estimate_no_job",
  "active_lead_signal",
  "pending_estimate",
];

const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('trackpr.test_uid', true), '')::uuid
$$;
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'America/Denver',
  payment_status text not null default 'active'
);
create table public.organization_members (organization_id uuid, user_id uuid, role text);
create or replace function public.is_org_member(target_org_id uuid) returns boolean language sql stable security definer as $$
  select exists (select 1 from public.organization_members where organization_id = target_org_id and user_id = auth.uid())
$$;
create or replace function public.is_org_admin(target_org_id uuid) returns boolean language sql stable security definer as $$
  select exists (select 1 from public.organization_members where organization_id = target_org_id and user_id = auth.uid() and role in ('owner','admin'))
$$;
create or replace function public.organization_payment_active(target_org_id uuid) returns boolean language sql stable security definer as $$
  select exists (select 1 from public.organizations where id = target_org_id and payment_status = 'active')
$$;
create or replace function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create table public.contacts (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  first_name text, last_name text, company_name text, notes text, phone text, phone_normalized text, email text, email_normalized text,
  merged_into_id uuid, merged_at timestamptz
);
create table public.estimates (id uuid primary key default gen_random_uuid(), organization_id uuid not null, contact_id uuid references public.contacts(id));
create table public.jobs (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  contact_id uuid references public.contacts(id) on delete restrict, estimate_id uuid references public.estimates(id),
  title text not null, amount numeric, status text not null default 'scheduled'
);
create table public.audit_log (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, user_id uuid, action text not null,
  entity_type text, entity_id uuid, automation_id text, metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create table public.ai_interactions (contact_id uuid);
create table public.appointments (contact_id uuid);
create table public.leads (contact_id uuid);
create table public.referral_requests (contact_id uuid);
create table public.review_requests (contact_id uuid);
create table public.conversations (id uuid primary key default gen_random_uuid(), contact_id uuid, channel text, status text);
-- opportunities: the live shape that matters for this migration - the exact
-- current type CHECK (20260930000000), source_entity_type CHECK, open-row
-- dedup index, member policies and payment gate.
create table public.opportunities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  type text not null,
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  source_entity_type text not null check (source_entity_type in ('lead', 'estimate', 'appointment', 'contact', 'job')),
  source_entity_id uuid not null,
  contact_id uuid references public.contacts(id),
  title text not null,
  description text,
  estimated_value numeric,
  value_basis text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution_reason text,
  constraint opportunities_type_check check (type in (${EXISTING_TYPES.map((t) => `'${t}'`).join(", ")}))
);
create unique index opportunities_org_type_source_open_unique on public.opportunities (organization_id, type, source_entity_id) where status = 'open';
alter table public.opportunities enable row level security;
create policy opportunities_select on public.opportunities for select to authenticated using (is_org_member(organization_id));
create policy opportunities_insert on public.opportunities for insert to authenticated with check (is_org_member(organization_id));
create policy opportunities_update on public.opportunities for update to authenticated using (is_org_member(organization_id)) with check (is_org_member(organization_id));
create policy opportunities_payment_active on public.opportunities as restrictive for all to public
  using (public.organization_payment_active(organization_id)) with check (public.organization_payment_active(organization_id));
${capturedBody};
grant usage on schema public to anon, authenticated, service_role;
grant select on public.organizations, public.contacts, public.jobs, public.estimates to authenticated;
grant select, insert, update on public.opportunities to authenticated;
`;

async function inventory() {
  return one(`select
    (select count(*) from information_schema.columns where table_schema='public' and table_name='customer_payments') as payment_columns,
    (select count(*) from information_schema.columns where table_schema='public' and table_name='customer_payments' and column_name='client_key') as client_key_column,
    (select count(*) from pg_indexes where schemaname='public' and tablename='customer_payments') as payment_indexes,
    (select count(*) from pg_indexes where schemaname='public' and tablename='customer_payments' and indexname='customer_payments_org_client_key_unique') as client_key_index,
    (select count(*) from pg_constraint where conrelid='public.customer_payments'::regclass) as payment_constraints,
    (select count(*) from pg_constraint where conrelid='public.customer_payments'::regclass and conname='customer_payments_client_key_shape') as client_key_constraint,
    (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid where not t.tgisinternal and c.relname in ('invoices','customer_payments')) as triggers,
    (select count(*) from pg_policies where tablename in ('invoices','customer_payments')) as policies,
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname like 'customer_payments_%' or p.proname like 'invoices_%') as functions,
    (select pg_get_constraintdef(oid) from pg_constraint where conrelid='public.opportunities'::regclass and conname='opportunities_type_check') as opportunity_type_check,
    (select md5(pg_get_functiondef('public.customer_payments_immutable'::regproc))) as immutable_md5,
    (select string_agg(p.proname || ':' || md5(pg_get_functiondef(p.oid)), ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname in ('invoices_guard_insert','invoices_guard_update','invoices_guard_delete','customer_payments_guard_insert','customer_payments_apply','create_invoice_audit_event','merge_contacts')) as other_function_md5s,
    (select string_agg(tgname || ':' || tgtype::text || ':' || tgenabled::text, ',' order by tgname) from pg_trigger t join pg_class c on c.oid = t.tgrelid where not t.tgisinternal and c.relname in ('invoices','customer_payments')) as trigger_shapes,
    (select string_agg(grantee || ':' || privilege_type, ',' order by grantee, privilege_type) from information_schema.role_table_grants where table_schema='public' and table_name='customer_payments' and grantee in ('anon','authenticated')) as payment_grants`);
}

async function main() {
  console.log("PGlite:", (await one("select version() v")).v.split(",")[0]);
  await db.exec(STUBS);

  console.log("\n[0] reproduce production: invoice_foundation + invoice_foundation_grants");
  // Both applied migrations wrap themselves for the SQL editor; the MCP
  // mechanism supplied its own transaction, so strip a leading begin/commit.
  await db.exec(foundation);
  // Reproduce the project's default privileges that made the grants follow-up necessary.
  await db.exec("grant all on public.invoices, public.customer_payments to anon, authenticated, service_role;");
  await db.exec(grants);
  const base = await inventory();
  check("baseline: 13 payment columns, no client_key, 6 payment indexes, 7 triggers, 7 policies", base.payment_columns === 13 && base.client_key_column === 0 && base.payment_indexes === 6 && base.triggers === 7 && base.policies === 7, JSON.stringify(base));
  check("baseline: opportunities_type_check lists the 12 current types", EXISTING_TYPES.every((t) => base.opportunity_type_check.includes(`'${t}'`)) && !base.opportunity_type_check.includes("invoice_overdue"));
  check("baseline: authenticated holds SELECT+INSERT (never UPDATE/DELETE) on customer_payments; anon holds nothing", base.payment_grants === "authenticated:INSERT,authenticated:REFERENCES,authenticated:SELECT,authenticated:TRIGGER,authenticated:TRUNCATE", base.payment_grants);

  console.log("\n[1] apply forward migration");
  await db.exec(forward);
  const inv1 = await inventory();
  check("client_key column, shape constraint and partial unique index exist", inv1.client_key_column === 1 && inv1.client_key_constraint === 1 && inv1.client_key_index === 1, JSON.stringify(inv1));
  check("exactly one column, one index and one constraint were added to customer_payments", inv1.payment_columns === 14 && inv1.payment_indexes === 7 && inv1.payment_constraints === base.payment_constraints + 1);
  check("triggers, policies and function count on invoices/customer_payments are unchanged", inv1.triggers === base.triggers && inv1.policies === base.policies && inv1.functions === base.functions);
  check("the trigger definitions themselves (name, timing, events, enabled) are unchanged", inv1.trigger_shapes === base.trigger_shapes, inv1.trigger_shapes);
  check("customer_payments_immutable is the ONLY function whose body changed", inv1.immutable_md5 !== base.immutable_md5 && inv1.other_function_md5s === base.other_function_md5s);
  const immutableDef = (await one("select pg_get_functiondef('public.customer_payments_immutable'::regproc) d")).d;
  check("the new immutable body adds exactly the client_key comparison", immutableDef.includes("new.client_key is distinct from old.client_key") && immutableDef.split("is distinct from").length === 7);
  check("grants on customer_payments are unchanged", inv1.payment_grants === base.payment_grants, inv1.payment_grants);
  check("opportunities_type_check now includes the two new types and every previous one", inv1.opportunity_type_check.includes("'completed_job_not_invoiced'") && inv1.opportunity_type_check.includes("'invoice_overdue'") && EXISTING_TYPES.every((t) => inv1.opportunity_type_check.includes(`'${t}'`)));
  const idx = (await one("select indexdef d from pg_indexes where indexname='customer_payments_org_client_key_unique'")).d;
  check("the index is UNIQUE on (organization_id, client_key) WHERE client_key IS NOT NULL", /CREATE UNIQUE INDEX .* ON public\.customer_payments USING btree \(organization_id, client_key\) WHERE \(client_key IS NOT NULL\)/.test(idx), idx);

  console.log("\n[2] apply forward migration again (idempotency)");
  await db.exec(forward);
  const inv2 = await inventory();
  check("second apply leaves the inventory unchanged", JSON.stringify(inv1) === JSON.stringify(inv2), JSON.stringify(inv2));

  console.log("\n[3] fixtures");
  const orgA = (await one("insert into organizations (name, timezone) values ('Org A','America/Denver') returning id")).id;
  const orgB = (await one("insert into organizations (name, timezone) values ('Org B','UTC') returning id")).id;
  const userA = "11111111-1111-1111-1111-111111111111";
  const userB = "22222222-2222-2222-2222-222222222222";
  await q("insert into organization_members values ($1,$2,'owner'),($3,$4,'owner')", [orgA, userA, orgB, userB]);
  await q("select set_config('trackpr.test_uid', $1, false)", [userA]);
  const contactA = (await one("insert into contacts (organization_id, first_name) values ($1,'Ann') returning id", [orgA])).id;
  const contactB = (await one("insert into contacts (organization_id, first_name) values ($1,'Bob') returning id", [orgB])).id;
  const jobA = (await one("insert into jobs (organization_id, contact_id, title, amount, status) values ($1,$2,'Roof',1000,'completed') returning id", [orgA, contactA])).id;
  const jobA2 = (await one("insert into jobs (organization_id, contact_id, title, amount, status) values ($1,$2,'Gutters',500,'completed') returning id", [orgA, contactA])).id;
  const jobB = (await one("insert into jobs (organization_id, contact_id, title, amount, status) values ($1,$2,'B job',800,'completed') returning id", [orgB, contactB])).id;
  const invA = (await one("insert into invoices (organization_id, job_id, title, subtotal, total) values ($1,$2,'Roof invoice',1000,1000) returning id", [orgA, jobA])).id;
  const invB = (await one("insert into invoices (organization_id, job_id, title, subtotal, total) values ($1,$2,'B invoice',800,800) returning id", [orgB, jobB])).id;
  await q("update invoices set status='sent' where id in ($1,$2)", [invA, invB]);
  pass("fixtures created (two organizations, one issued invoice each)");

  console.log("\n[4] client_key: one row per (organization, key), replay rejected by the index, ledger untouched");
  const KEY = "3f0b6c1e-2b7a-4c1d-9c0e-1a2b3c4d5e6f";
  const p1 = await one("insert into customer_payments (organization_id, invoice_id, amount, method, client_key) values ($1,$2,250,'cash',$3) returning id, client_key", [orgA, invA, KEY]);
  check("a payment with a client_key is recorded and the key is stored verbatim", p1.client_key === KEY);
  await expectError("the same key in the same organization is rejected (23505 on customer_payments_org_client_key_unique)", "insert into customer_payments (organization_id, invoice_id, amount, method, client_key) values ($1,$2,250,'cash',$3)", [orgA, invA, KEY], /customer_payments_org_client_key_unique|duplicate key/i);
  let inv = await one("select status, amount_paid from invoices where id=$1", [invA]);
  check("the rejected replay left the invoice exactly as the first attempt did (partially_paid, 250)", inv.status === "partially_paid" && Number(inv.amount_paid) === 250, JSON.stringify(inv));
  check("the ledger holds exactly one row for that key", Number((await one("select count(*) n from customer_payments where client_key=$1", [KEY])).n) === 1);
  await expectError("the same key with a different amount is still the same submission - rejected, never a second row", "insert into customer_payments (organization_id, invoice_id, amount, method, client_key) values ($1,$2,100,'cash',$3)", [orgA, invA, KEY], /customer_payments_org_client_key_unique|duplicate key/i);
  const pB = await one("insert into customer_payments (organization_id, invoice_id, amount, method, client_key) values ($1,$2,100,'check',$3) returning id", [orgB, invB, KEY]);
  check("the same key in ANOTHER organization is a different submission and is accepted", Boolean(pB.id));
  const n1 = await one("insert into customer_payments (organization_id, invoice_id, amount, method) values ($1,$2,50,'cash') returning id", [orgA, invA]);
  const n2 = await one("insert into customer_payments (organization_id, invoice_id, amount, method) values ($1,$2,50,'cash') returning id", [orgA, invA]);
  check("rows without a key (reversals, older clients) are unaffected - two null-key rows coexist", Boolean(n1.id && n2.id) && n1.id !== n2.id);
  const rev = await one("insert into customer_payments (organization_id, invoice_id, amount, method, reverses_payment_id) values ($1,$2,-50,'cash',$3) returning id, client_key", [orgA, invA, n2.id]);
  check("a reversal row carries no client_key and still relies on customer_payments_reversal_unique", rev.client_key === null);

  console.log("\n[5] client_key shape");
  await expectError("shorter than 8 characters is rejected", "insert into customer_payments (organization_id, invoice_id, amount, method, client_key) values ($1,$2,1,'cash','abc')", [orgA, invA], /customer_payments_client_key_shape/i);
  await expectError("characters outside [A-Za-z0-9_-] are rejected", "insert into customer_payments (organization_id, invoice_id, amount, method, client_key) values ($1,$2,1,'cash','bad key with spaces')", [orgA, invA], /customer_payments_client_key_shape/i);
  await expectError("longer than 128 characters is rejected", "insert into customer_payments (organization_id, invoice_id, amount, method, client_key) values ($1,$2,1,'cash',$3)", [orgA, invA, "k".repeat(129)], /customer_payments_client_key_shape/i);
  const long = await one("insert into customer_payments (organization_id, invoice_id, amount, method, client_key) values ($1,$2,1,'cash',$3) returning id", [orgA, invA, "k".repeat(128)]);
  check("exactly 128 characters is accepted", Boolean(long.id));

  console.log("\n[6] append-only semantics preserved");
  await expectError("client_key cannot be changed after the fact (customer_payments_immutable)", "update customer_payments set client_key = 'another-key-0001' where id = $1", [p1.id], /append-only/i);
  await expectError("a keyed row cannot be deleted", "delete from customer_payments where id = $1", [p1.id], /append-only/i);
  await expectError("overpayment is still rejected by the guard, key or no key", "insert into customer_payments (organization_id, invoice_id, amount, method, client_key) values ($1,$2,5000,'cash','overpay-key-0001')", [orgA, invA], /exceed the balance due/i);

  console.log("\n[7] RLS, grants and payment gate (as role authenticated)");
  await db.exec("set role authenticated");
  try {
    const mine = await q("insert into customer_payments (organization_id, invoice_id, amount, method, client_key) values ($1,$2,10,'cash','member-key-0001') returning id", [orgA, invA]);
    check("a member can record a keyed payment in their own organization", mine.length === 1);
    await expectError("a member's replay of their own key is rejected by the index, not silently duplicated", "insert into customer_payments (organization_id, invoice_id, amount, method, client_key) values ($1,$2,10,'cash','member-key-0001')", [orgA, invA], /customer_payments_org_client_key_unique|duplicate key/i);
    await expectError("a member cannot insert into another organization (RLS with check)", "insert into customer_payments (organization_id, invoice_id, amount, method, client_key) values ($1,$2,10,'cash','member-key-0002')", [orgB, invB], /row-level security|policy|same organization/i);
    await expectError("a member still cannot update a payment (no UPDATE privilege)", "update customer_payments set client_key = 'x' where id = $1", [p1.id], /permission denied|policy|append-only/i);
    await expectError("a member still cannot delete a payment (no DELETE privilege)", "delete from customer_payments where id = $1", [p1.id], /permission denied|policy|append-only/i);
    const seen = await q("select organization_id from customer_payments");
    check("a member sees only their own organization's payments", seen.length > 0 && seen.every((r) => r.organization_id === orgA));
    await db.exec("reset role");
    await q("update organizations set payment_status = 'suspended' where id = $1", [orgA]);
    await db.exec("set role authenticated");
    await expectError("payment gate: a suspended organization cannot record a keyed payment", "insert into customer_payments (organization_id, invoice_id, amount, method, client_key) values ($1,$2,1,'cash','member-key-0003')", [orgA, invA], /row-level security|policy|same organization/i);
    check("payment gate: a suspended organization sees zero payments", (await q("select id from customer_payments where organization_id = $1", [orgA])).length === 0);
  } finally {
    await db.exec("reset role");
    await q("update organizations set payment_status = 'active' where id = $1", [orgA]);
  }
  await db.exec("set role anon");
  try {
    await expectError("anon still has no access to customer_payments", "select count(*) from customer_payments", [], /permission denied/i);
  } finally {
    await db.exec("reset role");
  }

  console.log("\n[8] opportunities: the two new types, dedup, unknown types, payment gate");
  const o1 = await one("insert into opportunities (organization_id, type, source_entity_type, source_entity_id, contact_id, title) values ($1,'completed_job_not_invoiced','job',$2,$3,'Ann') returning id", [orgA, jobA2, contactA]);
  const o2 = await one("insert into opportunities (organization_id, type, source_entity_type, source_entity_id, contact_id, title, metadata) values ($1,'invoice_overdue','job',$2,$3,'Ann','{\"invoice_id\":\"x\"}') returning id", [orgA, jobA, contactA]);
  check("completed_job_not_invoiced and invoice_overdue rows can be created, sourced from a job", Boolean(o1.id && o2.id));
  await expectError("an unknown type is still rejected", "insert into opportunities (organization_id, type, source_entity_type, source_entity_id, title) values ($1,'invoice_hacked','job',$2,'x')", [orgA, jobA], /opportunities_type_check/i);
  await expectError("a second OPEN row for the same (organization, type, source) is rejected by the dedup index", "insert into opportunities (organization_id, type, source_entity_type, source_entity_id, title) values ($1,'invoice_overdue','job',$2,'dup')", [orgA, jobA], /opportunities_org_type_source_open_unique|duplicate key/i);
  await q("update opportunities set status='resolved', resolved_at=now(), resolution_reason='condition_no_longer_true' where id=$1", [o2.id]);
  const o3 = await one("insert into opportunities (organization_id, type, source_entity_type, source_entity_id, title) values ($1,'invoice_overdue','job',$2,'again') returning id", [orgA, jobA]);
  check("after resolution the same condition can be detected again as a new open row", Boolean(o3.id));
  const sameKeyOtherOrg = await one("insert into opportunities (organization_id, type, source_entity_type, source_entity_id, title) values ($1,'invoice_overdue','job',$2,'B') returning id", [orgB, jobB]);
  check("the dedup index is organization-scoped", Boolean(sameKeyOtherOrg.id));
  await db.exec("set role authenticated");
  try {
    const seen = await q("select organization_id from opportunities");
    check("a member sees only their own organization's opportunities (new types included)", seen.length > 0 && seen.every((r) => r.organization_id === orgA));
    await expectError("a member cannot create an opportunity for another organization", "insert into opportunities (organization_id, type, source_entity_type, source_entity_id, title) values ($1,'completed_job_not_invoiced','job',$2,'x')", [orgB, jobB], /row-level security|policy/i);
    await db.exec("reset role");
    await q("update organizations set payment_status = 'suspended' where id = $1", [orgA]);
    await db.exec("set role authenticated");
    await expectError("payment gate: a suspended organization cannot create an opportunity of a new type", "insert into opportunities (organization_id, type, source_entity_type, source_entity_id, title) values ($1,'completed_job_not_invoiced','job',$2,'x')", [orgA, jobA], /row-level security|policy/i);
  } finally {
    await db.exec("reset role");
    await q("update organizations set payment_status = 'active' where id = $1", [orgA]);
  }

  console.log("\n[9] rollback (guard first, then forced)");
  await expectError("rollback refuses while keyed payments or new-type opportunities exist", rollback, [], /Refusing to roll back/i);
  await db.exec("rollback");
  await db.exec("delete from opportunities where type in ('completed_job_not_invoiced','invoice_overdue'); alter table public.customer_payments disable trigger all; alter table public.invoices disable trigger all; delete from customer_payments; alter table public.customer_payments enable trigger all; alter table public.invoices enable trigger all;");
  await db.exec(rollback);
  const inv3 = await inventory();
  check("rollback restores the baseline inventory exactly, including the trigger function body (md5)", JSON.stringify(inv3) === JSON.stringify(base), JSON.stringify(inv3));

  console.log("\n[10] apply forward migration after rollback");
  await db.exec(forward);
  const inv4 = await inventory();
  check("re-apply after rollback restores the full inventory", JSON.stringify(inv4) === JSON.stringify(inv1), JSON.stringify(inv4));

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

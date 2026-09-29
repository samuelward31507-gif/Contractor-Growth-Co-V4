// Disposable validation harness for supabase/pending/online_payments.sql
// (Phase 1C - Online Payments; PENDING, not applied anywhere).
//
// Boots an in-memory Postgres (PGlite, with the real pgcrypto extension in
// an `extensions` schema, as on Supabase), recreates the starting state for
// the objects involved - the stand-ins validate-payment-idempotency.mjs uses,
// plus automation_incidents and the captured record_automation_incident_
// signal body, then the already-applied invoice_foundation,
// invoice_foundation_grants and payment_idempotency_and_invoice_opportunities
// migrations - and proves parity with trackpr-stripe-test by comparing
// function md5s read from that project. Then:
//
//   1. applies the forward script (with pre-existing draft, sent and void
//      invoices, to prove the payment_token backfill fires no row triggers)
//   2. applies it AGAIN and proves the object inventory is unchanged
//   3. exercises every rule: the Connect-field guard, payment_token
//      ownership, card_online recording (service role only, connected account
//      verified by the database, replay-proof by session and payment intent,
//      every accounting rule still enforced), append-only, RLS, payment gate,
//      and the new incident category
//   4. runs the rollback (each guard first, then for real) and proves the
//      inventory is back to the starting state, function bodies included
//   5. applies the forward script once more
//
// It never opens a network connection. Run: npm run validate:online-payments
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pending = path.resolve(here, "..");
const migrations = path.join(pending, "..", "migrations");
const foundation = readFileSync(path.join(migrations, "20260928162500_invoice_foundation.sql"), "utf8");
const grants = readFileSync(path.join(migrations, "20260928163516_invoice_foundation_grants.sql"), "utf8");
const idempotency = readFileSync(path.join(migrations, "20260928181837_payment_idempotency_and_invoice_opportunities.sql"), "utf8");
const forward = readFileSync(path.join(pending, "online_payments.sql"), "utf8");
const rollback = readFileSync(path.join(pending, "online_payments_rollback.sql"), "utf8");
const capturedMerge = readFileSync(path.join(pending, "reference", "merge_contacts.production.sql"), "utf8");
const mergeBody = capturedMerge.slice(capturedMerge.indexOf("CREATE OR REPLACE FUNCTION public.merge_contacts"));
const capturedSignal = readFileSync(path.join(pending, "reference", "record_automation_incident_signal.captured.sql"), "utf8");
const signalBody = capturedSignal.slice(capturedSignal.indexOf("CREATE OR REPLACE FUNCTION public.record_automation_incident_signal"));

// Read-only from trackpr-stripe-test (lwofqffxagxiqodqvcfr) on 2026-09-28:
// md5(pg_get_functiondef(...)) of the live objects this migration touches or
// depends on. Matching them here proves the harness starts from the same
// function bodies the test project has.
const TEST_PROJECT_MD5 = {
  record_automation_incident_signal: "dfca7377dd707f2cd7814f87ae84a6bf",
  customer_payments_immutable: "b2be41a0c1f3458e1ca3c6a1df592c39",
  customer_payments_guard_insert: "d539019423402c41452660fd1cb8686c",
};

const db = new PGlite({ extensions: { pgcrypto } });
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

// Run `fn` as the given database role with auth.role()/auth.uid() set the
// way PostgREST would set them. service_role has BYPASSRLS, as on Supabase.
async function as(role, uid, fn) {
  await q("select set_config('trackpr.test_role', $1, false), set_config('trackpr.test_uid', $2, false)", [role, uid ?? ""]);
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
    await q("select set_config('trackpr.test_role', '', false), set_config('trackpr.test_uid', '', false)");
  }
}
const asService = (fn) => as("service_role", null, fn);

const EXISTING_OPPORTUNITY_TYPES = [
  "qualified_lead_unbooked", "stale_estimate", "completed_appointment_no_estimate", "dormant_customer", "no_show",
  "completed_job_no_referral_request", "completed_job_no_review_request", "cancelled_appointment_no_rebooking",
  "uncontacted_lead", "accepted_estimate_no_job", "active_lead_signal", "pending_estimate",
];

const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('trackpr.test_uid', true), '')::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select nullif(current_setting('trackpr.test_role', true), '')
$$;
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'America/Denver',
  payment_status text not null default 'active',
  stripe_customer_id text,
  stripe_subscription_id text
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
create table public.opportunities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  type text not null,
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  source_entity_type text not null check (source_entity_type in ('lead', 'estimate', 'appointment', 'contact', 'job')),
  source_entity_id uuid not null, contact_id uuid references public.contacts(id), title text not null, description text,
  estimated_value numeric, value_basis text, metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), resolved_at timestamptz, resolution_reason text,
  constraint opportunities_type_check check (type in (${EXISTING_OPPORTUNITY_TYPES.map((t) => `'${t}'`).join(", ")}))
);
-- automation_incidents: the live column set, category CHECK and active-
-- fingerprint dedup index read from trackpr-stripe-test.
create table public.automation_incidents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  automation_id text, workflow_execution_id uuid,
  category text not null,
  severity text not null check (severity in ('info', 'warning', 'critical')),
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  fingerprint text not null, title text not null, description text,
  first_seen_at timestamptz not null default now(), last_seen_at timestamptz not null default now(),
  occurrence_count integer not null default 1,
  resolved_at timestamptz, resolved_by uuid, acknowledged_at timestamptz, acknowledged_by uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint automation_incidents_category_check check (category in (
    'workflow_failed', 'repeated_workflow_failure', 'workflow_stuck',
    'n8n_dispatch_failed', 'n8n_callback_failed',
    'sms_send_failed', 'sms_delivery_failed',
    'human_escalation_requested',
    'scheduled_automation_stale'
  ))
);
create unique index automation_incidents_active_fingerprint_unique on public.automation_incidents (organization_id, fingerprint) where status in ('open', 'acknowledged');
${mergeBody};
${signalBody};
revoke all on function public.record_automation_incident_signal(uuid, text, text, text, text, text, text, uuid, jsonb) from public;
revoke all on function public.record_automation_incident_signal(uuid, text, text, text, text, text, text, uuid, jsonb) from anon;
grant execute on function public.record_automation_incident_signal(uuid, text, text, text, text, text, text, uuid, jsonb) to authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;
grant select, update on public.organizations to authenticated;
grant select on public.contacts, public.jobs, public.estimates to authenticated;
grant select, insert, update on public.opportunities to authenticated;
grant all on public.organizations, public.contacts, public.jobs, public.estimates, public.automation_incidents, public.audit_log, public.opportunities to service_role;
`;

const FN_NAMES = [
  "invoices_guard_insert", "invoices_guard_update", "invoices_guard_delete", "customer_payments_guard_insert",
  "customer_payments_apply", "customer_payments_immutable", "create_invoice_audit_event", "merge_contacts",
  "record_automation_incident_signal", "guard_organizations_stripe_connect", "invoices_payment_token_guard", "customer_payments_online_guard",
];

async function inventory() {
  const cols = async (table) => (await one(`select string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, ''), ',' order by column_name) s from information_schema.columns where table_schema='public' and table_name=$1`, [table])).s;
  const cons = async (table) => (await one(`select string_agg(conname || '=' || pg_get_constraintdef(oid), ' | ' order by conname) s from pg_constraint where conrelid=('public.' || $1)::regclass`, [table])).s;
  const idx = async (table) => (await one(`select string_agg(indexdef, ' | ' order by indexname) s from pg_indexes where schemaname='public' and tablename=$1`, [table])).s;
  return {
    organizations_columns: await cols("organizations"),
    invoices_columns: await cols("invoices"),
    payments_columns: await cols("customer_payments"),
    organizations_constraints: await cons("organizations"),
    invoices_constraints: await cons("invoices"),
    payments_constraints: await cons("customer_payments"),
    incidents_constraints: await cons("automation_incidents"),
    organizations_indexes: await idx("organizations"),
    invoices_indexes: await idx("invoices"),
    payments_indexes: await idx("customer_payments"),
    triggers: (await one(`select string_agg(c.relname || '.' || t.tgname || ':' || t.tgtype::text || ':' || t.tgenabled::text || ':' || p.proname, ',' order by c.relname, t.tgname) s from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_proc p on p.oid=t.tgfoid where not t.tgisinternal and c.relname in ('organizations','invoices','customer_payments','automation_incidents')`)).s,
    policies: (await one(`select string_agg(tablename || '.' || policyname || ':' || cmd || ':' || permissive || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), ' | ' order by tablename, policyname) s from pg_policies where tablename in ('organizations','invoices','customer_payments','automation_incidents')`)).s,
    grants: (await one(`select string_agg(table_name || ':' || grantee || ':' || privilege_type, ',' order by table_name, grantee, privilege_type) s from information_schema.role_table_grants where table_schema='public' and table_name in ('organizations','invoices','customer_payments','automation_incidents') and grantee in ('anon','authenticated','service_role')`)).s,
    function_md5s: Object.fromEntries((await q(`select p.proname n, md5(pg_get_functiondef(p.oid)) m from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname = any($1) order by p.proname`, [FN_NAMES])).map((r) => [r.n, r.m])),
    signal_acl: (await one(`select array_to_string(proacl, ',') s from pg_proc where proname='record_automation_incident_signal'`)).s,
  };
}

function diffKeys(a, b) {
  return Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

const ACCT_A = "acct_1TestOrgA0000000000";
const ACCT_B = "acct_1TestOrgB0000000000";
const ACCT_OTHER = "acct_1SomebodyElse000000";
let seq = 0;
function stripeIds() {
  seq += 1;
  const n = String(seq).padStart(6, "0");
  return { session: `cs_test_a1B2c3${n}`, intent: `pi_3Test${n}` };
}

async function main() {
  console.log("PGlite:", (await one("select version() v")).v.split(",")[0]);
  await db.exec(STUBS);

  console.log("\n[0] reproduce the starting state: invoice_foundation + grants + payment_idempotency_and_invoice_opportunities");
  await db.exec(foundation);
  await db.exec("grant all on public.invoices, public.customer_payments to anon, authenticated, service_role;");
  await db.exec(grants);
  await db.exec(idempotency);
  const base = await inventory();
  for (const [name, md5] of Object.entries(TEST_PROJECT_MD5)) {
    check(`parity with trackpr-stripe-test: ${name} md5 is ${md5}`, base.function_md5s[name] === md5, base.function_md5s[name]);
  }
  check("baseline: no Phase 1C objects exist yet", !base.organizations_columns.includes("stripe_connect") && !base.invoices_columns.includes("payment_token") && !base.payments_columns.includes("stripe_") && !base.function_md5s.customer_payments_online_guard);

  // Pre-existing data the forward script must carry across untouched.
  const orgA = (await one("insert into organizations (name, timezone) values ('Org A','America/Denver') returning id")).id;
  const orgB = (await one("insert into organizations (name, timezone) values ('Org B','UTC') returning id")).id;
  const userA = "11111111-1111-1111-1111-111111111111";
  const userB = "22222222-2222-2222-2222-222222222222";
  await q("insert into organization_members values ($1,$2,'owner'),($3,$4,'owner')", [orgA, userA, orgB, userB]);
  await q("select set_config('trackpr.test_uid', $1, false)", [userA]);
  const contactA = (await one("insert into contacts (organization_id, first_name) values ($1,'Ann') returning id", [orgA])).id;
  const contactB = (await one("insert into contacts (organization_id, first_name) values ($1,'Bob') returning id", [orgB])).id;
  const newJob = async (org, contact, title, amount) => (await one("insert into jobs (organization_id, contact_id, title, amount, status) values ($1,$2,$3,$4,'completed') returning id", [org, contact, title, amount])).id;
  const newInvoice = async (org, job, total) => (await one("insert into invoices (organization_id, job_id, title, subtotal, total) values ($1,$2,'Invoice',$3,$3) returning id", [org, job, total])).id;
  const preDraft = await newInvoice(orgA, await newJob(orgA, contactA, "Pre draft", 100), 100);
  const preSent = await newInvoice(orgA, await newJob(orgA, contactA, "Pre sent", 200), 200);
  const preVoid = await newInvoice(orgA, await newJob(orgA, contactA, "Pre void", 300), 300);
  await q("update invoices set status='sent' where id in ($1,$2)", [preSent, preVoid]);
  await q("update invoices set status='void', void_reason='test' where id=$1", [preVoid]);
  await q("insert into customer_payments (organization_id, invoice_id, amount, method) values ($1,$2,50,'cash')", [orgA, preSent]);
  await q("select set_config('trackpr.test_uid', '', false)");
  const preRows = await q("select id, status, amount_paid, updated_at from invoices order by id");
  pass("pre-existing fixtures: two organizations, draft/sent(with a cash payment)/void invoices");

  console.log("\n[1] apply forward migration");
  await db.exec(forward);
  const inv1 = await inventory();
  const changed = diffKeys(base, inv1);
  check("only the expected inventory areas changed", JSON.stringify(changed.sort()) === JSON.stringify(["function_md5s", "incidents_constraints", "invoices_columns", "invoices_constraints", "invoices_indexes", "organizations_columns", "organizations_constraints", "organizations_indexes", "payments_columns", "payments_constraints", "payments_indexes", "triggers"].sort()), changed.join(","));
  check("policies are unchanged", inv1.policies === base.policies);
  check("table grants are unchanged (new columns inherit them; anon still has nothing on invoices/customer_payments)", inv1.grants === base.grants && !/(invoices|customer_payments):anon/.test(inv1.grants), inv1.grants);
  check("record_automation_incident_signal privileges are unchanged", inv1.signal_acl === base.signal_acl, inv1.signal_acl);
  const untouched = ["invoices_guard_insert", "invoices_guard_update", "invoices_guard_delete", "customer_payments_guard_insert", "customer_payments_apply", "create_invoice_audit_event", "merge_contacts"];
  check("every accounting function is byte-identical (guard_insert, apply, invoice guards, audit RPC, merge_contacts)", untouched.every((n) => inv1.function_md5s[n] === base.function_md5s[n]), untouched.filter((n) => inv1.function_md5s[n] !== base.function_md5s[n]).join(","));
  check("exactly three new functions exist", ["guard_organizations_stripe_connect", "invoices_payment_token_guard", "customer_payments_online_guard"].every((n) => inv1.function_md5s[n]) && Object.keys(inv1.function_md5s).length === Object.keys(base.function_md5s).length + 3);
  const signalDef = (await one("select pg_get_functiondef('public.record_automation_incident_signal(uuid,text,text,text,text,text,text,uuid,jsonb)'::regprocedure) d")).d;
  check("record_automation_incident_signal differs from the captured body by exactly the one added category line", signalDef.replace("'scheduled_automation_stale',\n    'online_payment_reconciliation'\n", "'scheduled_automation_stale'\n") === signalBody && signalDef !== signalBody);
  const immutableDef = (await one("select pg_get_functiondef('public.customer_payments_immutable'::regproc) d")).d;
  const baseImmutable = immutableDef.replace(/     or new\.stripe_checkout_session_id is distinct from old\.stripe_checkout_session_id\n     or new\.stripe_payment_intent_id is distinct from old\.stripe_payment_intent_id\n     or new\.stripe_account_id is distinct from old\.stripe_account_id\n/, "");
  check("customer_payments_immutable differs from its previous body by exactly the three Stripe comparisons", (await one("select md5($1) m", [baseImmutable])).m === base.function_md5s.customer_payments_immutable);
  const newTriggers = inv1.triggers.split(",").filter((t) => !base.triggers.split(",").includes(t));
  check("exactly three triggers were added and none were changed", newTriggers.length === 3 && base.triggers.split(",").every((t) => inv1.triggers.split(",").includes(t)), newTriggers.join(","));

  console.log("\n[2] apply forward migration again (idempotency)");
  await db.exec(forward);
  const inv2 = await inventory();
  check("second apply leaves the inventory unchanged", JSON.stringify(inv1) === JSON.stringify(inv2), diffKeys(inv1, inv2).join(","));

  console.log("\n[3] payment_token backfill");
  const postRows = await q("select id, status, amount_paid, updated_at, payment_token from invoices order by id");
  check("every pre-existing invoice (draft, sent, void) received a 48-hex token", postRows.length === 3 && postRows.every((r) => /^[0-9a-f]{48}$/.test(r.payment_token)));
  check("tokens are distinct", new Set(postRows.map((r) => r.payment_token)).size === 3);
  check("the backfill fired no row triggers: status, amount_paid and updated_at of every row are unchanged (void included)", JSON.stringify(preRows) === JSON.stringify(postRows.map((r) => ({ id: r.id, status: r.status, amount_paid: r.amount_paid, updated_at: r.updated_at }))));

  console.log("\n[4] organizations: Stripe Connect fields are service-role only");
  await as("authenticated", userA, async () => {
    await expectError("an org admin cannot set stripe_connect_account_id", "update organizations set stripe_connect_account_id = $1 where id = $2", [ACCT_A, orgA], /trusted server-side process/);
    await expectError("an org admin cannot flip charges_enabled", "update organizations set stripe_connect_charges_enabled = true where id = $1", [orgA], /trusted server-side process/);
    await expectError("an org admin cannot touch stripe_connect_synced_at", "update organizations set stripe_connect_synced_at = now() where id = $1", [orgA], /trusted server-side process/);
    const renamed = await q("update organizations set name = 'Org A (renamed)' where id = $1 returning id", [orgA]);
    check("an org admin can still update unrelated columns", renamed.length === 1);
  });
  await as("authenticated", userA, async () => {
    await expectError("a non-service insert cannot pre-set a Connect account", "insert into organizations (name, stripe_connect_account_id) values ('Sneaky', $1)", [ACCT_OTHER], /trusted server-side process|permission denied/);
  });
  await q("select set_config('trackpr.test_role', 'authenticated', false)");
  await expectError("the INSERT guard holds even for a privileged connection that is not the service role", "insert into organizations (name, stripe_connect_charges_enabled) values ('Sneaky', true)", [], /trusted server-side process/);
  await q("select set_config('trackpr.test_role', '', false)");
  const plainOrg = await one("insert into organizations (name) values ('Plain') returning id, stripe_connect_account_id a, stripe_connect_charges_enabled c");
  check("a plain organization insert still works and gets null/false Connect fields", plainOrg.a === null && plainOrg.c === false);
  await asService(async () => {
    const r = await q("update organizations set stripe_connect_account_id=$1, stripe_connect_charges_enabled=true, stripe_connect_payouts_enabled=true, stripe_connect_details_submitted=true, stripe_connect_synced_at=now() where id=$2 returning id", [ACCT_A, orgA]);
    check("the service role can store the account id and capability flags", r.length === 1);
    await expectError("the account id must look like acct_...", "update organizations set stripe_connect_account_id='bogus' where id=$1", [orgB], /organizations_stripe_connect_account_id_shape/);
    await expectError("one connected account can belong to only one organization", "update organizations set stripe_connect_account_id=$1 where id=$2", [ACCT_A, orgB], /organizations_stripe_connect_account_id_key|duplicate key/);
  });

  console.log("\n[5] invoices.payment_token is database-owned");
  const jobA = await newJob(orgA, contactA, "Roof", 1000);
  const chosen = "a".repeat(48);
  const created = await as("authenticated", userA, () => one("insert into invoices (organization_id, job_id, title, subtotal, total, payment_token) values ($1,$2,'Roof',1000,1000,$3) returning id, payment_token", [orgA, jobA, chosen]));
  check("a client-chosen token on insert is discarded and regenerated", created.payment_token !== chosen && /^[0-9a-f]{48}$/.test(created.payment_token));
  const invA = created.id;
  await as("authenticated", userA, async () => {
    await expectError("a member cannot change an invoice's payment_token", "update invoices set payment_token=$1 where id=$2", [chosen, invA], /trusted server-side process/);
    await q("update invoices set status='sent' where id=$1", [invA]);
  });
  pass("a member can still issue the invoice (other updates are unaffected)");
  await asService(async () => {
    await expectError("even the service role cannot store a malformed token", "update invoices set payment_token='abc' where id=$1", [invA], /invoices_payment_token_shape/);
    const other = (await one("select payment_token t from invoices where id=$1", [preSent])).t;
    await expectError("tokens are unique", "update invoices set payment_token=$1 where id=$2", [other, invA], /invoices_payment_token_unique|duplicate key/);
    const rotated = await q("update invoices set payment_token=encode(extensions.gen_random_bytes(24),'hex') where id=$1 returning payment_token", [invA]);
    check("the service role can rotate a token", rotated.length === 1 && rotated[0].payment_token !== created.payment_token);
  });

  console.log("\n[6] card_online: service role only, connected account verified by the database");
  const insertOnline = (org, invoice, amount, ids, account) =>
    q("insert into customer_payments (organization_id, invoice_id, amount, method, stripe_checkout_session_id, stripe_payment_intent_id, stripe_account_id) values ($1,$2,$3,'card_online',$4,$5,$6) returning id", [org, invoice, amount, ids.session, ids.intent, account]);
  const ids1 = stripeIds();
  await as("authenticated", userA, async () => {
    await expectError("an org member cannot record a card_online payment", "insert into customer_payments (organization_id, invoice_id, amount, method, stripe_checkout_session_id, stripe_payment_intent_id, stripe_account_id) values ($1,$2,400,'card_online',$3,$4,$5)", [orgA, invA, ids1.session, ids1.intent, ACCT_A], /only be recorded by the Stripe webhook/);
  });
  await asService(async () => {
    await expectError("a card_online row whose account differs from the organization's connected account is rejected", "insert into customer_payments (organization_id, invoice_id, amount, method, stripe_checkout_session_id, stripe_payment_intent_id, stripe_account_id) values ($1,$2,400,'card_online',$3,$4,$5)", [orgA, invA, ids1.session, ids1.intent, ACCT_OTHER], /does not match the organization's connected Stripe account/);
    const jobB = await newJob(orgB, contactB, "B job", 800);
    const invB = await newInvoice(orgB, jobB, 800);
    await q("update invoices set status='sent' where id=$1", [invB]);
    const idsB = stripeIds();
    await expectError("an organization with no connected account cannot receive a card_online row", "insert into customer_payments (organization_id, invoice_id, amount, method, stripe_checkout_session_id, stripe_payment_intent_id, stripe_account_id) values ($1,$2,100,'card_online',$3,$4,$5)", [orgB, invB, idsB.session, idsB.intent, ACCT_B], /does not match the organization's connected Stripe account/);
    await expectError("a card_online row missing its checkout session id is rejected (NULL never passes the check)", "insert into customer_payments (organization_id, invoice_id, amount, method, stripe_payment_intent_id, stripe_account_id) values ($1,$2,400,'card_online',$3,$4)", [orgA, invA, ids1.intent, ACCT_A], /customer_payments_stripe_fields/);
    await expectError("a card_online row missing its payment intent id is rejected", "insert into customer_payments (organization_id, invoice_id, amount, method, stripe_checkout_session_id, stripe_account_id) values ($1,$2,400,'card_online',$3,$4)", [orgA, invA, ids1.session, ACCT_A], /customer_payments_stripe_fields/);
    await expectError("a malformed checkout session id is rejected", "insert into customer_payments (organization_id, invoice_id, amount, method, stripe_checkout_session_id, stripe_payment_intent_id, stripe_account_id) values ($1,$2,400,'card_online','sess_123',$3,$4)", [orgA, invA, ids1.intent, ACCT_A], /customer_payments_stripe_fields/);
    await expectError("a manual-method row cannot carry Stripe ids", "insert into customer_payments (organization_id, invoice_id, amount, method, stripe_checkout_session_id) values ($1,$2,10,'cash',$3)", [orgA, invA, ids1.session], /customer_payments_stripe_fields/);
    let inv = await one("select status, amount_paid from invoices where id=$1", [invA]);
    check("none of the rejected inserts touched the invoice", inv.status === "sent" && Number(inv.amount_paid) === 0, JSON.stringify(inv));

    const [p1] = await insertOnline(orgA, invA, 400, ids1, ACCT_A);
    inv = await one("select status, amount_paid, balance_due from invoices where id=$1", [invA]);
    check("a valid card_online payment is recorded and the EXISTING apply trigger moves the invoice (partially_paid, 400 paid)", Boolean(p1.id) && inv.status === "partially_paid" && Number(inv.amount_paid) === 400 && Number(inv.balance_due) === 600, JSON.stringify(inv));

    console.log("\n[7] replay safety");
    await expectError("a replayed checkout.session.completed (same session id) cannot create a second row", "insert into customer_payments (organization_id, invoice_id, amount, method, stripe_checkout_session_id, stripe_payment_intent_id, stripe_account_id) values ($1,$2,400,'card_online',$3,$4,$5)", [orgA, invA, ids1.session, ids1.intent, ACCT_A], /customer_payments_stripe_checkout_session_unique|duplicate key/);
    await expectError("the same payment intent under a different session id is also rejected", "insert into customer_payments (organization_id, invoice_id, amount, method, stripe_checkout_session_id, stripe_payment_intent_id, stripe_account_id) values ($1,$2,100,'card_online','cs_test_differentSession1',$3,$4)", [orgA, invA, ids1.intent, ACCT_A], /customer_payments_stripe_payment_intent_unique|duplicate key/);
    inv = await one("select status, amount_paid from invoices where id=$1", [invA]);
    check("after both replays the ledger still has exactly one row for that session and the invoice is unchanged", Number((await one("select count(*) n from customer_payments where stripe_checkout_session_id=$1", [ids1.session])).n) === 1 && Number(inv.amount_paid) === 400, JSON.stringify(inv));

    console.log("\n[8] the accounting rules still govern online money");
    const ids2 = stripeIds();
    await expectError("an online payment larger than the balance due is rejected by the existing guard", "insert into customer_payments (organization_id, invoice_id, amount, method, stripe_checkout_session_id, stripe_payment_intent_id, stripe_account_id) values ($1,$2,601,'card_online',$3,$4,$5)", [orgA, invA, ids2.session, ids2.intent, ACCT_A], /exceed the balance due/);
    await expectError("an online payment on a draft invoice is rejected", "insert into customer_payments (organization_id, invoice_id, amount, method, stripe_checkout_session_id, stripe_payment_intent_id, stripe_account_id) values ($1,$2,10,'card_online',$3,$4,$5)", [orgA, preDraft, ids2.session, ids2.intent, ACCT_A], /issued, unpaid invoice/);
    await expectError("an online payment on a void invoice is rejected", "insert into customer_payments (organization_id, invoice_id, amount, method, stripe_checkout_session_id, stripe_payment_intent_id, stripe_account_id) values ($1,$2,10,'card_online',$3,$4,$5)", [orgA, preVoid, ids2.session, ids2.intent, ACCT_A], /issued, unpaid invoice/);
    await expectError("amount_paid still cannot be set directly, even by the service role", "update invoices set amount_paid = 1000 where id = $1", [invA], /maintained by customer payments/);
    await expectError("status cannot be set to paid directly, even by the service role", "update invoices set status = 'paid' where id = $1", [invA], /invalid invoice status transition/);
    const [p2] = await insertOnline(orgA, invA, 600, ids2, ACCT_A);
    inv = await one("select status, amount_paid, balance_due, paid_at from invoices where id=$1", [invA]);
    check("paying the exact remaining balance marks the invoice paid - via the existing trigger only", Boolean(p2.id) && inv.status === "paid" && Number(inv.balance_due) === 0 && inv.paid_at !== null, JSON.stringify(inv));
    const ids3 = stripeIds();
    await expectError("a second online payment on a paid invoice is rejected (the reconciliation-incident case)", "insert into customer_payments (organization_id, invoice_id, amount, method, stripe_checkout_session_id, stripe_payment_intent_id, stripe_account_id) values ($1,$2,1,'card_online',$3,$4,$5)", [orgA, invA, ids3.session, ids3.intent, ACCT_A], /issued, unpaid invoice/);

    console.log("\n[9] append-only");
    await expectError("stripe_checkout_session_id cannot be edited", "update customer_payments set stripe_checkout_session_id='cs_test_edited0001' where id=$1", [p1.id], /append-only/);
    await expectError("stripe_payment_intent_id cannot be edited", "update customer_payments set stripe_payment_intent_id='pi_edited0001' where id=$1", [p1.id], /append-only/);
    await expectError("stripe_account_id cannot be edited", "update customer_payments set stripe_account_id=$1 where id=$2", [ACCT_OTHER, p1.id], /append-only/);
    await expectError("a card_online row cannot be deleted", "delete from customer_payments where id=$1", [p1.id], /append-only/);
  });

  console.log("\n[10] reversals, manual payments, RLS and the payment gate");
  const jobA3 = await newJob(orgA, contactA, "Deck", 500);
  const invA3 = await as("authenticated", userA, async () => {
    const id = (await one("insert into invoices (organization_id, job_id, title, subtotal, total) values ($1,$2,'Deck',500,500) returning id", [orgA, jobA3])).id;
    await q("update invoices set status='sent' where id=$1", [id]);
    return id;
  });
  const ids4 = stripeIds();
  const [online] = await asService(() => insertOnline(orgA, invA3, 200, ids4, ACCT_A));
  await as("authenticated", userA, async () => {
    const cash = await q("insert into customer_payments (organization_id, invoice_id, amount, method) values ($1,$2,100,'cash') returning id", [orgA, invA3]);
    check("manual payments still record normally alongside online ones", cash.length === 1);
    await expectError("a reversal row cannot carry Stripe ids", "insert into customer_payments (organization_id, invoice_id, amount, method, reverses_payment_id, stripe_checkout_session_id) values ($1,$2,-200,'cash',$3,'cs_test_reversal0001')", [orgA, invA3, online.id], /customer_payments_stripe_fields/);
    const rev = await one("insert into customer_payments (organization_id, invoice_id, amount, method, reverses_payment_id) values ($1,$2,-200,'cash',$3) returning method, stripe_checkout_session_id", [orgA, invA3, online.id]);
    check("the existing reversal rules still apply to a card_online payment (method copied, no Stripe ids on the reversal)", rev.method === "card_online" && rev.stripe_checkout_session_id === null, JSON.stringify(rev));
    const inv = await one("select status, amount_paid from invoices where id=$1", [invA3]);
    check("the reversal was applied by the existing trigger (only the 100 cash remains)", inv.status === "partially_paid" && Number(inv.amount_paid) === 100, JSON.stringify(inv));
  });
  await as("authenticated", userB, async () => {
    const seen = await q("select id from customer_payments where method='card_online'");
    check("RLS: another organization's member sees none of Org A's online payments", seen.length === 0);
  });
  await q("update organizations set payment_status='suspended' where id=$1", [orgA]);
  const ids5 = stripeIds();
  const suspendedPay = await asService(() => insertOnline(orgA, invA3, 50, ids5, ACCT_A));
  check("money a customer paid is still recorded for a suspended organization (service role bypasses the payment gate, as for every webhook)", suspendedPay.length === 1);
  await as("authenticated", userA, async () => {
    check("payment gate: the suspended organization's members still see no payments", (await q("select id from customer_payments where organization_id=$1", [orgA])).length === 0);
  });
  await q("update organizations set payment_status='active' where id=$1", [orgA]);
  await as("anon", null, async () => {
    await expectError("anon still has no access to customer_payments", "select count(*) from customer_payments", [], /permission denied/);
    await expectError("anon still has no access to invoices (so no token enumeration)", "select payment_token from invoices", [], /permission denied/);
  });

  console.log("\n[11] automation incident: online_payment_reconciliation");
  await q("update organizations set payment_status='suspended' where id=$1", [orgA]);
  const ids3 = stripeIds();
  const meta = { reason: "database_rejected", stripe_checkout_session_id: ids3.session, stripe_payment_intent_id: ids3.intent, stripe_account_id: ACCT_A, invoice_id: invA, amount: 1, error: "Payments can only be recorded against an issued, unpaid invoice" };
  const incident = await asService(() => one("select (r).id, (r).category, (r).severity, (r).occurrence_count from (select record_automation_incident_signal($1, 'online_payment_reconciliation', 'critical', $2, 'Online payment needs reconciliation', 'Stripe collected a payment Trackpr could not record.', null, null, $3::jsonb) r) s", [orgA, `online_payment:${ids3.session}`, JSON.stringify(meta)]));
  check("the service role records a critical online_payment_reconciliation incident, even for a suspended organization", incident.category === "online_payment_reconciliation" && incident.severity === "critical" && incident.occurrence_count === 1, JSON.stringify(incident));
  const again = await asService(() => one("select (r).occurrence_count from (select record_automation_incident_signal($1, 'online_payment_reconciliation', 'critical', $2, 'Online payment needs reconciliation', null, null, null, $3::jsonb) r) s", [orgA, `online_payment:${ids3.session}`, JSON.stringify(meta)]));
  check("a Stripe retry of the same failure increments the same incident instead of opening a second one", again.occurrence_count === 2);
  const stored = await one("select metadata from automation_incidents where id=$1", [incident.id]);
  check("the incident metadata carries the Stripe ids needed to reconcile by hand", stored.metadata.stripe_checkout_session_id === ids3.session && stored.metadata.stripe_payment_intent_id === ids3.intent && stored.metadata.stripe_account_id === ACCT_A);
  await q("update organizations set payment_status='active' where id=$1", [orgA]);
  await asService(async () => {
    await expectError("unknown categories are still rejected", "select record_automation_incident_signal($1, 'online_payment_whatever', 'critical', 'fp', 'x')", [orgA], /Unsupported incident category/);
  });
  await as("authenticated", userB, async () => {
    await expectError("a member of another organization still cannot raise an incident for Org A", "select record_automation_incident_signal($1, 'online_payment_reconciliation', 'critical', 'fp2', 'x')", [orgA], /Not authorized/);
  });

  console.log("\n[12] rollback (each guard, then for real)");
  await expectError("rollback refuses while card_online payments exist", rollback, [], /card_online customer payments exist/);
  await db.exec("rollback");
  await db.exec("alter table public.customer_payments disable trigger all; alter table public.invoices disable trigger all; delete from customer_payments where method='card_online'; alter table public.customer_payments enable trigger all; alter table public.invoices enable trigger all;");
  await expectError("rollback refuses while online_payment_reconciliation incidents exist", rollback, [], /online_payment_reconciliation incidents exist/);
  await db.exec("rollback");
  await db.exec("delete from automation_incidents where category='online_payment_reconciliation'");
  await expectError("rollback refuses while an organization has a Connect account id", rollback, [], /Stripe Connect account id/);
  await db.exec("rollback");
  await asService(() => q("update organizations set stripe_connect_account_id=null, stripe_connect_charges_enabled=false, stripe_connect_payouts_enabled=false, stripe_connect_details_submitted=false, stripe_connect_synced_at=null"));
  await db.exec(rollback);
  const inv3 = await inventory();
  check("rollback restores the starting inventory exactly, including every function body (md5)", JSON.stringify(inv3) === JSON.stringify(base), diffKeys(base, inv3).join(","));
  check("after rollback the two re-created functions match the trackpr-stripe-test md5s again", inv3.function_md5s.record_automation_incident_signal === TEST_PROJECT_MD5.record_automation_incident_signal && inv3.function_md5s.customer_payments_immutable === TEST_PROJECT_MD5.customer_payments_immutable);

  console.log("\n[13] apply forward migration after rollback");
  await db.exec(forward);
  const inv4 = await inventory();
  check("re-apply after rollback restores the full inventory", JSON.stringify(inv4) === JSON.stringify(inv1), diffKeys(inv1, inv4).join(","));

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

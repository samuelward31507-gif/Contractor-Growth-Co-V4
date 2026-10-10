// Founder finance (Phase 4, Stage 1): applies the founder, sales, agency
// foundation, revenue_events (as deployed), handoff, delivery and finance SQL
// (finance twice) to an in-memory Postgres (PGlite) and proves: founder-only,
// owner-scoped access; writes only through audited functions (never direct,
// never deleted, voided rows frozen); request-id idempotency and stale-write
// refusal; the cash-basis and recurring-cost rules; manual income kept apart
// from Stripe; the Stripe and contracted-fee reads are founder-only,
// aggregate-only and read-only; existing MRR entries and revenue events are
// untouched; existing RLS policies and grants are unchanged; amounts follow
// each currency's decimal places (JPY 0, USD 2, KWD 3); a founder account
// with financial records can't be deleted; and a non-destructive rollback
// that re-applies cleanly.
//   cd supabase/pending/scratch && node validate-founder-finance.mjs
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const file = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // founder
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // second founder
const ADM = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // agency admin, not a founder
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // signed in, neither
const ORG1 = "0f000000-0000-4000-8000-000000000001";
let n = 0;
const rid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

const db = new PGlite();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
async function as(uid, fn, role = "authenticated") {
  if (uid) await db.exec(`set trackpr.test_uid = '${uid}'`);
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally { await db.exec("reset role"); await db.exec("reset trackpr.test_uid"); }
}
const errorOf = async (uid, sql, params, role) => as(uid, async () => { try { await db.query(sql, params); return null; } catch (e) { return e; } }, role);
async function rejects(uid, sql, params, code, label, role) {
  const err = await errorOf(uid, sql, params, role);
  assert.ok(err, `${label}: expected an error`);
  if (code) assert.equal(err.code, code, `${label}: ${err.message}`);
  return err;
}
const one = async (uid, sql, params = []) => as(uid, async () => (await q(sql, params))[0]);
const count = async (table, where = "true", params = []) => (await q(`select count(*)::int n from ${table} where ${where}`, params))[0].n;
const fingerprint = async (table) => (await q(`select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) h from ${table} t`))[0].h;

await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema if not exists auth;
  create table auth.users (id uuid primary key, email text);
  grant usage on schema auth to authenticated, service_role;
  create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('trackpr.test_uid', true), '')::uuid $$;
  create or replace function public.set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = clock_timestamp(); return new; end $$;
  grant usage on schema public to authenticated, anon, service_role;
`);
await q("insert into auth.users (id, email) values ($1, 'founder@x.test'), ($2, 'founder2@x.test'), ($3, 'ops@x.test'), ($4, 'someone@x.test')", [A, B, ADM, C]);
await db.exec(file("founder_command_center.sql"));
await db.exec(file("founder_daily_focus.sql"));
await db.exec(file("founder_sales_os.sql"));
await db.exec(`
  create table public.organizations (id uuid primary key, name text not null);
  create table public.agency_admins (id uuid primary key default gen_random_uuid(), user_id uuid not null unique references auth.users(id) on delete cascade, created_at timestamptz not null default now());
  alter table public.agency_admins enable row level security;
  create policy agency_admins_select_self on public.agency_admins for select using (user_id = auth.uid());
  create table public.agency_organizations (id uuid primary key default gen_random_uuid(), organization_id uuid not null unique references public.organizations(id) on delete cascade, created_at timestamptz not null default now());
  alter table public.agency_organizations enable row level security;
  create or replace function public.is_agency_admin() returns boolean language sql stable security definer set search_path to 'public' as $$ select exists (select 1 from public.agency_admins where user_id = auth.uid()); $$;
  create policy agency_organizations_select on public.agency_organizations for select using (is_agency_admin());
  grant execute on function public.is_agency_admin() to authenticated;
  -- revenue_events exactly as deployed (20260926120000_revenue_intelligence.sql).
  create table public.revenue_events (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    provider text not null default 'stripe',
    provider_event_id text not null unique,
    provider_object_id text not null,
    event_type text not null check (event_type in ('payment_succeeded', 'payment_failed', 'refund')),
    revenue_category text check (revenue_category in ('setup', 'recurring')),
    amount bigint not null check (amount >= 0),
    currency text not null,
    occurred_at timestamptz not null,
    recorded_at timestamptz not null default now(),
    metadata jsonb not null default '{}'::jsonb
  );
  alter table public.revenue_events enable row level security;
  create policy revenue_events_select on public.revenue_events for select using (is_agency_admin());
  grant select on public.revenue_events to authenticated;
`);
await q("insert into founder_users (user_id, timezone) values ($1, 'America/Denver'), ($2, 'UTC')", [A, B]);
await q("insert into agency_admins (user_id) values ($1)", [ADM]);
await q("insert into organizations (id, name) values ($1, 'Managed Co')", [ORG1]);
await q("insert into agency_organizations (organization_id) values ($1)", [ORG1]);
await db.exec(file("agency_client_handoff.sql"));
await db.exec(file("agency_client_delivery.sql"));

// Existing records that must never change: a manual MRR entry and Stripe events.
await q("insert into founder_mrr_entries (owner_id, month, kind, amount, customer) values ($1, '2026-09-01', 'starting', 1497, 'Acme')", [A]);
const ev = (id, type, cat, obj, amount, cur, at) =>
  q("insert into revenue_events (organization_id, provider_event_id, provider_object_id, event_type, revenue_category, amount, currency, occurred_at) values ($1,$2,$3,$4,$5,$6,$7,$8)", [ORG1, id, obj, type, cat, amount, cur, at]);
await ev("evt_1", "payment_succeeded", null, "in_first", 399700, "usd", "2026-09-05T15:00:00Z"); // first invoice: setup + month, uncategorized
await ev("evt_2", "payment_succeeded", "recurring", "in_r1", 149700, "usd", "2026-10-05T15:00:00Z");
await ev("evt_3", "refund", null, "re_1", 50000, "usd", "2026-10-07T15:00:00Z");
await ev("evt_4", "payment_failed", null, "in_late", 149700, "usd", "2026-10-02T15:00:00Z"); // failed, then paid
await ev("evt_5", "payment_succeeded", "recurring", "in_late", 149700, "usd", "2026-10-04T15:00:00Z");
await ev("evt_6", "payment_failed", "recurring", "in_bad", 149700, "usd", "2026-10-06T15:00:00Z"); // failed twice, never paid
await ev("evt_7", "payment_failed", "recurring", "in_bad", 129700, "usd", "2026-10-09T15:00:00Z"); // latest attempt, lower amount
await ev("evt_8", "payment_succeeded", "recurring", "in_eur", 90000, "eur", "2026-10-03T15:00:00Z");
await ev("evt_9", "payment_succeeded", "recurring", "in_edge", 100, "usd", "2026-10-01T03:00:00Z"); // Sep 30 in Denver
// One invoice (stable id in_retry) failing three times, then paid: never "failed", collected once.
await ev("evt_10", "payment_failed", "recurring", "in_retry", 149700, "usd", "2026-10-11T15:00:00Z");
await ev("evt_11", "payment_failed", "recurring", "in_retry", 149700, "usd", "2026-10-14T15:00:00Z");
await ev("evt_12", "payment_failed", "recurring", "in_retry", 149700, "usd", "2026-10-17T15:00:00Z");
await ev("evt_13", "payment_succeeded", "recurring", "in_retry", 149700, "usd", "2026-10-18T15:00:00Z");
// A refund row carrying a category (the webhook never sets one; the schema allows it) is still only a refund.
await ev("evt_14", "refund", "recurring", "re_2", 10000, "usd", "2026-10-20T15:00:00Z");
// Zero-decimal, three-decimal and special-case currencies, in Stripe's own units.
await ev("evt_15", "payment_succeeded", "recurring", "in_jpy", 5000, "jpy", "2026-10-05T15:00:00Z"); // ¥5,000
await ev("evt_16", "payment_succeeded", "recurring", "in_kwd", 12340, "kwd", "2026-10-05T15:00:00Z"); // KWD 12.340
await ev("evt_17", "payment_succeeded", "recurring", "in_isk", 990000, "isk", "2026-10-05T15:00:00Z");
// Failure and recovery on both sides of an Oct 1-15 (Denver) reporting period, in CAD to keep them apart.
await ev("evt_20", "payment_failed", "recurring", "in_pre_rec", 20000, "cad", "2026-09-28T15:00:00Z"); // failed before the period...
await ev("evt_21", "payment_succeeded", "recurring", "in_pre_rec", 20000, "cad", "2026-10-05T15:00:00Z"); // ...recovered inside it
await ev("evt_22", "payment_failed", "recurring", "in_in_post", 30000, "cad", "2026-10-03T15:00:00Z"); // failed inside...
await ev("evt_23", "payment_succeeded", "recurring", "in_in_post", 30000, "cad", "2026-10-20T15:00:00Z"); // ...recovered after
await ev("evt_24", "payment_failed", "recurring", "in_pre_open", 40000, "cad", "2026-09-28T15:00:00Z"); // failed before, never paid...
await ev("evt_28", "payment_failed", "recurring", "in_pre_open", 40000, "cad", "2026-10-02T15:00:00Z"); // ...and again inside (a second month)
await ev("evt_25", "payment_failed", "recurring", "in_in_open", 50000, "cad", "2026-10-10T15:00:00Z"); // failed inside...
await ev("evt_26", "payment_failed", "recurring", "in_in_open", 45000, "cad", "2026-10-25T15:00:00Z"); // ...and again after, never paid
await ev("evt_27", "payment_failed", "recurring", "in_post_open", 60000, "cad", "2026-10-30T15:00:00Z"); // failed after, never paid
const mrrBefore = await fingerprint("founder_mrr_entries");
const revenueBefore = await fingerprint("revenue_events");
const FINANCE = ["founder_expenses", "founder_recurring_costs", "founder_income_receipts", "founder_cash_balances", "founder_finance_events"];
const NEW_FUNCTIONS = /^founder_(record_expense|mark_expense_paid|correct_expense|void_expense|create_recurring_cost|correct_recurring_cost|end_recurring_cost|void_recurring_cost|record_income|correct_income|void_income|record_cash_balance|void_cash_balance|stripe_revenue_summary|stripe_unrecovered_invoices|stripe_verified_exponent|contracted_mrr|finance_.*|currency_minor_units)$/;
// Every pre-existing RLS policy, RLS flag, table grant and function grant - must never change.
async function catalog() {
  const fin = FINANCE.map((t) => `'${t}'`).join(",");
  const [pol] = await q(`select md5(coalesce(string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), ';' order by tablename, policyname), '')) h from pg_policies where tablename not in (${fin})`);
  const [rls] = await q(`select md5(string_agg(relname || ':' || relrowsecurity || relforcerowsecurity, ';' order by relname)) h from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'auth') and c.relkind = 'r' and relname not in (${fin})`);
  const [tg] = await q(`select md5(string_agg(table_schema || '.' || table_name || ':' || grantee || ':' || privilege_type, ';' order by 1)) h from information_schema.role_table_grants where table_schema in ('public', 'auth') and table_name not in (${fin})`);
  const fns = (await q("select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || '):' || coalesce(p.proacl::text, 'default') || ':' || p.prosecdef a, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'auth') order by 1")).filter((r) => !NEW_FUNCTIONS.test(r.proname)).map((r) => r.a);
  return { policies: pol.h, rls: rls.h, tableGrants: tg.h, functionGrants: fns.join(";") };
}
// Every existing non-finance table's data.
async function otherData() {
  const tables = (await q(`select schemaname || '.' || tablename t from pg_tables where schemaname in ('public', 'auth') and tablename not in (${FINANCE.map((t) => `'${t}'`).join(",")}) order by 1`)).map((r) => r.t);
  return Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await fingerprint(t)])));
}
const catalogBefore = await catalog();
const dataBefore = await otherData();

const forward = file("founder_finance.sql");
const rollback = file("founder_finance_rollback.sql");
await db.exec(forward);
await db.exec(forward);
// Every protection on the finance tables - must survive rollback (twice) and re-apply unchanged.
async function protections() {
  const fin = FINANCE.map((t) => `'${t}'`).join(",");
  const checks = (await q(`select conrelid::regclass::text t, conname, pg_get_constraintdef(oid) d from pg_constraint where contype = 'c' and conrelid::regclass::text in (${fin}) order by 1, 2`)).map((r) => `${r.t}.${r.conname}: ${r.d}`);
  const fks = (await q(`select conrelid::regclass::text t, conname, confdeltype from pg_constraint where contype = 'f' and conrelid::regclass::text in (${fin}) order by 1, 2`)).map((r) => `${r.t}.${r.conname}:${r.confdeltype}`);
  const uniques = (await q(`select indexname || ':' || indexdef d from pg_indexes where tablename in (${fin}) order by 1`)).map((r) => r.d);
  const triggers = (await q(`select tgrelid::regclass::text || '.' || tgname || ':' || tgfoid::regproc::text d from pg_trigger where not tgisinternal and tgrelid::regclass::text in (${fin}) order by 1`)).map((r) => r.d);
  const policies = (await q(`select tablename || '.' || policyname || ':' || cmd || ':' || roles::text || ':' || coalesce(qual, '') d from pg_policies where tablename in (${fin}) order by 1`)).map((r) => r.d);
  const rls = (await q(`select relname || ':' || relrowsecurity d from pg_class where relname in (${fin}) order by 1`)).map((r) => r.d);
  const grants = (await q(`select table_name || ':' || grantee || ':' || privilege_type d from information_schema.role_table_grants where table_name in (${fin}) order by 1`)).map((r) => r.d);
  const lookup = (await q("select count(*)::int n from pg_proc where proname = 'founder_currency_minor_units'"))[0].n;
  return { checks, fks, uniques, triggers, policies, rls, grants, lookup };
}
const protectionsApplied = await protections();
assert.equal(protectionsApplied.checks.filter((c) => c.includes("founder_currency_minor_units")).length, 4, "four table-level currency decimal checks");
assert.equal(protectionsApplied.fks.filter((f) => f.endsWith("_owner_id_fkey:r")).length, 5, "five owner keys, ON DELETE RESTRICT");
assert.equal(protectionsApplied.lookup, 1);
assert.equal(await fingerprint("founder_mrr_entries"), mrrBefore, "MRR entries unchanged by the migration");
assert.equal(await fingerprint("revenue_events"), revenueBefore, "revenue events unchanged by the migration");
assert.deepEqual(await otherData(), dataBefore, "no existing table's data changed (MRR, revenue events, Agency tables, organizations, auth)");
assert.deepEqual(await catalog(), catalogBefore, "every existing RLS policy, RLS flag, table grant and function grant is unchanged");
console.log("ok  applies twice; no existing data, RLS policy or grant changed (MRR entries, revenue events, Agency tables included)");

const TABLES = ["founder_expenses", "founder_recurring_costs", "founder_income_receipts", "founder_cash_balances", "founder_finance_events"];
const call = (uid, sql, params) => one(uid, `select ${sql} r`, params).then((x) => x.r);
const today = (await q("select (now() at time zone 'America/Denver')::date::text d"))[0].d;
const tomorrow = (await q("select ((now() at time zone 'America/Denver')::date + 1)::text d"))[0].d;
const thisMonth = `${today.slice(0, 8)}01`;

// --- 1. Access ------------------------------------------------------------------------------------
const exp1 = rid();
for (const [uid, label] of [[ADM, "agency admin"], [C, "non-founder"]]) {
  await rejects(uid, "select founder_record_expense($1, 'Vercel', 'hosting', null, 20, 'USD', $2, null, null, null, null)", [rid(), today], "FS404", `${label} can't record`);
  await rejects(uid, "select * from founder_stripe_revenue_summary('2026-01-01', '2027-01-01')", [], "FS404", `${label} can't read the Stripe summary`);
  await rejects(uid, "select * from founder_stripe_unrecovered_invoices()", [], "FS404", `${label} can't read unrecovered invoices`);
  await rejects(uid, "select * from founder_contracted_mrr()", [], "FS404", `${label} can't read contracted fees`);
}
await rejects(null, "select founder_record_expense($1, 'Vercel', 'hosting', null, 20, 'USD', $2, null, null, null, null)", [rid(), today], "42501", "anon can't call it", "anon");
await rejects(null, "select * from founder_stripe_revenue_summary('2026-01-01', '2027-01-01')", [], "42501", "anon can't read it", "anon");
await rejects(null, "select * from founder_stripe_unrecovered_invoices()", [], "42501", "anon can't read unrecovered invoices", "anon");
await rejects(A, "select founder_stripe_verified_exponent('USD')", [], "42501", "the exponent helper isn't callable directly");
for (const fn of ["founder_finance_today()", "founder_finance_audit('expense', gen_random_uuid(), 'created', null, null, '{}')", "founder_finance_reason('x')"]) {
  await rejects(A, `select ${fn}`, [], "42501", `helper ${fn} isn't callable`);
}
for (const t of TABLES.slice(0, 4)) {
  await rejects(A, `insert into ${t} (id, owner_id) values ($1, $2)`, [rid(), A], "42501", `no direct insert into ${t}`);
  await rejects(A, `update ${t} set source = 'manual'`, [], "42501", `no direct update of ${t}`);
  await rejects(A, `delete from ${t}`, [], "42501", `no direct delete from ${t}`);
}
await rejects(A, "insert into founder_finance_events (owner_id, entity, entity_id, action) values ($1, 'expense', gen_random_uuid(), 'created')", [A], "42501", "no direct audit insert");
console.log("ok  founder only (agency admin, non-founder and anon refused); helpers private; no direct writes");

// --- 2. Expenses ------------------------------------------------------------------------------------
const bad = [
  [[rid(), "Vercel", "hosting", null, 0, "USD", today, null, null, null, null], "zero amount"],
  [[rid(), "Vercel", "hosting", null, -5, "USD", today, null, null, null, null], "negative amount"],
  [[rid(), "Vercel", "hosting", null, 1.005, "USD", today, null, null, null, null], "sub-cent amount"],
  [[rid(), "Vercel", "hosting", null, 20, "usd", today, null, null, null, null], "lower-case currency"],
  [[rid(), "Vercel", "hosting", null, 20, "US", today, null, null, null, null], "two-letter currency"],
  [[rid(), " ", "hosting", null, 20, "USD", today, null, null, null, null], "blank vendor"],
  [[rid(), "x".repeat(201), "hosting", null, 20, "USD", today, null, null, null, null], "long vendor"],
  [[rid(), "Vercel", "taxes", null, 20, "USD", today, null, null, null, null], "unknown category"],
  [[rid(), "Vercel", "hosting", "x".repeat(501), 20, "USD", today, null, null, null, null], "long description"],
  [[rid(), "Vercel", "hosting", null, 20, "USD", null, null, null, null, null], "no expense date"],
  [[rid(), "Vercel", "hosting", null, 20, "USD", today, null, tomorrow, null, null], "paid in the future"],
  [[rid(), "Vercel", "hosting", null, 20, "USD", today, null, null, null, thisMonth], "covered month without a recurring cost"],
];
for (const [args, label] of bad) await rejects(A, "select founder_record_expense($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", args, "FS422", `expense refused: ${label}`);
let r = await call(A, "founder_record_expense($1, ' Vercel ', 'hosting', 'Pro plan', 20, 'USD', $2, $2, null, null, null)", [exp1, today]);
assert.equal(r.status, "recorded");
assert.equal((await call(A, "founder_record_expense($1, 'Different', 'other', null, 999, 'EUR', $2, null, null, null, null)", [exp1, today])).status, "duplicate", "a retry with the same request id records nothing new");
await rejects(B, "select founder_record_expense($1, 'Vercel', 'hosting', null, 20, 'USD', $2, null, null, null, null)", [exp1, today], "FS422", "another founder can't reuse the request id");
let e = (await q("select * from founder_expenses where id = $1", [exp1]))[0];
assert.deepEqual([e.vendor, e.amount, e.currency, e.paid_on, e.source, e.owner_id], ["Vercel", "20.000", "USD", null, "manual", A]);
assert.equal(await count("founder_expenses"), 1);
await rejects(A, "select founder_mark_expense_paid($1, '2020-01-01', $2)", [exp1, today], "FS409", "stale version refused");
await rejects(A, "select founder_mark_expense_paid($1, $2, $3)", [exp1, e.updated_at, tomorrow], "FS422", "paid in the future refused");
await rejects(B, "select founder_mark_expense_paid($1, $2, $3)", [exp1, e.updated_at, today], "FS404", "another founder can't pay it");
r = await call(A, "founder_mark_expense_paid($1, $2, $3)", [exp1, e.updated_at, today]);
assert.equal(r.status, "recorded");
assert.equal((await call(A, "founder_mark_expense_paid($1, $2, $3)", [exp1, e.updated_at, today])).status, "duplicate", "repeat pay is a duplicate");
e = (await q("select * from founder_expenses where id = $1", [exp1]))[0];
await rejects(A, "select founder_mark_expense_paid($1, $2, $3)", [exp1, e.updated_at, "2026-01-02"], "FS422", "already paid: correct it instead");
await rejects(A, "select founder_correct_expense($1, $2, 'Vercel', 'hosting', 'Pro plan', 25, 'USD', $3, $3, $3, null)", [exp1, e.updated_at, today], "FS422", "a correction needs a reason");
await rejects(A, "select founder_correct_expense($1, $2, 'Vercel', 'hosting', 'Pro plan', 20, 'USD', $3, $3, $3, 'no change')", [exp1, e.updated_at, today], "FS422", "a no-op correction is refused");
await rejects(A, "select founder_correct_expense($1, '2020-01-01', 'Vercel', 'hosting', 'Pro plan', 25, 'USD', $2, $2, $2, 'typo')", [exp1, today], "FS409", "stale correction refused");
await rejects(B, "select founder_correct_expense($1, $2, 'Vercel', 'hosting', null, 25, 'USD', $3, null, $3, 'mine now')", [exp1, e.updated_at, today], "FS404", "another founder can't correct it");
await call(A, "founder_correct_expense($1, $2, 'Vercel', 'hosting', 'Pro plan', 25, 'USD', $3, $3, $3, 'Invoice said 25')", [exp1, e.updated_at, today]);
const corr = await one(A, "select before->>'amount' b, after->>'amount' a, reason, before ? 'owner_id' has_owner from founder_finance_events where entity_id = $1 and action = 'corrected'", [exp1]);
assert.deepEqual([corr.b, corr.a, corr.reason, corr.has_owner], ["20.000", "25.000", "Invoice said 25", false], "correction keeps before and after");
await rejects(A, "select founder_void_expense($1, '  ')", [exp1], "FS422", "a void needs a reason");
await rejects(B, "select founder_void_expense($1, 'not mine')", [exp1], "FS404", "another founder can't void it");
assert.equal((await call(A, "founder_void_expense($1, 'Entered twice')", [exp1])).status, "recorded");
assert.equal((await call(A, "founder_void_expense($1, 'again')", [exp1])).status, "duplicate");
e = (await q("select * from founder_expenses where id = $1", [exp1]))[0];
await rejects(A, "select founder_correct_expense($1, $2, 'Vercel', 'hosting', null, 30, 'USD', $3, null, $3, 'after void')", [exp1, e.updated_at, today], "FS422", "a voided expense can't be corrected");
assert.equal(await count("founder_expenses", "id = $1", [exp1]), 1, "voided, not deleted");
assert.deepEqual((await q("select action from founder_finance_events where entity_id = $1 order by occurred_at", [exp1])).map((x) => x.action), ["created", "paid", "corrected", "voided"]);
// Prepayment: a payment may be dated before the expense (annual plans, deposits); only the future is refused.
const pre1 = rid();
assert.equal((await call(A, "founder_record_expense($1, 'Annual domain', 'software', null, 120, 'USD', '2026-12-01', null, $2, null, null)", [pre1, today])).status, "recorded", "paid today for an expense incurred later");
const pre2 = rid();
await call(A, "founder_record_expense($1, 'Deposit', 'office', null, 500, 'USD', '2026-10-01', null, '2024-09-01', null, null)", [pre2]);
assert.equal((await q("select paid_on::text p from founder_expenses where id = $1", [pre2]))[0].p, "2024-09-01", "paid two years before the expense date");
const pre3 = rid();
await call(A, "founder_record_expense($1, 'Conference', 'travel', null, 900, 'USD', '2026-11-15', null, null, null, null)", [pre3]);
const pre3v = (await q("select updated_at from founder_expenses where id = $1", [pre3]))[0].updated_at;
await call(A, "founder_mark_expense_paid($1, $2, $3)", [pre3, pre3v, today]);
const pre3w = (await q("select updated_at from founder_expenses where id = $1", [pre3]))[0].updated_at;
await call(A, "founder_correct_expense($1, $2, 'Conference', 'travel', null, 900, 'USD', '2026-11-15', null, '2025-01-10', 'Paid with the early-bird invoice')", [pre3, pre3w]);
assert.equal((await q("select paid_on::text p from founder_expenses where id = $1", [pre3]))[0].p, "2025-01-10", "a correction may move payment before the expense date");
assert.equal(await count("pg_constraint", "conname like 'founder_expenses_%' and pg_get_constraintdef(oid) like '%paid_on >= %'"), 0, "no prepayment limit in the table");
console.log("ok  expenses: validated, idempotent, owner-scoped, stale writes refused, paid once, corrected with reason (before/after kept), voided not deleted; prepayment allowed, future refused");

// --- 2b. Decimal places follow the currency (JPY 0, USD 2, KWD 3) ----------------------------------------
assert.deepEqual(
  (await q("select founder_currency_minor_units('JPY') jpy, founder_currency_minor_units('KRW') krw, founder_currency_minor_units('USD') usd, founder_currency_minor_units('EUR') eur, founder_currency_minor_units('KWD') kwd, founder_currency_minor_units('CLF') clf, founder_currency_minor_units('usd') lower"))[0],
  { jpy: 0, krw: 0, usd: 2, eur: 2, kwd: 3, clf: null, lower: null },
);
await call(A, "founder_record_expense($1, 'Tokyo co-working', 'office', null, 15000, 'JPY', $2, null, $2, null, null)", [rid(), today]);
await rejects(A, "select founder_record_expense($1, 'Tokyo co-working', 'office', null, 1500.5, 'JPY', $2, null, $2, null, null)", [rid(), today], "FS422", "JPY has no decimal places");
await rejects(A, "select founder_record_expense($1, 'x', 'other', null, 10.005, 'USD', $2, null, null, null, null)", [rid(), today], "FS422", "USD has two");
await call(A, "founder_record_expense($1, 'Kuwait filing', 'professional_services', null, 12.345, 'KWD', $2, null, null, null, null)", [rid(), today]);
await rejects(A, "select founder_record_expense($1, 'x', 'other', null, 12.3456, 'KWD', $2, null, null, null, null)", [rid(), today], "FS422", "KWD has three");
await rejects(A, "select founder_record_expense($1, 'x', 'other', null, 10, 'CLF', $2, null, null, null, null)", [rid(), today], "FS422", "an unsupported currency is refused, not guessed");
await rejects(A, "select founder_create_recurring_cost($1, 'Tokyo office', 'office', null, 9999.5, 'JPY', 'monthly', '2026-01-01')", [rid()], "FS422", "recurring cost in JPY");
await rejects(A, "select founder_record_income($1, 'Tokyo client', 'one_time', null, 0.5, 'JPY', $2, 'bank_transfer', null)", [rid(), today], "FS422", "income in JPY");
await rejects(A, "select founder_record_cash_balance($1, 'Tokyo account', 1000.5, 'JPY', $2, null)", [rid(), today], "FS422", "cash in JPY");
await call(A, "founder_record_cash_balance($1, 'Tokyo account', 2500000, 'JPY', $2, null)", [rid(), today]);
assert.equal((await q("select amount::text a from founder_expenses where currency = 'JPY'"))[0].a, "15000.000", "stored exactly in major units");
for (const [t, col] of [["founder_expenses", "amount"], ["founder_recurring_costs", "amount"], ["founder_income_receipts", "amount"], ["founder_cash_balances", "balance"]]) {
  const extra = t === "founder_expenses" ? ", vendor, category, incurred_on" : t === "founder_recurring_costs" ? ", vendor, category, cadence, start_on" : t === "founder_income_receipts" ? ", payer, kind, received_on, received_via" : ", account_label, as_of";
  const vals = t === "founder_expenses" ? ", 'x', 'other', now()" : t === "founder_recurring_costs" ? ", 'x', 'other', 'monthly', now()" : t === "founder_income_receipts" ? ", 'x', 'other', now(), 'cash'" : ", 'x', now()";
  await db.exec("begin; select set_config('founder.finance_write', 'on', true);");
  await assert.rejects(q(`insert into ${t} (id, owner_id, ${col}, currency${extra}) values (gen_random_uuid(), $1, 10.5, 'JPY'${vals})`, [A]), (err) => err.code === "23514", `${t}: the table itself refuses a fractional JPY ${col}`);
  await db.exec("rollback");
}
console.log("ok  decimal places follow the currency (JPY 0, USD 2, KWD 3) in the functions and every table; unsupported currencies refused");

// --- 3. Recurring costs ------------------------------------------------------------------------------
const rc = rid();
await rejects(A, "select founder_create_recurring_cost($1, 'Google', 'software', null, 12, 'USD', 'weekly', '2026-09-15')", [rc], "FS422", "cadence must be monthly or annual");
await rejects(A, "select founder_create_recurring_cost($1, 'Google', 'software', null, 12, 'USD', 'monthly', null)", [rc], "FS422", "start date required");
await call(A, "founder_create_recurring_cost($1, 'Google Workspace', 'software', null, 12, 'USD', 'monthly', '2026-09-15')", [rc]);
assert.equal((await call(A, "founder_create_recurring_cost($1, 'x', 'other', null, 1, 'EUR', 'annual', '2020-01-01')", [rc])).status, "duplicate");
const pay = (uid, id, month, cur = "USD", amount = 12, cost = rc) =>
  call(uid, "founder_record_expense($1, 'Google Workspace', 'software', null, $2, $3, $4, null, $4, $5, $6)", [id, amount, cur, month, cost, month]);
const sepPay = rid();
await pay(A, sepPay, "2026-09-01");
await rejects(A, "select founder_record_expense($1, 'Google Workspace', 'software', null, 12, 'USD', '2026-09-20', null, '2026-09-20', $2, '2026-09-01')", [rid(), rc], "FS422", "a month is paid at most once");
await rejects(A, "select founder_record_expense($1, 'Google Workspace', 'software', null, 12, 'EUR', '2026-10-01', null, null, $2, '2026-10-01')", [rid(), rc], "FS422", "payment in the cost's currency");
await rejects(A, "select founder_record_expense($1, 'Google Workspace', 'software', null, 12, 'USD', '2026-08-01', null, null, $2, '2026-08-01')", [rid(), rc], "FS422", "month before the cost started");
await rejects(A, "select founder_record_expense($1, 'Google Workspace', 'software', null, 12, 'USD', '2026-10-01', null, null, $2, '2026-10-15')", [rid(), rc], "FS422", "covered month must be a month start");
await rejects(B, "select founder_record_expense($1, 'Google Workspace', 'software', null, 12, 'USD', '2026-10-01', null, null, $2, '2026-10-01')", [rid(), rc], "FS404", "another founder can't pay against it");
// Backstop: even a write that gets past the guard can't pay a month twice.
await db.exec("begin; select set_config('founder.finance_write', 'on', true);");
await assert.rejects(q("insert into founder_expenses (id, owner_id, recurring_cost_id, covers_month, vendor, category, amount, currency, incurred_on) values (gen_random_uuid(), $1, $2, '2026-09-01', 'x', 'software', 12, 'USD', '2026-09-01')", [A, rc]), (err) => err.code === "23505", "the unique index refuses a second live payment for the month");
await db.exec("rollback");
const cost = (await q("select * from founder_recurring_costs where id = $1", [rc]))[0];
await rejects(A, "select founder_correct_recurring_cost($1, $2, 'Google Workspace', 'software', null, null)", [rc, cost.updated_at], "FS422", "correction needs a reason");
await call(A, "founder_correct_recurring_cost($1, $2, 'Google Workspace Business', 'software', 'Two seats', 'Renamed plan')", [rc, cost.updated_at]);
const fixed = (await q("select amount, currency, cadence, start_on::text s from founder_recurring_costs where id = $1", [rc]))[0];
assert.deepEqual([fixed.amount, fixed.currency, fixed.cadence, fixed.s], ["12.000", "USD", "monthly", "2026-09-15"], "amount, currency, cadence and start can't be corrected");
await rejects(A, "select founder_void_recurring_cost($1, 'oops')", [rc], "FS422", "can't void a cost with live payments");
let cv = (await q("select updated_at from founder_recurring_costs where id = $1", [rc]))[0].updated_at;
await rejects(A, "select founder_end_recurring_cost($1, $2, '2026-09-01')", [rc, cv], "FS422", "can't end before it started");
const octPay = rid();
await pay(A, octPay, "2026-10-01");
await rejects(A, "select founder_end_recurring_cost($1, $2, '2026-09-30')", [rc, cv], "FS422", "can't end before a recorded payment's month");
await rejects(A, "select founder_end_recurring_cost($1, '2020-01-01', '2026-10-31')", [rc], "FS409", "stale end refused");
await call(A, "founder_end_recurring_cost($1, $2, '2026-10-31')", [rc, cv]);
assert.equal((await call(A, "founder_end_recurring_cost($1, $2, '2026-10-31')", [rc, cv])).status, "duplicate");
await rejects(A, "select founder_record_expense($1, 'Google Workspace', 'software', null, 12, 'USD', '2026-11-01', null, null, $2, '2026-11-01')", [rid(), rc], "FS422", "no payment after the cost ended");
await call(A, "founder_void_expense($1, 'Wrong month')", [octPay]);
await pay(A, rid(), "2026-10-01"); // a voided month can be recorded again
const rc2 = rid();
await call(A, "founder_create_recurring_cost($1, 'Old tool', 'software', null, 5, 'USD', 'annual', '2026-01-01')", [rc2]);
await call(A, "founder_void_recurring_cost($1, 'Never subscribed')", [rc2]);
await rejects(A, "select founder_record_expense($1, 'Old tool', 'software', null, 5, 'USD', '2026-02-01', null, null, $2, '2026-02-01')", [rid(), rc2], "FS422", "no payments against a voided cost");
console.log("ok  recurring costs: one payment per month, same currency, inside the active period; price fields fixed; ended once; void refused while payments exist");

// --- 4. Income received outside Stripe ----------------------------------------------------------------
const inc = rid();
await rejects(A, "select founder_record_income($1, 'Acme', 'recurring_fee', null, 1497, 'USD', $2, 'stripe', null)", [inc, today], "FS422", "Stripe payments can't be entered as manual income");
await rejects(A, "select founder_record_income($1, 'Acme', 'salary', null, 1497, 'USD', $2, 'bank_transfer', null)", [inc, today], "FS422", "unknown kind");
await rejects(A, "select founder_record_income($1, 'Acme', 'recurring_fee', null, 1497, 'USD', $2, 'bank_transfer', null)", [inc, tomorrow], "FS422", "received in the future");
await rejects(A, "select founder_record_income($1, 'Acme', 'recurring_fee', null, 0, 'USD', $2, 'bank_transfer', null)", [inc, today], "FS422", "zero amount");
await call(A, "founder_record_income($1, 'Acme Roofing', 'recurring_fee', 'October', 1497, 'USD', $2, 'bank_transfer', 'INV-1')", [inc, today]);
assert.equal((await call(A, "founder_record_income($1, 'x', 'other', null, 1, 'EUR', $2, 'cash', null)", [inc, today])).status, "duplicate");
let ir = (await q("select * from founder_income_receipts where id = $1", [inc]))[0];
assert.deepEqual([ir.source, ir.received_via], ["manual", "bank_transfer"], "kept separately identifiable from Stripe");
await rejects(A, "select founder_correct_income($1, $2, 'Acme Roofing', 'recurring_fee', 'October', 1497, 'USD', $3, 'stripe', 'INV-1', 'via')", [inc, ir.updated_at, today], "FS422", "a correction can't make it Stripe");
await rejects(A, "select founder_correct_income($1, $2, 'Acme Roofing', 'recurring_fee', 'October', 1497, 'USD', $3, 'bank_transfer', 'INV-1', 'same')", [inc, ir.updated_at, today], "FS422", "a no-op correction is refused");
await rejects(B, "select founder_correct_income($1, $2, 'Acme', 'one_time', null, 1, 'USD', $3, 'cash', null, 'mine')", [inc, ir.updated_at, today], "FS404", "another founder can't correct it");
await call(A, "founder_correct_income($1, $2, 'Acme Roofing', 'recurring_fee', 'October', 1490, 'USD', $3, 'bank_transfer', 'INV-1', 'Bank fee deducted')", [inc, ir.updated_at, today]);
await rejects(A, "select founder_correct_income($1, $2, 'Acme Roofing', 'recurring_fee', 'October', 1, 'USD', $3, 'bank_transfer', 'INV-1', 'stale')", [inc, ir.updated_at, today], "FS409", "stale correction refused");
await call(A, "founder_void_income($1, 'Duplicate of Stripe payment')", [inc]);
assert.equal(await count("founder_income_receipts", "id = $1 and voided_at is not null", [inc]), 1);
console.log("ok  manual income: never Stripe, validated, idempotent, corrected with reason, voided not deleted");

// --- 5. Cash balances --------------------------------------------------------------------------------
const cash = rid();
await rejects(A, "select founder_record_cash_balance($1, 'Checking', 1000, 'USD', $2, null)", [cash, tomorrow], "FS422", "balance dated in the future");
await rejects(A, "select founder_record_cash_balance($1, ' ', 1000, 'USD', $2, null)", [cash, today], "FS422", "account name required");
await rejects(A, "select founder_record_cash_balance($1, 'Checking', 10.001, 'USD', $2, null)", [cash, today], "FS422", "sub-cent balance");
await call(A, "founder_record_cash_balance($1, 'Checking', 25000.50, 'USD', $2, 'Statement')", [cash, today]);
await call(A, "founder_record_cash_balance($1, 'Overdraft line', -120, 'USD', $2, null)", [rid(), today]);
assert.equal((await call(A, "founder_record_cash_balance($1, 'x', 1, 'EUR', $2, null)", [cash, today])).status, "duplicate");
assert.equal((await q("select count(*)::int n from pg_proc where proname like 'founder_correct_cash%'"))[0].n, 0, "no cash correction function: a new balance supersedes");
await call(A, "founder_void_cash_balance($1, 'Wrong account')", [cash]);
await rejects(B, "select founder_void_cash_balance($1, 'mine')", [cash], "FS404", "another founder can't void it");
await rejects(B, "select founder_create_recurring_cost($1, 'x', 'other', null, 1, 'USD', 'monthly', '2026-01-01')", [rc], "FS422", "another founder can't reuse a recurring cost's request id");
await rejects(B, "select founder_record_income($1, 'x', 'other', null, 1, 'USD', $2, 'cash', null)", [inc, today], "FS422", "another founder can't reuse an income request id");
await rejects(B, "select founder_record_cash_balance($1, 'x', 1, 'USD', $2, null)", [cash, today], "FS422", "another founder can't reuse a cash request id");
console.log("ok  cash balances: entered only, never derived; append-only; overdraft allowed; voided with reason");

// --- 6. Guards: nothing changes or disappears outside the functions, even for the service role --------
for (const t of TABLES.slice(0, 4)) {
  await rejects(null, `insert into ${t} (id, owner_id) values (gen_random_uuid(), $1)`, [A], "FS403", `service role can't insert into ${t} unaudited`, "service_role");
  await rejects(null, `update ${t} set updated_at = now() where owner_id = $1`, [A], "FS403", `service role can't update ${t}`, "service_role");
  await rejects(null, `delete from ${t} where owner_id = $1`, [A], "FS403", `service role can't delete from ${t}`, "service_role");
}
// A DELETE arriving one trigger level down (as a cascade would) is refused too - records and history alike.
for (const [table, column] of [["founder_expenses", "id"], ["founder_cash_balances", "id"], ["founder_finance_events", "entity_id"]]) {
  await db.exec(`create table public.zz_cascade_probe (id uuid primary key);
    create function public.zz_cascade_probe_fn() returns trigger language plpgsql as $$ begin delete from public.${table} where ${column} = old.id; return old; end $$;
    create trigger zz_cascade_probe after delete on public.zz_cascade_probe for each row execute function public.zz_cascade_probe_fn();`);
  await q("insert into zz_cascade_probe values ($1)", [table === "founder_cash_balances" ? cash : exp1]);
  const before = await count(table);
  await assert.rejects(q("delete from zz_cascade_probe"), (err) => err.code === "FS403", `a nested (cascade-like) delete from ${table} is refused`);
  assert.equal(await count(table), before);
  await db.exec("drop table public.zz_cascade_probe; drop function public.zz_cascade_probe_fn();");
}
await rejects(null, "update founder_finance_events set reason = 'x'", [], "FS403", "audit history can't be edited", "service_role");
await rejects(null, "delete from founder_finance_events", [], "FS403", "audit history can't be deleted", "service_role");
await rejects(null, "insert into founder_finance_events (owner_id, entity, entity_id, action) values ($1, 'expense', gen_random_uuid(), 'created')", [A], "FS403", "audit history can't be forged", "service_role");
await db.exec("begin; select set_config('founder.finance_write', 'on', true);");
await assert.rejects(q("update founder_expenses set amount = 1 where id = $1", [exp1]), /voided record can't be changed/, "even with the flag, a voided row is frozen");
await db.exec("rollback");
await db.exec("begin; select set_config('founder.finance_write', 'on', true);");
await assert.rejects(q("update founder_cash_balances set owner_id = $1 where account_label = 'Overdraft line'", [B]), /owner, created time and source are fixed/, "even with the flag, the owner can't move");
await db.exec("rollback");
await db.exec("begin; select set_config('founder.finance_write', 'on', true);");
await assert.rejects(q("update founder_cash_balances set source = 'stripe' where account_label = 'Overdraft line'"), /fixed|check constraint/, "or the source");
await db.exec("rollback");
// Backstop: the table itself refuses Stripe as a manual-income method, even past the guard.
await db.exec("begin; select set_config('founder.finance_write', 'on', true);");
await assert.rejects(q("insert into founder_income_receipts (id, owner_id, payer, kind, amount, currency, received_on, received_via) values (gen_random_uuid(), $1, 'Acme', 'recurring_fee', 10, 'USD', '2026-10-01', 'stripe')", [A]), (err) => err.code === "23514", "received_via can't be stripe at the table level");
await db.exec("rollback");
console.log("ok  guard: no unaudited insert, update or delete (service role too); history can't be edited, deleted or forged; voided rows frozen");

// --- 7. Isolation and audit completeness ------------------------------------------------------------
await as(B, async () => {
  for (const t of TABLES) assert.equal((await q(`select count(*)::int n from ${t}`))[0].n, 0, `founder B sees none of A's ${t}`);
});
await as(ADM, async () => {
  for (const t of TABLES) assert.equal((await q(`select count(*)::int n from ${t}`))[0].n, 0, `agency admin sees no ${t}`);
});
const mine = await as(A, async () => (await q("select count(*)::int n from founder_expenses"))[0].n);
assert.equal(mine, await count("founder_expenses", "owner_id = $1", [A]));
const unaudited = await q(`
  select 'expense' e, id from founder_expenses x where not exists (select 1 from founder_finance_events v where v.entity_id = x.id and v.action = 'created')
  union all select 'cost', id from founder_recurring_costs x where not exists (select 1 from founder_finance_events v where v.entity_id = x.id and v.action = 'created')
  union all select 'income', id from founder_income_receipts x where not exists (select 1 from founder_finance_events v where v.entity_id = x.id and v.action = 'created')
  union all select 'cash', id from founder_cash_balances x where not exists (select 1 from founder_finance_events v where v.entity_id = x.id and v.action = 'created')`);
assert.deepEqual(unaudited, [], "every record has a creation event");
const voidedNoEvent = await q("select id from founder_expenses x where voided_at is not null and not exists (select 1 from founder_finance_events v where v.entity_id = x.id and v.action = 'voided')");
assert.deepEqual(voidedNoEvent, []);
console.log("ok  founders see only their own records (agency admins none); every record and void is in the audit history");

// --- 8. Stripe revenue summary: founder-only, aggregate-only, read-only ----------------------------------
await as(A, async () => assert.equal((await q("select count(*)::int n from revenue_events"))[0].n, 0, "the founder still can't read revenue_events rows"));
const cols = (await q("select string_agg(a, ',' order by o) c from unnest((select proargnames from pg_proc where proname = 'founder_stripe_revenue_summary')) with ordinality t(a, o)"))[0].c;
assert.doesNotMatch(cols, /organization|provider|customer|event_id|metadata/, "no ids or rows returned");
await rejects(A, "select * from founder_stripe_revenue_summary('2026-10-01', '2026-01-01')", [], "FS422", "period must be forward");
await rejects(A, "select * from founder_stripe_revenue_summary('2020-01-01', '2026-01-01')", [], "FS422", "period capped at 3 years");
// Stripe exponents: only USD is verified; everything else is NULL / unverified - no default.
assert.deepEqual(
  (await q("select founder_stripe_verified_exponent('USD') usd, founder_stripe_verified_exponent('usd') lower, founder_stripe_verified_exponent('JPY') jpy, founder_stripe_verified_exponent('KWD') kwd, founder_stripe_verified_exponent('EUR') eur, founder_stripe_verified_exponent('ISK') isk, founder_stripe_verified_exponent(null) none"))[0],
  { usd: 2, lower: 2, jpy: null, kwd: null, eur: null, isk: null, none: null },
);
const SUMMARY = "select month::text, currency, collected::int, recurring_collected::int rc, uncategorized_collected::int uc, refunded::int, succeeded_payments sp, failed_attempts fa, invoices_with_failed_attempts fi, failed_attempted_amount::int famt, minor_unit_exponent e, exponent_status st from founder_stripe_revenue_summary('2026-08-01', '2026-12-01')";
// Manual income must never reach the Stripe totals: record some, read, change it, read again.
await call(A, "founder_record_income($1, 'Acme Roofing', 'recurring_fee', null, 1497, 'USD', $2, 'bank_transfer', null)", [rid(), today]);
await call(A, "founder_record_income($1, 'Tokyo client', 'setup_fee', null, 50000, 'JPY', $2, 'bank_transfer', null)", [rid(), today]);
const unrecoveredBefore = await as(A, () => q("select currency, unrecovered_invoices, amount_due_latest_attempt::int a from founder_stripe_unrecovered_invoices()"));
const rows = await as(A, () => q(SUMMARY));
const U = { e: null, st: "unverified" };
const V = { e: 2, st: "verified" };
const z = { collected: 0, rc: 0, uc: 0, refunded: 0, sp: 0, fa: 0, fi: 0, famt: 0 };
assert.deepEqual(rows, [
  { month: "2026-09-01", currency: "CAD", ...z, fa: 2, fi: 2, famt: 60000, ...U },
  { month: "2026-09-01", currency: "USD", ...z, collected: 399800, rc: 100, uc: 399700, sp: 2, ...V },
  { month: "2026-10-01", currency: "CAD", ...z, collected: 50000, rc: 50000, sp: 2, fa: 5, fi: 4, famt: 175000, ...U },
  { month: "2026-10-01", currency: "EUR", ...z, collected: 90000, rc: 90000, sp: 1, ...U },
  { month: "2026-10-01", currency: "ISK", ...z, collected: 990000, rc: 990000, sp: 1, ...U },
  { month: "2026-10-01", currency: "JPY", ...z, collected: 5000, rc: 5000, sp: 1, ...U },
  { month: "2026-10-01", currency: "KWD", ...z, collected: 12340, rc: 12340, sp: 1, ...U },
  { month: "2026-10-01", currency: "USD", ...z, collected: 449100, rc: 449100, refunded: 60000, sp: 3, fa: 6, fi: 3, famt: 429100, ...V },
], "period figures only: collected from successful payments (cash basis); refunds apart (even one carrying a category); failed attempts and invoices counted when they happened, each invoice once per month at its latest attempt, whether or not later paid; currencies never mixed; exponent only where verified; months in the founder's time zone; no manual income");
for (const r of rows) if (r.st !== "verified") assert.equal(r.e, null, `${r.currency}: an unverified exponent is never populated`);
await call(A, "founder_record_income($1, 'Another client', 'one_time', null, 999, 'USD', $2, 'check', null)", [rid(), today]);
assert.deepEqual(await as(A, () => q(SUMMARY)), rows, "adding manual income changes nothing in the Stripe totals");
assert.deepEqual(await as(A, () => q("select currency, unrecovered_invoices, amount_due_latest_attempt::int a from founder_stripe_unrecovered_invoices()")), unrecoveredBefore, "or in unrecovered invoices");
const bodies = (await q("select string_agg(prosrc, ' ') b from pg_proc where proname in ('founder_stripe_revenue_summary', 'founder_stripe_unrecovered_invoices', 'founder_contracted_mrr')"))[0].b;
assert.doesNotMatch(bodies, /founder_income_receipts|founder_expenses|founder_cash_balances/, "the aggregate reads never touch manual records");
for (const fn of ["founder_stripe_revenue_summary", "founder_stripe_unrecovered_invoices", "founder_contracted_mrr"]) {
  const [p] = await q("select prosecdef, array_to_string(proconfig, ';') cfg, proacl::text acl, array_to_string(proargnames, ',') args from pg_proc where proname = $1", [fn]);
  assert.equal(p.prosecdef, true);
  assert.equal(p.cfg, 'search_path=""', `${fn} pins an empty search_path`);
  assert.doesNotMatch(p.acl, /(^|[{,])=X|anon=X/, `${fn}: no execute for PUBLIC or anon`);
  assert.match(p.acl, /authenticated=X/);
  assert.doesNotMatch(p.args ?? "", /organization|provider|customer|event_id|metadata|name|contact|scope/, `${fn}: totals only`);
}
const utc = await as(B, () => q("select month::text, collected::int from founder_stripe_revenue_summary('2026-09-01', '2026-11-01') where currency = 'USD' order by month"));
assert.deepEqual(utc, [{ month: "2026-09-01", collected: 399700 }, { month: "2026-10-01", collected: 449200 }], "another founder's time zone (UTC) puts the edge payment in October");
// Boundary: the Oct 1-15 (Denver) period counts only what happened inside it.
const inPeriod = await as(A, () => q("select collected::int, succeeded_payments sp, failed_attempts fa, invoices_with_failed_attempts fi, failed_attempted_amount::int famt from founder_stripe_revenue_summary('2026-10-01T06:00:00Z', '2026-10-16T06:00:00Z') where currency = 'CAD'"));
assert.deepEqual(inPeriod, [{ collected: 20000, sp: 1, fa: 3, fi: 3, famt: 120000 }],
  "inside: the recovery of a failure from before (collected), and the in-period failures of in_in_post (paid after), in_in_open (failed again after) and in_pre_open (failed before too) - not the pre- or post-period attempts");
// Current recovery status: independent of any period, measured now.
const open = await as(A, () => q("select currency, unrecovered_invoices n, amount_due_latest_attempt::int a, earliest_failure_at::text f, latest_failure_at::text l, minor_unit_exponent e, exponent_status st, measured_at is not null m from founder_stripe_unrecovered_invoices()"));
assert.deepEqual(open, [
  { currency: "CAD", n: 3, a: 145000, f: "2026-09-28 15:00:00+00", l: "2026-10-30 15:00:00+00", e: null, st: "unverified", m: true },
  { currency: "USD", n: 1, a: 129700, f: "2026-10-06 15:00:00+00", l: "2026-10-09 15:00:00+00", e: 2, st: "verified", m: true },
], "unrecovered now: failed before/inside/after the period and never paid (latest attempt amount); recovered invoices (in_pre_rec, in_in_post, in_late, in_retry) are excluded wherever their payment fell");
console.log("ok  Stripe reads: founder only, totals only; the summary counts only what happened in the period (cash basis unchanged, failures per invoice id when they happened) and the unrecovered read is a current status, tested across the period boundary; refunds never attributed; exponent only where verified (USD), NULL/unverified otherwise; manual income never included; revenue_events untouched");

// --- 9. Contracted fees: founder-only, aggregate-only --------------------------------------------------
async function agencyClient(name, fee, cur, status) {
  const id = rid();
  await db.exec("begin; select set_config('agency.delivery_write', 'on', true);");
  await q("insert into agency_clients (id, name, contact_name, contact_email, setup_fee, monthly_fee, currency, scope, status) values ($1, $2, 'Dana', 'd@x.test', 2500, $3, $4, 'Lead response and reporting', 'onboarding_not_started')", [id, name, fee, cur]);
  if (status !== "onboarding_not_started") await q("update agency_clients set status = $2, status_changed_at = now() where id = $1", [id, status]);
  await db.exec("commit");
}
await agencyClient("Live USD", 1497, "USD", "live");
await agencyClient("Ongoing USD", 997, "USD", "ongoing_management");
await agencyClient("Live EUR", 900, "EUR", "live");
await agencyClient("Onboarding", 5000, "USD", "onboarding");
const mrr = await as(A, () => q("select currency, monthly_total::text m, setup_total::text s, client_count c from founder_contracted_mrr()"));
assert.deepEqual(mrr, [{ currency: "EUR", m: "900.00", s: "2500.00", c: 1 }, { currency: "USD", m: "2494.00", s: "5000.00", c: 2 }], "live + ongoing only, per currency");
const mcols = (await q("select string_agg(a, ',') c from unnest((select proargnames from pg_proc where proname = 'founder_contracted_mrr')) a"))[0].c;
assert.doesNotMatch(mcols ?? "", /name|id|contact|scope/, "no client names or ids");
await as(A, async () => assert.equal((await q("select count(*)::int n from agency_clients"))[0].n, 0, "the founder still can't read agency_clients rows"));
await rejects(C, "select * from founder_contracted_mrr()", [], "FS404", "contractor/non-founder refused");
await rejects(ADM, "select * from founder_contracted_mrr()", [], "FS404", "agency admin refused");
await rejects(null, "select * from founder_contracted_mrr()", [], "42501", "signed-out refused", "anon");
console.log("ok  contracted fees: founder only, live/ongoing clients only, per currency, no names; agency_clients still Agency-only");

// --- 10. Rollback: functions gone, every record kept and read-only, re-apply works --------------------------
const counts = async () => Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, await count(t)])));
const before = await counts();
const fpBefore = await Promise.all(TABLES.map(fingerprint));
const dataBeforeRollback = await otherData();
await db.exec(rollback);
await db.exec(rollback);
assert.deepEqual(await protections(), protectionsApplied, "rollback twice keeps every check (currency decimals included), RESTRICT key, unique index, guard trigger, policy and grant, and the currency lookup");
assert.deepEqual(await counts(), before, "rollback keeps every row");
assert.deepEqual(await Promise.all(TABLES.map(fingerprint)), fpBefore, "and every value");
const left = (await q("select string_agg(proname, ',' order by proname) l from pg_proc where proname like 'founder_%' and (proname like any (array['founder_record_%', 'founder_mark_expense_paid', 'founder_correct_%', 'founder_void_%', 'founder_create_recurring_cost', 'founder_end_recurring_cost', 'founder_stripe_%', 'founder_contracted_mrr', 'founder_finance_%']) and proname not in ('founder_finance_rows_guard', 'founder_finance_events_guard', 'founder_void_deal_activity'))"))[0].l;
assert.equal(left, null, `every finance function is removed (left: ${left})`);
await rejects(A, "select founder_record_expense($1, 'x', 'other', null, 1, 'USD', $2, null, null, null, null)", [rid(), today], "42883", "write functions removed");
await rejects(A, "select * from founder_stripe_revenue_summary('2026-01-01', '2027-01-01')", [], "42883", "summary removed");
await rejects(A, "select * from founder_stripe_unrecovered_invoices()", [], "42883", "unrecovered read removed");
await rejects(null, "delete from founder_expenses", [], "FS403", "records still can't be deleted after rollback", "service_role");
await rejects(null, "insert into founder_cash_balances (id, owner_id, account_label, balance, currency, as_of) values (gen_random_uuid(), $1, 'x', 1, 'USD', now())", [A], "FS403", "or written", "service_role");
await as(B, async () => assert.equal((await q("select count(*)::int n from founder_expenses"))[0].n, 0, "RLS still isolates after rollback"));
assert.equal((await q("select founder_currency_minor_units('JPY') e"))[0].e, 0, "the currency lookup the tables depend on is kept");
await db.exec("begin; select set_config('founder.finance_write', 'on', true);");
await assert.rejects(q("insert into founder_cash_balances (id, owner_id, account_label, balance, currency, as_of) values (gen_random_uuid(), $1, 'x', 10.5, 'JPY', now())", [A]), (err) => err.code === "23514", "decimal-place checks still in force after rollback");
await db.exec("rollback");
assert.equal(await fingerprint("founder_mrr_entries"), mrrBefore);
assert.equal(await fingerprint("revenue_events"), revenueBefore);
assert.deepEqual(await otherData(), dataBeforeRollback, "rollback changes no other table");
assert.deepEqual(await catalog(), catalogBefore, "rollback leaves every existing policy and grant as it was");
await db.exec(forward);
assert.deepEqual(await protections(), protectionsApplied, "re-apply restores nothing weaker and adds nothing unexpected");
await db.exec(forward);
assert.deepEqual(await protections(), protectionsApplied, "and applying again is a no-op");
assert.deepEqual(await counts(), before, "re-apply keeps every row");
await rejects(A, "select founder_record_expense($1, 'x', 'other', null, 10.5, 'JPY', $2, null, null, null, null)", [rid(), today], "FS422", "after re-apply, the functions still refuse fractional JPY");
await db.exec("begin; select set_config('founder.finance_write', 'on', true);");
await assert.rejects(q("insert into founder_income_receipts (id, owner_id, payer, kind, amount, currency, received_on, received_via) values (gen_random_uuid(), $1, 'x', 'other', 1.5, 'JPY', now(), 'cash')", [A]), (err) => err.code === "23514", "and so does the table");
await db.exec("rollback");
assert.deepEqual(await otherData(), dataBeforeRollback, "re-apply changes no other table");
assert.deepEqual(await catalog(), catalogBefore, "re-apply leaves every existing policy and grant as it was");
await call(A, "founder_record_cash_balance($1, 'Checking', 24000, 'USD', $2, null)", [rid(), today]);
console.log("ok  applied twice, rolled back twice, re-applied twice: functions removed then restored; every record, history, currency check, RESTRICT key, guard, policy and grant unchanged throughout; currency lookup never dropped");

// --- 11. A founder account with financial records can't be deleted ------------------------------------
const fks = await q("select conrelid::regclass::text t, confdeltype d from pg_constraint where contype = 'f' and confrelid = 'auth.users'::regclass and conrelid::regclass::text = any($1) order by 1", [FINANCE.map((t) => `founder_${t.slice(8)}`).map((t) => t)]);
assert.equal(fks.length, 5);
for (const fk of fks) assert.equal(fk.d, "r", `${fk.t}: owner is ON DELETE RESTRICT`);
const ownerPrint = (uid) => Promise.all(TABLES.map(async (t) => (await q(`select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) h from ${t} x where owner_id = $1`, [uid]))[0].h));
const snapshot = await ownerPrint(A);
const blocked = await q("delete from auth.users where id = $1", [A]).then(() => null, (e) => e);
assert.equal(blocked?.code, "23001", "deleting the founder's account is refused while records exist");
assert.equal(await count("auth.users", "id = $1", [A]), 1);
assert.deepEqual(await ownerPrint(A), snapshot, "and nothing was removed");
// Even when every record is voided (only history left), the account stays protected.
const D = "dddddddd-0000-4000-8000-000000000000";
await q("insert into auth.users (id, email) values ($1, 'founder3@x.test')", [D]);
await q("insert into founder_users (user_id) values ($1)", [D]);
const dCash = rid();
await call(D, "founder_record_cash_balance($1, 'Old account', 10, 'USD', $2, null)", [dCash, today]);
await call(D, "founder_void_cash_balance($1, 'Closed')", [dCash]);
assert.equal((await q("delete from auth.users where id = $1", [D]).then(() => null, (e) => e))?.code, "23001", "voided records and history still block deletion");
// Removing someone from the founder allow-list is allowed: records stay, access goes.
await q("delete from founder_users where user_id = $1", [A]);
assert.deepEqual(await ownerPrint(A), snapshot, "records kept when founder access is removed");
await as(A, async () => assert.equal((await q("select count(*)::int n from founder_expenses"))[0].n, 0, "an ex-founder reads nothing"));
await rejects(A, "select founder_record_cash_balance($1, 'x', 1, 'USD', $2, null)", [rid(), today], "FS404", "and can't write");
await q("insert into founder_users (user_id, timezone) values ($1, 'America/Denver')", [A]);
// An account with no financial records is unaffected.
await q("delete from auth.users where id = $1", [C]);
console.log("ok  founder accounts with financial records or history can't be deleted (RESTRICT + no-delete trigger, no cascade); removing founder access keeps records; other accounts unaffected");

console.log("all founder finance checks passed");

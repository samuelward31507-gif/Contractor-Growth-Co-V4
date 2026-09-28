// Disposable validation harness for supabase/pending/invoice_foundation.sql.
//
// Boots an in-memory Postgres 17 (PGlite), creates the smallest stand-ins
// for the production objects the migration depends on (auth.uid(),
// is_org_member, is_org_admin, organization_payment_active, set_updated_at,
// and the tables merge_contacts and the triggers reference), then:
//
//   1. applies the forward migration
//   2. applies it AGAIN and proves the object inventory is unchanged
//   3. exercises every rule (numbering, cancelled job, one live invoice per
//      job, forced draft shape, frozen totals, amount_paid guard, issue
//      stamps + default due date in org timezone, payments, overpayment,
//      reversals, immutability, void, delete, RLS + payment gate, audit RPC,
//      merge_contacts reassignment)
//   4. runs the rollback and proves everything is gone and merge_contacts is
//      byte-identical to the captured production body
//   5. applies the forward migration once more
//
// It never opens a network connection. Run: npm run validate
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pending = path.resolve(here, "..");
const forward = readFileSync(path.join(pending, "invoice_foundation.sql"), "utf8");
const rollback = readFileSync(path.join(pending, "invoice_foundation_rollback.sql"), "utf8");
const captured = readFileSync(path.join(pending, "reference", "merge_contacts.production.sql"), "utf8");
const capturedBody = captured.slice(captured.indexOf("CREATE OR REPLACE FUNCTION public.merge_contacts"));

const db = new PGlite();
let passed = 0;
let failed = 0;
const failures = [];

async function q(sql, params = []) {
  const r = await db.query(sql, params);
  return r.rows;
}
async function one(sql, params = []) {
  return (await q(sql, params))[0];
}
async function expectError(label, sql, params, pattern) {
  try {
    // Multi-statement scripts (the rollback file) cannot go through the
    // extended protocol; exec uses the simple protocol.
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

// ---------------------------------------------------------------------------
// Stand-ins for production objects (shape only, enough for the rules)
// ---------------------------------------------------------------------------
const STUBS = `
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
create table public.opportunities (contact_id uuid);
create table public.conversations (id uuid primary key default gen_random_uuid(), contact_id uuid, channel text, status text);
${capturedBody};
create role authenticated nologin;
create role service_role nologin;
grant usage on schema public to authenticated, service_role;
grant select on public.organizations, public.contacts, public.jobs, public.estimates to authenticated;
`;

async function inventory() {
  return one(`select
    (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname='public' and c.relname in ('invoices','customer_payments')) as tables,
    (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid where not t.tgisinternal and c.relname in ('invoices','customer_payments')) as triggers,
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname in ('invoices_guard_insert','invoices_guard_update','invoices_guard_delete','customer_payments_guard_insert','customer_payments_apply','customer_payments_immutable','create_invoice_audit_event')) as functions,
    (select count(*) from pg_policies where tablename in ('invoices','customer_payments')) as policies,
    (select count(*) from pg_indexes where tablename in ('invoices','customer_payments')) as indexes,
    (select md5(pg_get_functiondef('public.merge_contacts'::regproc))) as merge_md5`);
}

async function main() {
  console.log("PGlite:", (await one("select version() v")).v.split(",")[0]);
  await db.exec(STUBS);
  const capturedMd5 = createHash("md5").update(capturedBody).digest("hex");
  const liveMd5 = (await one("select md5(pg_get_functiondef('public.merge_contacts'::regproc)) m")).m;
  check("captured merge_contacts body compiles to the same definition text (md5 matches production 16eb8b65…)", liveMd5 === capturedMd5 && capturedMd5 === "16eb8b6540778969e6d489953494c44b", `${liveMd5} vs ${capturedMd5}`);

  console.log("\n[1] apply forward migration");
  await db.exec(forward);
  const inv1 = await inventory();
  check("tables=2 triggers=7 functions=7 policies=7", inv1.tables === 2 && inv1.triggers === 7 && inv1.functions === 7 && inv1.policies === 7, JSON.stringify(inv1));

  console.log("\n[2] apply forward migration again (idempotency)");
  await db.exec(forward);
  const inv2 = await inventory();
  check("second apply leaves the inventory unchanged", JSON.stringify(inv1) === JSON.stringify(inv2), JSON.stringify(inv2));
  check("merge_contacts differs from production body (new blocks present)", inv2.merge_md5 !== capturedMd5);
  const mergeDef = (await one("select pg_get_functiondef('public.merge_contacts'::regproc) d")).d;
  check("new merge_contacts contains the invoices and customer_payments blocks", mergeDef.includes("update public.invoices set contact_id") && mergeDef.includes("update public.customer_payments set contact_id"));
  check("new merge_contacts keeps every production block", ["ai_interactions", "appointments", "estimates", "jobs", "leads", "referral_requests", "review_requests", "opportunities", "conversations", "contact_merged"].every((s) => mergeDef.includes(s)));

  console.log("\n[3] fixtures");
  const orgA = (await one("insert into organizations (name, timezone) values ('Org A','America/Denver') returning id")).id;
  const orgB = (await one("insert into organizations (name, timezone) values ('Org B','UTC') returning id")).id;
  const userA = "11111111-1111-1111-1111-111111111111";
  const userB = "22222222-2222-2222-2222-222222222222";
  await q("insert into organization_members values ($1,$2,'owner'),($3,$4,'owner')", [orgA, userA, orgB, userB]);
  await q("select set_config('trackpr.test_uid', $1, false)", [userA]);
  const contactA = (await one("insert into contacts (organization_id, first_name) values ($1,'Ann') returning id", [orgA])).id;
  const contactA2 = (await one("insert into contacts (organization_id, first_name) values ($1,'Ann Dup') returning id", [orgA])).id;
  const contactB = (await one("insert into contacts (organization_id, first_name) values ($1,'Bob') returning id", [orgB])).id;
  const estA = (await one("insert into estimates (organization_id, contact_id) values ($1,$2) returning id", [orgA, contactA])).id;
  const jobA1 = (await one("insert into jobs (organization_id, contact_id, estimate_id, title, amount, status) values ($1,$2,$3,'Roof',1300.25,'completed') returning id", [orgA, contactA, estA])).id;
  const jobA2 = (await one("insert into jobs (organization_id, contact_id, title, amount, status) values ($1,$2,'Gutters',null,'scheduled') returning id", [orgA, contactA2])).id;
  const jobACancelled = (await one("insert into jobs (organization_id, contact_id, title, status) values ($1,$2,'Cancelled one','cancelled') returning id", [orgA, contactA])).id;
  const jobB1 = (await one("insert into jobs (organization_id, contact_id, title, amount, status) values ($1,$2,'B job',500,'in_progress') returning id", [orgB, contactB])).id;
  pass("fixtures created");

  console.log("\n[4] invoice creation, numbering, relationships, forced draft");
  const inv1row = await one(
    "insert into invoices (organization_id, job_id, title, subtotal, total, status, amount_paid, contact_id, issued_at) values ($1,$2,'Roof invoice',1300.25,1300.25,'paid',999,$3,now()) returning *",
    [orgA, jobA1, contactB],
  );
  check("first invoice for org A is number 1", inv1row.number === 1, String(inv1row.number));
  check("client-supplied status/amount_paid/issued_at/contact are overridden to the draft shape", inv1row.status === "draft" && Number(inv1row.amount_paid) === 0 && inv1row.issued_at === null && inv1row.contact_id === contactA, JSON.stringify(inv1row));
  check("estimate_id copied from job", inv1row.estimate_id === estA);
  check("created_by is auth.uid()", inv1row.created_by === userA);
  check("balance_due generated = total", Number(inv1row.balance_due) === 1300.25);
  const inv2row = await one("insert into invoices (organization_id, job_id, title, subtotal, total) values ($1,$2,'Gutters invoice',400,400) returning *", [orgA, jobA2]);
  check("second invoice for org A is number 2", inv2row.number === 2);
  const invBrow = await one("insert into invoices (organization_id, job_id, title, subtotal, total) values ($1,$2,'B invoice',500,500) returning *", [orgB, jobB1]);
  check("first invoice for org B is number 1 (organization-scoped sequence)", invBrow.number === 1);
  await expectError("cancelled job cannot receive an invoice", "insert into invoices (organization_id, job_id, title, subtotal, total) values ($1,$2,'x',1,1)", [orgA, jobACancelled], /cancelled job/i);
  await expectError("job from another organization is rejected", "insert into invoices (organization_id, job_id, title, subtotal, total) values ($1,$2,'x',1,1)", [orgA, jobB1], /same organization/i);
  await expectError("one live invoice per job (duplicate rejected)", "insert into invoices (organization_id, job_id, title, subtotal, total) values ($1,$2,'dup',1,1)", [orgA, jobA1], /invoices_one_live_per_job|duplicate key/i);
  const jobB3 = (await one("insert into jobs (organization_id, title, status) values ($1,'B job 3','scheduled') returning id", [orgB])).id;
  await expectError("total must equal subtotal + tax", "insert into invoices (organization_id, job_id, title, subtotal, tax_amount, total) values ($1,$2,'x',100,5,100)", [orgB, jobB3], /invoices_total_matches_parts|check constraint/i);
  const rounded = await one("insert into invoices (organization_id, job_id, title, subtotal, total) values ($1,$2,'precision',0.005,0.005) returning total", [orgB, (await one("insert into jobs (organization_id, title, status) values ($1,'B job 2','scheduled') returning id", [orgB])).id]);
  check("numeric(12,2) stores two decimals (sub-cent input is rounded by Postgres, so the app must reject it)", Number(rounded.total) === 0.01, String(rounded.total));

  console.log("\n[5] draft edits, frozen totals, issue stamps");
  await q("update invoices set subtotal = 1400, total = 1400 where id = $1", [inv1row.id]);
  check("draft totals can be edited", Number((await one("select total from invoices where id=$1", [inv1row.id])).total) === 1400);
  await expectError("amount_paid cannot be set directly", "update invoices set amount_paid = 10 where id = $1", [inv1row.id], /maintained by customer payments/i);
  await expectError("paid_at cannot be set directly", "update invoices set paid_at = now() where id = $1", [inv1row.id], /maintained by customer payments/i);
  await expectError("issued_at cannot be set while draft", "update invoices set issued_at = now() where id = $1", [inv1row.id], /set by issuing/i);
  await expectError("draft -> paid is not a legal manual transition", "update invoices set status = 'paid' where id = $1", [inv1row.id], /invalid invoice status transition/i);
  await q("select set_config('timezone', 'UTC', false)");
  const issued = await one("update invoices set status = 'sent' where id = $1 returning *, due_date::text as due_date_text", [inv1row.id]);
  check("issue stamps issued_at and sent_at", issued.issued_at !== null && issued.sent_at !== null);
  const expectedDue = (await one("select ((now() at time zone 'America/Denver')::date + 14)::text d")).d;
  check(`default due_date = issue date in org timezone + 14 (${expectedDue})`, issued.due_date_text === expectedDue, String(issued.due_date_text));
  await expectError("totals are frozen after issue", "update invoices set subtotal = 1500, total = 1500 where id = $1", [inv1row.id], /frozen/i);
  await q("update invoices set due_date = '2026-12-31', notes = 'ok to edit' where id = $1", [inv1row.id]);
  pass("due_date and notes remain editable after issue");
  await expectError("sent -> draft is not allowed", "update invoices set status = 'draft' where id = $1", [inv1row.id], /invalid invoice status transition/i);
  await expectError("identity columns are immutable", "update invoices set number = 99 where id = $1", [inv1row.id], /immutable/i);

  console.log("\n[6] payments: partial, full, overpayment, wrong status");
  await expectError("payment on a draft invoice is rejected", "insert into customer_payments (organization_id, invoice_id, amount, method) values ($1,$2,10,'cash')", [orgA, inv2row.id], /issued, unpaid invoice/i);
  const p1 = await one("insert into customer_payments (organization_id, invoice_id, amount, method, reference, job_id, contact_id) values ($1,$2,400,'check','#1001',$3,$4) returning *", [orgA, inv1row.id, jobB1, contactB]);
  check("payment copies job_id/contact_id from the invoice, ignoring client values", p1.job_id === jobA1 && p1.contact_id === contactA);
  check("recorded_by is auth.uid()", p1.recorded_by === userA);
  let inv = await one("select status, amount_paid, balance_due, paid_at from invoices where id=$1", [inv1row.id]);
  check("partial payment -> partially_paid, amount_paid 400, balance 1000, paid_at null", inv.status === "partially_paid" && Number(inv.amount_paid) === 400 && Number(inv.balance_due) === 1000 && inv.paid_at === null, JSON.stringify(inv));
  await expectError("overpayment by one cent is rejected", "insert into customer_payments (organization_id, invoice_id, amount, method) values ($1,$2,1000.01,'cash')", [orgA, inv1row.id], /exceed the balance due/i);
  await expectError("zero payment is rejected", "insert into customer_payments (organization_id, invoice_id, amount, method) values ($1,$2,0,'cash')", [orgA, inv1row.id], /amount|positive/i);
  await expectError("negative ordinary payment is rejected", "insert into customer_payments (organization_id, invoice_id, amount, method) values ($1,$2,-5,'cash')", [orgA, inv1row.id], /customer_payments_sign_matches_kind|positive/i);
  await expectError("unknown method is rejected", "insert into customer_payments (organization_id, invoice_id, amount, method) values ($1,$2,5,'crypto')", [orgA, inv1row.id], /check constraint|method/i);
  await expectError("void while money is recorded is rejected", "update invoices set status = 'void' where id = $1", [inv1row.id], /invalid invoice status transition|recorded payments/i);
  const p2 = await one("insert into customer_payments (organization_id, invoice_id, amount, method) values ($1,$2,1000,'bank_transfer') returning *", [orgA, inv1row.id]);
  inv = await one("select status, amount_paid, balance_due, paid_at from invoices where id=$1", [inv1row.id]);
  check("exact full payment -> paid, balance 0, paid_at set", inv.status === "paid" && Number(inv.amount_paid) === 1400 && Number(inv.balance_due) === 0 && inv.paid_at !== null, JSON.stringify(inv));
  await expectError("payment on a paid invoice is rejected", "insert into customer_payments (organization_id, invoice_id, amount, method) values ($1,$2,1,'cash')", [orgA, inv1row.id], /issued, unpaid invoice/i);

  console.log("\n[7] append-only ledger and reversals");
  await expectError("payments cannot be updated", "update customer_payments set amount = 1 where id = $1", [p1.id], /append-only/i);
  await expectError("payments cannot be deleted", "delete from customer_payments where id = $1", [p1.id], /append-only/i);
  await expectError("reversal must exactly offset the original", "insert into customer_payments (organization_id, invoice_id, amount, method, reverses_payment_id) values ($1,$2,-999,'cash',$3)", [orgA, inv1row.id, p2.id], /exactly offset/i);
  await expectError("reversal must be negative", "insert into customer_payments (organization_id, invoice_id, amount, method, reverses_payment_id) values ($1,$2,1000,'cash',$3)", [orgA, inv1row.id, p2.id], /customer_payments_sign_matches_kind|check|exactly offset/i);
  const r2 = await one("insert into customer_payments (organization_id, invoice_id, amount, method, reverses_payment_id) values ($1,$2,-1000,'cash',$3) returning *", [orgA, inv1row.id, p2.id]);
  check("reversal keeps the original's method", r2.method === "bank_transfer");
  inv = await one("select status, amount_paid, balance_due, paid_at from invoices where id=$1", [inv1row.id]);
  check("reversal of the full payment -> partially_paid, amount_paid 400, paid_at cleared", inv.status === "partially_paid" && Number(inv.amount_paid) === 400 && inv.paid_at === null, JSON.stringify(inv));
  const original = await one("select amount, reverses_payment_id from customer_payments where id=$1", [p2.id]);
  check("original payment row is untouched by the reversal", Number(original.amount) === 1000 && original.reverses_payment_id === null);
  await expectError("a payment can be reversed only once", "insert into customer_payments (organization_id, invoice_id, amount, method, reverses_payment_id) values ($1,$2,-1000,'cash',$3)", [orgA, inv1row.id, p2.id], /already been reversed|customer_payments_reversal_unique|duplicate/i);
  await expectError("a reversal cannot be reversed", "insert into customer_payments (organization_id, invoice_id, amount, method, reverses_payment_id) values ($1,$2,1000,'cash',$3)", [orgA, inv1row.id, r2.id], /cannot itself be reversed|check|sign/i);
  await q("insert into customer_payments (organization_id, invoice_id, amount, method, reverses_payment_id) values ($1,$2,-400,'cash',$3)", [orgA, inv1row.id, p1.id]);
  inv = await one("select status, amount_paid from invoices where id=$1", [inv1row.id]);
  check("reversing everything returns the invoice to sent with amount_paid 0", inv.status === "sent" && Number(inv.amount_paid) === 0, JSON.stringify(inv));
  const ledgerSum = await one("select coalesce(sum(amount),0) s, count(*) n from customer_payments where invoice_id=$1", [inv1row.id]);
  check("ledger keeps all four rows and sums to 0", Number(ledgerSum.s) === 0 && Number(ledgerSum.n) === 4, JSON.stringify(ledgerSum));

  console.log("\n[8] void, number retention, delete");
  const voided = await one("update invoices set status = 'void', void_reason = 'wrong amount' where id = $1 returning *", [inv1row.id]);
  check("void from sent with nothing collected stamps voided_at", voided.status === "void" && voided.voided_at !== null);
  await expectError("void invoice is read-only", "update invoices set notes = 'x' where id = $1", [inv1row.id], /read-only/i);
  await expectError("payments cannot be recorded on a void invoice", "insert into customer_payments (organization_id, invoice_id, amount, method) values ($1,$2,1,'cash')", [orgA, inv1row.id], /issued, unpaid/i);
  const reissue = await one("insert into invoices (organization_id, job_id, title, subtotal, total) values ($1,$2,'Roof invoice again',1300.25,1300.25) returning number", [orgA, jobA1]);
  check("after void the job can be re-invoiced and the number is new, never reused (3)", reissue.number === 3, String(reissue.number));
  await expectError("issued invoices cannot be deleted", "delete from invoices where id = $1", [inv1row.id], /cannot be deleted/i);
  const draftDel = await q("delete from invoices where id = $1 returning id", [inv2row.id]);
  check("a draft can be deleted (by a trusted role)", draftDel.length === 1);
  const invA2 = (await one("insert into invoices (organization_id, job_id, title, subtotal, total) values ($1,$2,'Gutters invoice 2',400,400) returning *", [orgA, jobA2]));
  check("numbers never go backwards after a draft delete (4)", invA2.number === 4, String(invA2.number));
  await q("update invoices set status='void' where id=$1", [invA2.id]);
  check("draft -> void allowed", (await one("select status from invoices where id=$1", [invA2.id])).status === "void");

  console.log("\n[9] audit RPC");
  const audit = await one("select (create_invoice_audit_event($1,'invoice_issued','invoice',$2,'{\"total\":1400}'::jsonb)).action a", [orgA, inv1row.id]);
  check("create_invoice_audit_event writes an audit_log row", audit.a === "invoice_issued");
  await expectError("audit RPC rejects unknown actions", "select create_invoice_audit_event($1,'invoice_hacked','invoice',$2)", [orgA, inv1row.id], /Unsupported audit action/i);
  await expectError("audit RPC rejects a non-member organization", "select create_invoice_audit_event($1,'invoice_issued','invoice',$2)", [orgB, inv1row.id], /Not authorized/i);

  console.log("\n[10] RLS and payment gate (as role authenticated)");
  const liveA = (await one("insert into invoices (organization_id, job_id, title, subtotal, total) values ($1,$2,'RLS invoice',100,100) returning id", [orgA, (await one("insert into jobs (organization_id, contact_id, title, status) values ($1,$2,'RLS job','completed') returning id", [orgA, contactA])).id])).id;
  await q("update invoices set status='sent' where id=$1", [liveA]);
  await q("insert into customer_payments (organization_id, invoice_id, amount, method) values ($1,$2,25,'cash')", [orgA, liveA]);
  await db.exec("set role authenticated");
  try {
    const seen = await q("select organization_id from invoices");
    check("member of org A sees only org A invoices", seen.length > 0 && seen.every((r) => r.organization_id === orgA), JSON.stringify(seen.map((r) => r.organization_id)));
    const seenPay = await q("select organization_id from customer_payments");
    check("member of org A sees only org A payments", seenPay.length > 0 && seenPay.every((r) => r.organization_id === orgA));
    const bJobForA = jobB1;
    await expectError("member of org A cannot insert an invoice for org B (RLS with check)", "insert into invoices (organization_id, job_id, title, subtotal, total) values ($1,$2,'x',1,1)", [orgB, bJobForA], /row-level security|policy|permission/i);
    await expectError("member cannot delete an invoice (no delete privilege/policy)", "delete from invoices where id = $1", [liveA], /permission denied|policy/i);
    await expectError("member cannot update a payment (no update privilege/policy)", "update customer_payments set notes = 'x' where invoice_id = $1", [liveA], /permission denied|policy|append-only/i);
    await expectError("member cannot delete a payment", "delete from customer_payments where invoice_id = $1", [liveA], /permission denied|policy|append-only/i);
    const memberPay = await q("insert into customer_payments (organization_id, invoice_id, amount, method) values ($1,$2,25,'cash') returning amount", [orgA, liveA]);
    check("member can record a payment in their own organization", memberPay.length === 1);
    await db.exec("reset role");
    await q("update organizations set payment_status = 'suspended' where id = $1", [orgA]);
    await db.exec("set role authenticated");
    const gated = await q("select id from invoices where organization_id = $1", [orgA]);
    check("payment gate: suspended organization sees zero invoices", gated.length === 0, String(gated.length));
    await expectError("payment gate: suspended organization cannot record a payment", "insert into customer_payments (organization_id, invoice_id, amount, method) values ($1,$2,1,'cash')", [orgA, liveA], /row-level security|policy|same organization/i);
  } finally {
    await db.exec("reset role");
    await q("update organizations set payment_status = 'active' where id = $1", [orgA]);
  }

  console.log("\n[11] merge_contacts reassigns invoices and payments");
  const merged = await one("select merge_contacts($1,$2,$3,'dup') r", [orgA, contactA2, contactA]);
  const counts = merged.r.reassigned_counts;
  check("merge_contacts reports invoices and customer_payments counts", typeof counts.invoices === "number" && typeof counts.customer_payments === "number", JSON.stringify(counts));
  const moved = await one("select contact_id from invoices where id=$1", [invA2.id]);
  check("void invoice contact_id moved to the surviving contact (void read-only guard permits contact-only change)", moved.contact_id === contactA, String(moved.contact_id));
  await expectError("payment contact_id cannot move to a contact outside the organization", "update customer_payments set contact_id = $1 where invoice_id = $2", [contactB, liveA], /same organization/i);

  console.log("\n[12] rollback (guard first, then forced)");
  await expectError("rollback refuses while customer_payments has rows", rollback, [], /Refusing to roll back/i);
  await db.exec("rollback"); // clear the aborted transaction from the failed rollback script
  await db.exec("alter table public.customer_payments disable trigger all; alter table public.invoices disable trigger all; delete from customer_payments; delete from invoices;");
  await db.exec(rollback);
  const inv3 = await inventory();
  check("rollback removed tables, triggers, functions, policies", inv3.tables === 0 && inv3.triggers === 0 && inv3.functions === 0 && inv3.policies === 0, JSON.stringify(inv3));
  check("rollback restored merge_contacts byte-for-byte to the captured production body", inv3.merge_md5 === capturedMd5, inv3.merge_md5);

  console.log("\n[13] apply forward migration after rollback");
  await db.exec(forward);
  const inv4 = await inventory();
  check("re-apply after rollback restores the full inventory", JSON.stringify({ ...inv4, merge_md5: 0 }) === JSON.stringify({ ...inv1, merge_md5: 0 }), JSON.stringify(inv4));

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

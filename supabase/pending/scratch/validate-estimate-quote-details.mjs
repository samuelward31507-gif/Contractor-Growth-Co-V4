// Customer-facing quote details: applies estimate_quote_details.sql to an
// in-memory Postgres (PGlite) twice (idempotency) over existing estimates,
// then proves the quote-number backfill and per-organization numbering, the
// immutable number, the draft-only / same-organization line-item rules, the
// cascade on estimate delete, RLS isolation and the payment gate, and that
// the rollback removes everything cleanly. Never touches a real database.
//   cd supabase/pending/scratch && node validate-estimate-quote-details.mjs
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const forward = readFileSync(new URL("../estimate_quote_details.sql", import.meta.url), "utf8");
const rollback = readFileSync(new URL("../estimate_quote_details_rollback.sql", import.meta.url), "utf8");
const db = new PGlite();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const rejects = (sql, params, label) => assert.rejects(db.query(sql, params), undefined, label);
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('trackpr.test_uid', true), '')::uuid
  $$;
  create table public.organizations (id uuid primary key default gen_random_uuid(), payment_status text not null default 'active');
  create table public.organization_members (organization_id uuid, user_id uuid, role text);
  create or replace function public.is_org_member(target_org_id uuid) returns boolean language sql stable security definer as $$
    select exists (select 1 from public.organization_members where organization_id = target_org_id and user_id = auth.uid())
  $$;
  create or replace function public.organization_payment_active(target_org_id uuid) returns boolean language sql stable security definer as $$
    select exists (select 1 from public.organizations where id = target_org_id and payment_status = 'active')
  $$;
  create or replace function public.set_updated_at() returns trigger language plpgsql as $$
  begin new.updated_at = now(); return new; end $$;
  create table public.estimates (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id),
    title text not null,
    amount numeric,
    status text not null default 'draft',
    notes text,
    created_at timestamp with time zone not null default now()
  );
  grant select, insert, update, delete on public.estimates to authenticated;
`);

const [orgA] = await q("insert into organizations default values returning id");
const [orgB] = await q("insert into organizations default values returning id");
// Existing estimates, created in a known order, before the migration.
await q("insert into estimates (organization_id, title, status, created_at) values ($1, 'A first', 'sent', now() - interval '3 days'), ($1, 'A second', 'draft', now() - interval '2 days'), ($2, 'B first', 'accepted', now() - interval '1 day')", [orgA.id, orgB.id]);

await db.exec(forward);
await db.exec(forward); // idempotent
const backfilled = await q("select title, number from estimates order by organization_id = $1 desc, number", [orgA.id]);
assert.deepEqual(backfilled.map((r) => [r.title, r.number]), [["A first", 1], ["A second", 2], ["B first", 1]]);
console.log("ok  applies (twice); existing estimates numbered per organization in creation order");

const [a3] = await q("insert into estimates (organization_id, title, number) values ($1, 'A third', 999) returning id, number", [orgA.id]);
assert.equal(a3.number, 3, "the database assigns the next number, never the client");
const [b2] = await q("insert into estimates (organization_id, title) values ($1, 'B second') returning number", [orgB.id]);
assert.equal(b2.number, 2);
await rejects("update estimates set number = 50 where id = $1", [a3.id], "a quote number is immutable");
await q("update estimates set title = 'A third (renamed)' where id = $1", [a3.id]);
console.log("ok  new estimates get the next per-organization number; a number cannot be changed");

await q("update estimates set scope_of_work = 'Tear off and replace', terms = '50% deposit' where id = $1", [a3.id]);
await rejects("update estimates set terms = repeat('x', 5001) where id = $1", [a3.id], "terms are length-limited");
console.log("ok  scope_of_work and terms stored; length-limited");

const draft = a3.id;
const [sent] = await q("select id from estimates where title = 'A first'");
const [bEstimate] = await q("select id from estimates where title = 'B first'");
await q("insert into estimate_line_items (organization_id, estimate_id, position, description, quantity, unit, unit_price) values ($1, $2, 0, 'Tear-off', 30, 'sq', 120), ($1, $2, 1, 'Dumpster', 1, null, 450)", [orgA.id, draft]);
await rejects("insert into estimate_line_items (organization_id, estimate_id, description, unit_price) values ($1, $2, 'Extra', 10)", [orgA.id, sent.id], "no line items on a sent estimate");
await rejects("insert into estimate_line_items (organization_id, estimate_id, description, unit_price) values ($1, $2, 'Cross-org', 10)", [orgB.id, draft], "a line item must be in its estimate's organization");
await rejects("insert into estimate_line_items (organization_id, estimate_id, description, quantity, unit_price) values ($1, $2, 'Zero', 0, 10)", [orgA.id, draft], "quantity must be positive");
await rejects("insert into estimate_line_items (organization_id, estimate_id, description, unit_price) values ($1, $2, 'Negative', -1)", [orgA.id, draft], "unit price cannot be negative");
await rejects("insert into estimate_line_items (organization_id, estimate_id, description, unit_price) values ($1, $2, '   ', 1)", [orgA.id, draft], "a description is required");
const [{ sum }] = await q("select sum(round(quantity * unit_price, 2))::numeric as sum from estimate_line_items where estimate_id = $1", [draft]);
assert.equal(Number(sum), 4050);
console.log("ok  line items: draft-only, same organization, positive quantity, non-negative price, description required");

await q("update estimates set status = 'sent' where id = $1", [draft]);
await rejects("update estimate_line_items set unit_price = 1 where estimate_id = $1", [draft], "items of a sent quote are frozen");
await rejects("delete from estimate_line_items where estimate_id = $1", [draft], "items of a sent quote cannot be deleted");
await q("delete from estimates where id = $1", [draft]);
assert.equal((await q("select count(*)::int as n from estimate_line_items where estimate_id = $1", [draft]))[0].n, 0, "deleting the estimate cascades");
console.log("ok  a sent quote's items are frozen; deleting the estimate removes its items");

// --- RLS -------------------------------------------------------------------
const [draftA] = await q("insert into estimates (organization_id, title) values ($1, 'A draft for RLS') returning id", [orgA.id]);
const [draftB] = await q("insert into estimates (organization_id, title) values ($1, 'B draft for RLS') returning id", [orgB.id]);
await q("insert into estimate_line_items (organization_id, estimate_id, description, unit_price) values ($1, $2, 'B item', 5)", [orgB.id, draftB.id]);
await q("insert into organization_members (organization_id, user_id, role) values ($1, $2, 'owner')", [orgA.id, USER_A]);
await db.exec(`set trackpr.test_uid = '${USER_A}'`);
await db.exec("set role authenticated");
try {
  await q("insert into estimate_line_items (organization_id, estimate_id, description, unit_price) values ($1, $2, 'A item', 5)", [orgA.id, draftA.id]);
  assert.deepEqual((await q("select description from estimate_line_items")).map((r) => r.description), ["A item"], "a member sees only their organization's items");
  await rejects("insert into estimate_line_items (organization_id, estimate_id, description, unit_price) values ($1, $2, 'Into B', 5)", [orgB.id, draftB.id], "cannot write into another organization");
  const updated = await q("update estimate_line_items set unit_price = 1 where organization_id = $1 returning id", [orgB.id]);
  assert.equal(updated.length, 0, "cannot change another organization's items");
} finally {
  await db.exec("reset role");
}
await q("update organizations set payment_status = 'payment_required' where id = $1", [orgA.id]);
await db.exec("set role authenticated");
try {
  assert.equal((await q("select id from estimate_line_items")).length, 0, "the payment gate hides items from an unpaid organization");
} finally {
  await db.exec("reset role");
}
assert.equal((await q("select has_table_privilege('anon', 'public.estimate_line_items', 'SELECT') as p"))[0].p, false, "anon has no access");
console.log("ok  RLS: members see and write only their organization's items; payment gate applies; anon has no access");

await db.exec(rollback);
await db.exec(rollback); // idempotent
assert.equal((await q("select to_regclass('public.estimate_line_items') as t"))[0].t, null);
assert.equal((await q("select count(*)::int as n from information_schema.columns where table_name = 'estimates' and column_name in ('number', 'scope_of_work', 'terms')"))[0].n, 0);
await q("insert into estimates (organization_id, title) values ($1, 'after rollback')", [orgB.id]);
console.log("ok  rollback (twice) removes the table, columns and triggers; estimates still insert");

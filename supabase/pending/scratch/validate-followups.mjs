// P0 A4: applies followups.sql to an in-memory Postgres (PGlite) holding the
// minimal pre-A4 shape (organizations, leads, workflow_executions, the RLS
// helper functions), twice (idempotency); exercises every constraint; then,
// AS ROLE authenticated, proves organization isolation: a member reads only
// their own organization's follow-ups and can neither create nor mutate nor
// delete any follow-up (own or other organization), and the payment gate
// hides a suspended organization's rows. Finally runs the rollback and
// re-applies. Never touches a real database.
//   cd supabase/pending/scratch && node validate-followups.mjs
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const forward = readFileSync(new URL("../followups.sql", import.meta.url), "utf8");
const rollback = readFileSync(new URL("../followups_rollback.sql", import.meta.url), "utf8");
const db = new PGlite();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const rejects = (sql, params, label) => assert.rejects(db.query(sql, params), undefined, label);

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
  create table public.leads (id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id));
  create table public.workflow_executions (id uuid primary key default gen_random_uuid());
`);

const [orgA] = await q("insert into organizations default values returning id");
const [orgB] = await q("insert into organizations default values returning id");
const [leadA] = await q("insert into leads (organization_id) values ($1) returning id", [orgA.id]);
const [leadB] = await q("insert into leads (organization_id) values ($1) returning id", [orgB.id]);
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
await q("insert into organization_members values ($1, $2, 'owner')", [orgA.id, USER_A]);

await db.exec(forward);
await db.exec(forward);
console.log("ok  applies twice (idempotent)");

const insert = (org, lead, extra = "") => q(`insert into followups (organization_id, lead_id, stage, state, next_action_at ${extra ? ", " + extra.split("=")[0] : ""}) values ($1, $2, 'lead_no_reply', 'scheduled', now() ${extra ? ", " + extra.split("=")[1] : ""}) returning *`, [org, lead]);
const [fA] = await insert(orgA.id, leadA.id);
const [fB] = await insert(orgB.id, leadB.id);
assert.equal(fA.attempt_count, 0);
assert.equal(fA.waiting_on, "customer");
await rejects("insert into followups (organization_id, lead_id, stage, state, next_action_at) values ($1, $2, 'lead_no_reply', 'scheduled', now())", [orgA.id, leadA.id], "one follow-up per lead + stage");
console.log("ok  unique (lead_id, stage): a repeated producer insert is refused");

await rejects("insert into followups (organization_id, lead_id, stage, state) values ($1, $2, 'other_stage', 'scheduled')", [orgA.id, leadA.id], "stage check");
await rejects("update followups set state = 'bogus' where id = $1", [fA.id], "state check");
await rejects("update followups set waiting_on = 'bogus' where id = $1", [fA.id], "waiting_on check");
await rejects("update followups set next_action = 'bogus' where id = $1", [fA.id], "next_action check");
await rejects("update followups set next_action_at = null where id = $1", [fA.id], "scheduled needs a time");
await rejects("update followups set attempt_count = 11 where id = $1", [fA.id], "attempt bound");
for (const state of ["pending", "processing", "paused", "completed", "exited", "failed"]) await q("update followups set state = $2 where id = $1", [fA.id, state]);
await q("update followups set state = 'scheduled' where id = $1", [fA.id]);
console.log("ok  constraints: stage / state / waiting_on / next_action / scheduled-needs-time / attempt bound");

const before = (await q("select updated_at from followups where id = $1", [fA.id]))[0].updated_at;
await new Promise((resolve) => setTimeout(resolve, 5));
await q("update followups set attempt_count = 1 where id = $1", [fA.id]);
assert.ok((await q("select updated_at from followups where id = $1", [fA.id]))[0].updated_at > before);
console.log("ok  updated_at trigger");

// --- RLS as an authenticated member of organization A ----------------------
await db.exec(`set trackpr.test_uid = '${USER_A}'`);
await db.exec("set role authenticated");
try {
  const seen = await q("select organization_id from followups");
  assert.deepEqual(seen.map((r) => r.organization_id), [orgA.id], "30: org A sees only its own follow-ups");
  assert.equal((await q("select id from followups where id = $1", [fB.id])).length, 0, "30: org B's row is invisible");
  await rejects("insert into followups (organization_id, lead_id, stage, state, next_action_at) values ($1, $2, 'lead_no_reply', 'scheduled', now())", [orgA.id, leadA.id], "a member cannot create follow-ups (server-side only)");
  await rejects("update followups set state = 'exited' where id = $1", [fB.id], "31: cannot mutate org B");
  await rejects("update followups set state = 'exited' where id = $1", [fA.id], "members cannot mutate even their own (dispatcher owns writes)");
  await rejects("delete from followups where id = $1", [fB.id], "31: cannot delete org B");
} finally {
  await db.exec("reset role");
}
assert.equal((await q("select state from followups where id = $1", [fB.id]))[0].state, "scheduled", "org B's row is untouched");
console.log("ok  RLS: org A reads only its own rows; no member can create, mutate or delete any follow-up");

await q("update organizations set payment_status = 'suspended' where id = $1", [orgA.id]);
await db.exec("set role authenticated");
try {
  assert.equal((await q("select id from followups")).length, 0, "payment gate hides a suspended organization's rows");
} finally {
  await db.exec("reset role");
  await q("update organizations set payment_status = 'active' where id = $1", [orgA.id]);
}
await db.exec("set role anon");
try {
  await rejects("select id from followups", [], "anon has no access");
} finally {
  await db.exec("reset role");
}
console.log("ok  payment gate + anon has no access");

await q("delete from leads where id = $1", [leadB.id]);
assert.equal((await q("select id from followups where id = $1", [fB.id])).length, 0);
console.log("ok  a deleted lead takes its follow-up with it");

await db.exec(rollback);
assert.equal((await q("select to_regclass('public.followups') t"))[0].t, null);
await db.exec(forward);
console.log("ok  rollback, then re-apply");
console.log("PASS followups");

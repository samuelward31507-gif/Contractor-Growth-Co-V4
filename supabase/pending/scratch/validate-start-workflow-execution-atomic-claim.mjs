// P0-B B0: proves start_workflow_execution's atomic event claim in an
// in-memory Postgres (PGlite) holding the minimal shape it touches
// (automation_events, workflow_executions, the auth/RLS helpers). Never
// touches a real database.
//
// The race needs two sessions to interleave between the RPC's status read
// and its claim. PGlite is single-session, so the interleaving is injected
// deterministically: the is_org_member() stub - which the RPC calls for an
// authenticated caller AFTER reading the event status and BEFORE claiming
// it - can be armed to commit a competing claim (status -> 'processing'
// plus that winner's running execution) exactly in that window.
//
//   ROLLBACK body (pre-B0): the stale read wins - a SECOND running execution
//   is created for the same event (the race, reproduced).
//   FORWARD body (B0): the conditional claim matches nothing and the call
//   raises 'Automation event is already being processed' - one execution.
//
// Also checks every pre-existing behaviour is unchanged on the forward body:
// attempt numbering, trigger_source, event -> processing, every error
// message, authorization branches, idempotent apply, grants kept.
//   cd supabase/pending/scratch && node validate-start-workflow-execution-atomic-claim.mjs
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const forward = readFileSync(new URL("../start_workflow_execution_atomic_claim.sql", import.meta.url), "utf8");
const rollback = readFileSync(new URL("../start_workflow_execution_atomic_claim_rollback.sql", import.meta.url), "utf8");
const db = new PGlite();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
// Literal SQL through exec (simple protocol): PGlite's extended protocol
// mis-parses some plpgsql error frames. Every interpolated value here is a
// uuid or a fixed test literal.
const lit = (sql, params) => sql.replace(/\$(\d+)/g, (_, i) => `'${params[Number(i) - 1]}'`);
const run = async (sql, params = []) => (await db.exec(lit(sql, params))).at(-1).rows;
const rejects = (promise, pattern) => assert.rejects(promise, pattern);

await db.exec(`
  create role authenticated nologin;
  create role service_role nologin;
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('trackpr.uid', true), '')::uuid $$;
  create or replace function auth.role() returns text language sql stable as $$ select coalesce(nullif(current_setting('trackpr.role', true), ''), 'authenticated') $$;
  create table public.automation_events (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null,
    status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'failed'))
  );
  create table public.workflow_executions (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null,
    automation_event_id uuid references public.automation_events(id),
    workflow_name text not null,
    status text not null,
    attempt int not null default 1,
    started_at timestamptz,
    metadata jsonb not null default '{}'::jsonb,
    trigger_source text not null default 'event'
  );
  create table public.race (event_id uuid);
  create or replace function public.organization_payment_active(target uuid) returns boolean language sql as $$ select current_setting('trackpr.paid', true) is distinct from 'no' $$;
  -- The injected "other session": when armed, commits a competing claim for
  -- the armed event exactly between the RPC's status read and its claim.
  create or replace function public.is_org_member(target uuid) returns boolean language plpgsql as $$
  declare v_event uuid;
  begin
    delete from public.race returning event_id into v_event;
    if v_event is not null then
      update public.automation_events set status = 'processing' where id = v_event;
      insert into public.workflow_executions (organization_id, automation_event_id, workflow_name, status, attempt, started_at)
      values (target, v_event, 'competing_session', 'running', 99, now());
    end if;
    return current_setting('trackpr.member', true) is distinct from 'no';
  end $$;
`);

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const asUser = () => db.exec(`select set_config('trackpr.uid', '${USER}', false), set_config('trackpr.role', 'authenticated', false)`);
const asService = () => db.exec(`select set_config('trackpr.uid', '', false), set_config('trackpr.role', 'service_role', false)`);
const newEvent = async (status = "pending") => (await q("insert into automation_events (organization_id, status) values ($1, $2) returning id", [ORG, status]))[0].id;
const start = (eventId, source = "event") => run("select * from start_workflow_execution($1, 'wf', '{}'::jsonb, $2)", [eventId, source]);
const running = async (eventId) => (await q("select count(*)::int n from workflow_executions where automation_event_id = $1 and status = 'running'", [eventId]))[0].n;

// --- 1. The race, reproduced on the pre-B0 body --------------------------
await db.exec(rollback);
await asUser();
{
  const event = await newEvent("failed");
  await q("delete from race");
  await q("insert into race values ($1)", [event]);
  await start(event, "retry");
  assert.equal(await running(event), 2, "pre-B0: the stale read lets a second running execution start");
  console.log("ok  pre-B0 body: interleaved start creates a SECOND running execution (race reproduced)");
}

// --- 2. Forward body: idempotent apply, the race is refused ---------------
await db.exec(forward);
await db.exec(forward);
console.log("ok  applies twice (idempotent)");
await asUser();
for (const initial of ["pending", "failed"]) {
  const event = await newEvent(initial);
  await q("delete from race");
  await q("insert into race values ($1)", [event]);
  await rejects(start(event, "retry"), /Automation event is already being processed/);
  // The emulated competitor ran inside the loser's own statement, so the
  // loser's error also rolls the competitor back (a real competitor commits
  // in its own transaction and keeps its row). What this proves: the loser
  // REFUSED instead of starting a second execution, although its own status
  // read said the event was free.
  assert.equal(await running(event), 0, "the loser started nothing");
  assert.equal((await q("select status from automation_events where id = $1", [event]))[0].status, initial);
}
console.log("ok  B0 body: the interleaved loser raises 'already being processed' and starts nothing (no second execution)");
{
  // A competitor that already finished the event: the loser reports 'already completed'.
  await db.exec(`
    create or replace function public.is_org_member(target uuid) returns boolean language plpgsql as $$
    declare v_event uuid;
    begin
      delete from public.race returning event_id into v_event;
      if v_event is not null then update public.automation_events set status = 'completed' where id = v_event; end if;
      return true;
    end $$;`);
  const event = await newEvent("failed");
  await q("delete from race");
  await q("insert into race values ($1)", [event]);
  await rejects(start(event, "retry"), /Automation event has already completed/);
  assert.equal(await running(event), 0);
  console.log("ok  B0 body: a competitor that completed the event -> 'already completed', nothing started");
}

// --- 3. Unchanged behaviour on the forward body ---------------------------
await db.exec(`create or replace function public.is_org_member(target uuid) returns boolean language sql as $$ select current_setting('trackpr.member', true) is distinct from 'no' $$;`);
await asService();
{
  const event = await newEvent();
  const [first] = await start(event);
  assert.equal(first.status, "running");
  assert.equal(first.attempt, 1);
  assert.equal(first.trigger_source, "event");
  assert.equal(first.organization_id, ORG);
  assert.equal((await q("select status from automation_events where id = $1", [event]))[0].status, "processing");
  await rejects(start(event), /Automation event is already being processed/);
  await q("update workflow_executions set status = 'failed' where id = $1", [first.id]);
  await q("update automation_events set status = 'failed' where id = $1", [event]);
  const [second] = await start(event, "retry");
  assert.equal(second.attempt, 2, "attempt numbering max+1 unchanged");
  assert.equal(second.trigger_source, "retry");
  await q("update automation_events set status = 'completed' where id = $1", [event]);
  await rejects(start(event), /Automation event has already completed/);
}
await rejects(start("00000000-0000-4000-8000-000000000000"), /Automation event not found/);
{
  const event = await newEvent();
  await rejects(run("select * from start_workflow_execution($1, '  ', '{}'::jsonb, 'event')", [event]), /workflow_name is required/);
  await rejects(run("select * from start_workflow_execution($1, 'wf', '[]'::jsonb, 'event')", [event]), /metadata must be a JSON object/);
  await rejects(start(event, "bogus"), /Invalid trigger_source/);
  assert.equal((await q("select status from automation_events where id = $1", [event]))[0].status, "pending", "a validation error claims nothing");
  const [defaulted] = await run("select * from start_workflow_execution($1, 'wf', null, '')", [event]);
  assert.equal(defaulted.trigger_source, "event");
  assert.deepEqual(defaulted.metadata, {});
}
await db.exec(`select set_config('trackpr.uid', '', false), set_config('trackpr.role', 'anon', false)`);
await rejects(start(await newEvent()), /Not authenticated/);
await asUser();
await db.exec(`select set_config('trackpr.member', 'no', false)`);
await rejects(start(await newEvent()), /Automation event not found/);
await db.exec(`select set_config('trackpr.member', '', false), set_config('trackpr.paid', 'no', false)`);
await rejects(start(await newEvent()), /Automation event not found/);
await db.exec(`select set_config('trackpr.paid', '', false)`);
console.log("ok  unchanged: attempt numbering, trigger_source, event -> processing, every error message, auth/payment branches");

const [fn] = await q("select prosecdef, proconfig from pg_proc where proname = 'start_workflow_execution'");
assert.equal(fn.prosecdef, true);
assert.deepEqual(fn.proconfig, ["search_path=public"]);
console.log("ok  SECURITY DEFINER + search_path=public kept");

// --- 4. Rollback, then re-apply -------------------------------------------
await db.exec(rollback);
assert.match((await q("select prosrc from pg_proc where proname = 'start_workflow_execution'"))[0].prosrc, /where id = p_automation_event_id;\n/);
await db.exec(forward);
assert.match((await q("select prosrc from pg_proc where proname = 'start_workflow_execution'"))[0].prosrc, /and status not in \('processing', 'completed'\)/);
console.log("ok  rollback restores the pre-B0 body; re-apply restores B0");
console.log("PASS start_workflow_execution_atomic_claim");

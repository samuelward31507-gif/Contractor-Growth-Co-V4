// P0 A2: applies execution_outcome_retry_state.sql to an in-memory Postgres
// (PGlite) holding the pre-A2 workflow_executions shape, twice (idempotency),
// exercises the outcome trigger, the backfill and every constraint, then
// runs the rollback and applies once more. Never touches a real database.
//   cd supabase/pending/scratch && node validate-execution-outcome-retry-state.mjs
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const forward = readFileSync(new URL("../execution_outcome_retry_state.sql", import.meta.url), "utf8");
const rollback = readFileSync(new URL("../execution_outcome_retry_state_rollback.sql", import.meta.url), "utf8");
const db = new PGlite();

// The pre-A2 table, as the TEST/Production schema has it.
await db.exec(`
  create table public.workflow_executions (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null,
    automation_event_id uuid,
    workflow_name text not null,
    status text not null default 'running' check (status in ('running','completed','failed','cancelled')),
    attempt integer not null default 1,
    started_at timestamptz not null default now(),
    completed_at timestamptz,
    error_message text,
    metadata jsonb not null default '{}'::jsonb,
    trigger_source text not null default 'event' check (trigger_source in ('event','manual','retry'))
  );
  insert into public.workflow_executions (organization_id, workflow_name, status, metadata, error_message) values
    (gen_random_uuid(), 'a', 'completed', '{"should_send": true, "blocked_reason": null}', null),
    (gen_random_uuid(), 'b', 'completed', '{"should_send": false, "blocked_reason": "organization_not_live"}', null),
    (gen_random_uuid(), 'c', 'failed', '{}', 'Twilio error'),
    (gen_random_uuid(), 'd', 'failed', '{}', 'execution_timeout: no callback after 60 minutes'),
    (gen_random_uuid(), 'e', 'running', '{}', null),
    (gen_random_uuid(), 'f', 'cancelled', '{}', null);
`);

const outcomes = async () => Object.fromEntries((await db.query("select workflow_name, outcome, retry_state, retry_detail from public.workflow_executions order by workflow_name")).rows.map((r) => [r.workflow_name, [r.outcome, r.retry_state, r.retry_detail]]));
const rejects = async (sql, label) => {
  await assert.rejects(db.exec(sql), undefined, label);
};

await db.exec(forward);
await db.exec(forward); // idempotent
assert.deepEqual(await outcomes(), {
  a: ["succeeded", null, null],
  b: ["blocked", null, null],
  c: ["failed", "not_retryable", "pre_a2_failure"],
  d: ["timed_out", "not_retryable", "pre_a2_failure"],
  e: [null, null, null],
  f: ["cancelled", null, null],
});
console.log("ok  backfill: outcomes derived, historical failures never auto-retried, idempotent");

// Trigger on the real RPC transitions (status/metadata/error_message updates).
await db.exec(`update public.workflow_executions set status = 'completed', metadata = '{"blocked_reason": "contact_opted_out"}' where workflow_name = 'e'`);
assert.equal((await outcomes()).e[0], "blocked");
await db.exec(`insert into public.workflow_executions (organization_id, workflow_name) values (gen_random_uuid(), 'g')`);
assert.equal((await outcomes()).g[0], null);
await db.exec(`update public.workflow_executions set status = 'failed', error_message = 'n8n dispatch failed' where workflow_name = 'g'`);
assert.equal((await outcomes()).g[0], "failed");
await rejects(`update public.workflow_executions set outcome = 'succeeded' where workflow_name = 'g'`.replace("set outcome = 'succeeded'", "set outcome = 'bogus'"), "outcome check");
console.log("ok  trigger: outcome follows status / blocked_reason / error_message on every transition");

// retry_state lifecycle + constraints.
await db.exec(`update public.workflow_executions set retry_state = 'scheduled', next_retry_at = now() + interval '5 minutes', max_attempts = 3, retry_detail = 'retry 2 of 3 scheduled' where workflow_name = 'g'`);
await db.exec(`update public.workflow_executions set retry_state = 'retried', retry_detail = 'retried as x' where workflow_name = 'g'`);
await rejects(`update public.workflow_executions set retry_state = 'scheduled', next_retry_at = null where workflow_name = 'g'`, "scheduled needs next_retry_at");
await rejects(`update public.workflow_executions set retry_state = 'exhausted' where workflow_name = 'a'`, "retry_state only on failed");
await rejects(`update public.workflow_executions set retry_state = 'whatever' where workflow_name = 'g'`, "retry_state values");
await rejects(`update public.workflow_executions set max_attempts = 9 where workflow_name = 'g'`, "max_attempts bound");
await rejects(`update public.workflow_executions set retry_detail = repeat('x', 501) where workflow_name = 'g'`, "retry_detail length");
console.log("ok  constraints: retry_state only on failed rows, scheduled needs a time, bounded attempts and detail");

const indexes = (await db.query("select indexname from pg_indexes where indexname in ('idx_workflow_executions_retry_due','idx_workflow_executions_running_started') order by 1")).rows.map((r) => r.indexname);
assert.deepEqual(indexes, ["idx_workflow_executions_retry_due", "idx_workflow_executions_running_started"]);
console.log("ok  indexes present");

await db.exec(rollback);
const columns = (await db.query("select column_name from information_schema.columns where table_name = 'workflow_executions' order by ordinal_position")).rows.map((r) => r.column_name);
assert.deepEqual(columns, ["id", "organization_id", "automation_event_id", "workflow_name", "status", "attempt", "started_at", "completed_at", "error_message", "metadata", "trigger_source"]);
assert.equal((await db.query("select count(*)::int n from pg_trigger where tgname = 'workflow_executions_derive_outcome'")).rows[0].n, 0);
console.log("ok  rollback restores the exact pre-A2 shape");

await db.exec(forward);
assert.equal((await outcomes()).a[0], "succeeded");
console.log("ok  re-apply after rollback");
console.log("PASS execution_outcome_retry_state");

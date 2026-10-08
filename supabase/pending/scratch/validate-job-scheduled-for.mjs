// Job scheduling state: applies job_scheduled_for.sql to an in-memory
// Postgres (PGlite) twice (idempotency), proves existing jobs stay valid with
// a null scheduled_for (no backfill, no default), that it can be set, changed
// and cleared without touching status, and that the rollback removes it
// cleanly. Never touches a real database.
//   cd supabase/pending/scratch && node validate-job-scheduled-for.mjs
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const forward = readFileSync(new URL("../job_scheduled_for.sql", import.meta.url), "utf8");
const rollback = readFileSync(new URL("../job_scheduled_for_rollback.sql", import.meta.url), "utf8");
const db = new PGlite();

await db.exec(`
  create table public.jobs (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null,
    estimate_id uuid,
    title text not null,
    status text not null default 'scheduled' check (status in ('scheduled', 'in_progress', 'completed', 'cancelled')),
    started_at timestamp with time zone,
    completed_at timestamp with time zone
  );
`);
const ORG = "11111111-1111-4111-8111-111111111111";
await db.query("insert into public.jobs (organization_id, title, status) values ($1, 'Roof', 'scheduled'), ($1, 'Deck', 'in_progress'), ($1, 'Fence', 'completed')", [ORG]);

await db.exec(forward);
await db.exec(forward); // idempotent
const column = await db.query("select data_type, is_nullable, column_default from information_schema.columns where table_name = 'jobs' and column_name = 'scheduled_for'");
assert.equal(column.rows.length, 1);
assert.equal(column.rows[0].data_type, "timestamp with time zone");
assert.equal(column.rows[0].is_nullable, "YES");
assert.equal(column.rows[0].column_default, null);
const existing = await db.query("select count(*)::int as n from public.jobs where scheduled_for is not null");
assert.equal(existing.rows[0].n, 0);
console.log("ok  applies (twice); timestamptz, nullable, no default; every existing job stays null (no backfill)");

await db.query("insert into public.jobs (organization_id, title) values ($1, 'New job')", [ORG]);
const fresh = await db.query("select scheduled_for, status from public.jobs where title = 'New job'");
assert.equal(fresh.rows[0].scheduled_for, null);
assert.equal(fresh.rows[0].status, "scheduled");
console.log("ok  a new job (as an accepted estimate creates it) starts unscheduled; status keeps its meaning");

await db.query("update public.jobs set scheduled_for = $1 where title = 'New job'", ["2026-10-20T15:30:00Z"]);
let row = await db.query("select scheduled_for, status from public.jobs where title = 'New job'");
assert.equal(new Date(row.rows[0].scheduled_for).toISOString(), "2026-10-20T15:30:00.000Z");
assert.equal(row.rows[0].status, "scheduled");
await db.query("update public.jobs set scheduled_for = $1 where title = 'New job'", ["2026-10-22T16:00:00Z"]);
row = await db.query("select scheduled_for from public.jobs where title = 'New job'");
assert.equal(new Date(row.rows[0].scheduled_for).toISOString(), "2026-10-22T16:00:00.000Z");
await db.query("update public.jobs set scheduled_for = null where title = 'New job'");
row = await db.query("select scheduled_for from public.jobs where title = 'New job'");
assert.equal(row.rows[0].scheduled_for, null);
console.log("ok  set, rescheduled and cleared as an instant; status untouched");

await db.exec(rollback);
await db.exec(rollback); // idempotent
const gone = await db.query("select count(*)::int as n from information_schema.columns where table_name = 'jobs' and column_name = 'scheduled_for'");
assert.equal(gone.rows[0].n, 0);
const rows = await db.query("select count(*)::int as n from public.jobs");
assert.equal(rows.rows[0].n, 4);
console.log("ok  rollback (twice) drops the column; no rows lost");

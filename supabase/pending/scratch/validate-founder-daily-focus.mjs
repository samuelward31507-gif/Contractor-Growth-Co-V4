// Founder daily priorities: applies founder_command_center.sql then
// founder_daily_focus.sql (twice - idempotent) to an in-memory Postgres
// (PGlite), and proves: three priorities per founder per day at most, no
// events/meetings, rank 1..3 paired with a date, reordering within a day,
// founders isolated (RLS unchanged), and a clean rollback that keeps items.
//   cd supabase/pending/scratch && node validate-founder-daily-focus.mjs
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const base = readFileSync(new URL("../founder_command_center.sql", import.meta.url), "utf8");
const forward = readFileSync(new URL("../founder_daily_focus.sql", import.meta.url), "utf8");
const rollback = readFileSync(new URL("../founder_daily_focus_rollback.sql", import.meta.url), "utf8");
const db = new PGlite();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema if not exists auth;
  create table auth.users (id uuid primary key);
  grant usage on schema auth to authenticated;
  create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('trackpr.test_uid', true), '')::uuid $$;
  create or replace function public.set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
  grant usage on schema public to authenticated, anon;
`);
await q("insert into auth.users (id) values ($1), ($2)", [A, B]);
await db.exec(base);
await q("insert into founder_users (user_id) values ($1), ($2)", [A, B]);
await q("insert into founder_items (owner_id, title) values ($1, 'Existing task')", [A]);
await db.exec(forward);
await db.exec(forward);
assert.equal((await q("select count(*)::int n from founder_items where focus_date is null"))[0].n, 1, "existing items are untouched");
console.log("ok  applies (twice) on top of the founder schema; existing items untouched");

async function as(uid, fn) {
  await db.exec(`set trackpr.test_uid = '${uid}'`);
  await db.exec("set role authenticated");
  try { return await fn(); } finally { await db.exec("reset role"); await db.exec("reset trackpr.test_uid"); }
}
const fails = (uid, sql, params, label) => as(uid, () => assert.rejects(db.query(sql, params), undefined, label));

await as(A, async () => {
  for (const [title, rank] of [["One", 1], ["Two", 2], ["Three", 3]]) await q("insert into founder_items (title, focus_date, focus_rank) values ($1, '2026-10-09', $2)", [title, rank]);
});
await fails(A, "insert into founder_items (title, focus_date, focus_rank) values ('Four', '2026-10-09', 1)", [], "a fourth priority is refused");
await fails(A, "update founder_items set focus_date = '2026-10-09', focus_rank = 1 where title = 'Existing task'", [], "pinning a fourth by update is refused");
await as(A, () => q("insert into founder_items (title, focus_date, focus_rank) values ('Tomorrow', '2026-10-10', 1)"));
console.log("ok  at most three priorities per founder per day (insert and update); other days independent");

await as(A, async () => {
  await q("update founder_items set focus_rank = 3 where title = 'One'");
  await q("update founder_items set focus_rank = 1 where title = 'Three'");
  assert.deepEqual((await q("select title from founder_items where focus_date = '2026-10-09' order by focus_rank, title")).map((r) => r.title), ["Three", "Two", "One"]);
  await q("update founder_items set focus_date = null, focus_rank = null where title = 'Two'");
  await q("update founder_items set focus_date = '2026-10-09', focus_rank = 2 where title = 'Existing task'");
});
console.log("ok  reorder within a day; unpin then pin another");

await fails(A, "insert into founder_items (kind, title, starts_at, focus_date, focus_rank) values ('meeting', 'Demo', now(), '2026-10-11', 1)", [], "meetings can't be priorities");
await fails(A, "update founder_items set kind = 'event', starts_at = now() where title = 'Three'", [], "a priority can't become an event");
await fails(A, "insert into founder_items (title, focus_date, focus_rank) values ('Bad rank', '2026-10-11', 4)", [], "rank 1..3");
await fails(A, "insert into founder_items (title, focus_date) values ('No rank', '2026-10-11')", [], "date and rank together");
console.log("ok  events/meetings refused; rank 1..3 and paired with a date");

await as(B, async () => {
  assert.equal((await q("select count(*)::int n from founder_items")).length && (await q("select count(*)::int n from founder_items"))[0].n, 0, "another founder sees none of A's priorities");
  for (const t of ["B1", "B2", "B3"]) await q("insert into founder_items (title, focus_date, focus_rank) values ($1, '2026-10-09', 1)", [t]);
  assert.equal((await q("update founder_items set focus_rank = 2 where owner_id = $1 returning id", [A])).length, 0);
});
console.log("ok  founders are isolated: B's three priorities don't count against A's, and B can't touch A's");

await db.exec(rollback);
await db.exec(rollback);
assert.equal((await q("select count(*)::int n from information_schema.columns where table_name = 'founder_items' and column_name in ('focus_date','focus_rank')"))[0].n, 0);
assert.ok((await q("select count(*)::int n from founder_items"))[0].n >= 8, "items are kept");
console.log("ok  rollback (twice) removes the columns and trigger, keeps every item");

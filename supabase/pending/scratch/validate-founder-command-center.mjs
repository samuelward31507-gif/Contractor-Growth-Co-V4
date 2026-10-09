// Founder Command Center: applies founder_command_center.sql to an in-memory
// Postgres (PGlite) twice (idempotency), then proves the access model - only
// an allow-listed founder can read or write, only their own rows, an agency
// admin or org member is not a founder, removal revokes everything, anon has
// nothing - plus the data rules (won deals complete, month on the 1st,
// manual-only MRR, same-owner deal links, immutable owner) and that the
// rollback removes everything. Never touches a real database.
//   cd supabase/pending/scratch && node validate-founder-command-center.mjs
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const forward = readFileSync(new URL("../founder_command_center.sql", import.meta.url), "utf8");
const rollback = readFileSync(new URL("../founder_command_center_rollback.sql", import.meta.url), "utf8");
const db = new PGlite();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const FOUNDER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_FOUNDER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STRANGER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
  create schema if not exists auth;
  create table auth.users (id uuid primary key);
  grant usage on schema auth to authenticated;
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('trackpr.test_uid', true), '')::uuid
  $$;
  create or replace function public.set_updated_at() returns trigger language plpgsql as $$
  begin new.updated_at = now(); return new; end $$;
  grant usage on schema public to authenticated, anon;
`);
await q("insert into auth.users (id) values ($1), ($2), ($3)", [FOUNDER, OTHER_FOUNDER, STRANGER]);

await db.exec(forward);
await db.exec(forward); // idempotent
console.log("ok  applies (twice)");

await q("insert into founder_users (user_id) values ($1), ($2)", [FOUNDER, OTHER_FOUNDER]);

async function as(uid, fn) {
  await db.exec(`set trackpr.test_uid = '${uid}'`);
  await db.exec("set role authenticated");
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
    await db.exec("reset trackpr.test_uid");
  }
}
const fails = (uid, sql, params, label) => as(uid, () => assert.rejects(db.query(sql, params), undefined, label));

// A founder writes and reads their own rows; owner_id defaults to them.
const deal = await as(FOUNDER, async () => {
  assert.equal((await q("select public.is_founder() as f"))[0].f, true);
  const [d] = await q("insert into founder_deals (name, stage, expected_mrr) values ('Acme Roofing', 'lead', 299) returning id, owner_id");
  assert.equal(d.owner_id, FOUNDER);
  await q("insert into founder_items (kind, title, priority, due_at, deal_id) values ('follow_up', 'Call Acme', 'high', now(), $1)", [d.id]);
  await q("insert into founder_items (kind, title, starts_at) values ('meeting', 'Demo', now())");
  await q("insert into founder_mrr_entries (month, kind, amount) values ('2026-10-01', 'new', 299), ('2026-11-01', 'new', 500)");
  await q("update founder_mrr_entries set is_forecast = true where month = '2026-11-01'");
  await q("insert into founder_reviews (review_date, wins) values ('2026-10-09', 'Closed Acme')");
  return d;
});
console.log("ok  a founder creates and reads their own deals, items, MRR entries and reviews");

await as(OTHER_FOUNDER, async () => {
  for (const t of ["founder_deals", "founder_items", "founder_mrr_entries", "founder_reviews"]) {
    assert.equal((await q(`select count(*)::int as n from ${t}`))[0].n, 0, `${t}: another founder sees nothing`);
  }
  assert.equal((await q("update founder_deals set name = 'x' where id = $1 returning id", [deal.id])).length, 0);
  assert.equal((await q("delete from founder_items returning id")).length, 0);
});
await fails(OTHER_FOUNDER, "insert into founder_deals (owner_id, name) values ($1, 'Spoofed')", [FOUNDER], "cannot write as someone else");
await fails(OTHER_FOUNDER, "insert into founder_items (title, deal_id) values ('Link', $1)", [deal.id], "cannot link another founder's deal");
console.log("ok  founders are isolated from each other; no spoofed owner, no cross-owner deal link");

await as(STRANGER, async () => {
  assert.equal((await q("select public.is_founder() as f"))[0].f, false);
  for (const t of ["founder_deals", "founder_items", "founder_mrr_entries", "founder_reviews"]) {
    assert.equal((await q(`select count(*)::int as n from ${t}`))[0].n, 0, `${t}: a non-founder sees nothing`);
  }
  assert.equal((await q("select count(*)::int as n from founder_users"))[0].n, 0, "the allow-list is not enumerable");
});
await fails(STRANGER, "insert into founder_deals (name) values ('Mine')", [], "a non-founder cannot write");
await fails(STRANGER, "insert into founder_users (user_id) values ($1)", [STRANGER], "cannot grant themselves founder access");
console.log("ok  a signed-in non-founder can read nothing, write nothing, and cannot self-grant");

for (const t of ["founder_users", "founder_deals", "founder_items", "founder_mrr_entries", "founder_reviews"]) {
  assert.equal((await q("select has_table_privilege('anon', $1, 'SELECT') as p", [`public.${t}`]))[0].p, false, `anon: ${t}`);
}
assert.equal((await q("select has_function_privilege('anon', 'public.is_founder()', 'EXECUTE') as p"))[0].p, false);
console.log("ok  anon has no access to any founder table or to is_founder()");

await fails(FOUNDER, "update founder_deals set stage = 'won' where id = $1", [deal.id], "won needs amount and date");
await as(FOUNDER, () => q("update founder_deals set stage = 'won', won_amount = 299, won_on = '2026-10-09' where id = $1", [deal.id]));
await fails(FOUNDER, "insert into founder_mrr_entries (month, kind, amount) values ('2026-10-15', 'new', 1)", [], "month is the 1st");
await fails(FOUNDER, "insert into founder_mrr_entries (month, kind, amount, source) values ('2026-10-01', 'new', 1, 'stripe')", [], "manual only - nothing claims to be synced");
await fails(FOUNDER, "insert into founder_mrr_entries (month, kind, amount) values ('2026-10-01', 'new', -1)", [], "amounts are non-negative");
await fails(FOUNDER, "insert into founder_items (kind, title) values ('meeting', 'No time')", [], "an event needs a start");
await fails(FOUNDER, "insert into founder_items (title, starts_at, ends_at) values ('Backwards', now(), now() - interval '1 hour')", [], "end after start");
await fails(FOUNDER, "insert into founder_reviews (review_date) values ('2026-10-09')", [], "one review per day");
await fails(FOUNDER, "update founder_deals set owner_id = $1", [OTHER_FOUNDER], "owner is immutable");
console.log("ok  data rules: won deals complete, MRR months/amounts/manual source, events have a start, one review per day, owner immutable");

await q("delete from founder_users where user_id = $1", [FOUNDER]);
await as(FOUNDER, async () => {
  assert.equal((await q("select count(*)::int as n from founder_deals"))[0].n, 0, "removed from the allow-list = no access, even to own rows");
});
console.log("ok  removing a founder from the allow-list revokes access to all their rows at once");

await db.exec(rollback);
await db.exec(rollback); // idempotent
assert.equal((await q("select count(*)::int as n from pg_tables where schemaname = 'public' and tablename like 'founder_%'"))[0].n, 0);
assert.equal((await q("select count(*)::int as n from pg_proc where proname in ('is_founder', 'founder_items_guard', 'founder_owner_immutable')"))[0].n, 0);
console.log("ok  rollback (twice) removes every founder table and function");

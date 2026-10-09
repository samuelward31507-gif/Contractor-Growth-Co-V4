// Founder sales OS: applies founder_command_center.sql, founder_daily_focus.sql
// and founder_sales_os.sql (twice) to an in-memory Postgres (PGlite) and
// proves the rules: legacy stages map 1:1, unsplittable legacy wins abort the
// migration untouched, the activity history is append-only and owner-scoped,
// stage/outcome changes only go through the functions (atomic with their
// activity), stale and duplicate requests are refused / ignored, wins need
// terms and losses a reason, and the rollback is non-destructive and lets
// the previous build write again.
//   cd supabase/pending/scratch && node validate-founder-sales-os.mjs
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const file = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const base = file("founder_command_center.sql");
const focus = file("founder_daily_focus.sql");
const forward = file("founder_sales_os.sql");
const rollback = file("founder_sales_os_rollback.sql");
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // signed in, not a founder
let n = 0;
const rid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

async function freshDb() {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema if not exists auth;
    create table auth.users (id uuid primary key);
    grant usage on schema auth to authenticated, service_role;
    create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('trackpr.test_uid', true), '')::uuid $$;
    create or replace function public.set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = clock_timestamp(); return new; end $$;
    grant usage on schema public to authenticated, anon, service_role;
  `);
  await db.query("insert into auth.users (id) values ($1), ($2), ($3)", [A, B, C]);
  await db.exec(base);
  await db.exec(focus);
  await db.query("insert into founder_users (user_id) values ($1), ($2)", [A, B]);
  return db;
}

function helpers(db) {
  const q = async (sql, params = []) => (await db.query(sql, params)).rows;
  async function as(uid, fn, role = "authenticated") {
    if (uid) await db.exec(`set trackpr.test_uid = '${uid}'`);
    await db.exec(`set role ${role}`);
    try { return await fn(); } finally { await db.exec("reset role"); await db.exec("reset trackpr.test_uid"); }
  }
  const rejects = async (uid, sql, params, code, label, role) => as(uid, async () => {
    let err;
    try { await db.query(sql, params); } catch (e) { err = e; }
    assert.ok(err, `${label}: expected an error`);
    if (code) assert.equal(err.code, code, `${label}: ${err.message}`);
  }, role);
  return { q, as, rejects };
}

// --- 1. Abort on legacy data that can't be carried over honestly -------------------
{
  const db = await freshDb();
  const { q } = helpers(db);
  await q("insert into founder_deals (owner_id, name, stage, won_amount, won_on) values ($1, 'Legacy win', 'won', 4000, '2026-09-01')", [A]);
  await assert.rejects(db.exec(forward), /no separate setup and monthly terms/);
  await db.exec("rollback");
  assert.equal((await q("select count(*)::int n from information_schema.tables where table_name = 'founder_deal_activities'"))[0].n, 0);
  assert.equal((await q("select stage from founder_deals"))[0].stage, "won");
  assert.equal((await q("select count(*)::int n from information_schema.columns where table_name = 'founder_deals' and column_name = 'won_setup_fee'"))[0].n, 0);
  console.log("ok  a legacy win without separate terms stops the migration and changes nothing");
}

// --- 2. Forward on legacy rows, twice ------------------------------------------------
const db = await freshDb();
const { q, as, rejects } = helpers(db);
await q("insert into founder_deals (owner_id, name, stage) values ($1, 'Old lead', 'lead'), ($1, 'Old contacted', 'contacted'), ($1, 'Old demo', 'demo_proposal'), ($1, 'Old nego', 'negotiation')", [A]);
await q("insert into founder_deals (owner_id, name, stage, lost_reason) values ($1, 'Old lost', 'lost', 'Budget')", [A]);
await db.exec(forward);
await db.exec(forward);
assert.deepEqual(
  (await q("select name, stage, entered_stage from founder_deals order by name")).map((r) => `${r.name}:${r.stage}:${r.entered_stage}`),
  ["Old contacted:outreach:outreach", "Old demo:proposal_sent:proposal_sent", "Old lead:identified:identified", "Old lost:lost:lost", "Old nego:negotiation:negotiation"],
);
assert.equal((await q("select count(*)::int n from founder_deals where stage_changed_at is null"))[0].n, 0);
assert.equal((await q("select lost_on is not null as ok from founder_deals where name = 'Old lost'"))[0].ok, true);
console.log("ok  applies twice; legacy stages map 1:1 and existing rows get an honest snapshot (entered_stage = current stage)");

// --- 3. Direct writes are refused -----------------------------------------------------
const [{ id: dealA }] = await as(A, () => q("insert into founder_deals (name, stage) values ('Acme Roofing', 'qualified') returning id"));
const deal = async (id = dealA) => (await q("select * from founder_deals where id = $1", [id]))[0];
let d = await deal();
assert.equal(d.entered_stage, "qualified");
assert.equal(d.currency, "USD");
await rejects(A, "insert into founder_deals (name, stage, won_setup_fee, won_monthly_fee, won_on) values ('Instant win', 'won', 1, 1, '2026-10-01')", [], "FS422", "a deal can't be created already won");
await rejects(A, "update founder_deals set stage = 'meeting_held' where id = $1", [dealA], "FS422", "direct stage change refused");
await rejects(A, "update founder_deals set last_activity_at = now() where id = $1", [dealA], "FS422", "history fields refused");
for (const set of ["won_setup_fee = 1", "won_monthly_fee = 1", "won_amount = 1", "won_on = '2026-10-01'", "lost_reason = 'x'", "lost_on = '2026-10-01'", "entered_stage = 'won'", "stage_changed_at = now()"]) {
  await rejects(A, `update founder_deals set ${set} where id = $1`, [dealA], "FS422", `direct write refused: ${set}`);
}
await as(A, () => q("update founder_deals set trade = 'Roofing', expected_setup_fee = 2500, expected_mrr = 1497 where id = $1", [dealA]));
await rejects(A, "insert into founder_deal_activities (owner_id, deal_id, kind, occurred_at) values ($1, $2, 'outreach', now())", [A, dealA], "42501", "clients can't insert activities");
await rejects(A, "select * from founder_change_deal_stage($1, $2, 'outreach', now())", [rid(), dealA], null, "non-null args only", "anon");
console.log("ok  stage/outcome/history fields and the activity table can't be written directly; other deal fields still edit");

// --- 4. Stage changes: stale, duplicate, transitions ----------------------------------
d = await deal();
await rejects(A, "select founder_change_deal_stage($1, $2, 'outreach', $3)", [rid(), dealA, "2020-01-01T00:00:00Z"], "FS409", "stale version refused");
const req1 = rid();
const r1 = await as(A, () => q("select founder_change_deal_stage($1, $2, 'outreach', $3) r", [req1, dealA, d.updated_at]));
assert.equal(r1[0].r.status, "recorded");
const r1again = await as(A, () => q("select founder_change_deal_stage($1, $2, 'outreach', $3) r", [req1, dealA, d.updated_at]));
assert.equal(r1again[0].r.status, "duplicate", "a retried request is acknowledged, not repeated");
assert.equal((await q("select count(*)::int n from founder_deal_activities where deal_id = $1", [dealA]))[0].n, 1);
d = await deal();
assert.equal(d.stage, "outreach");
await rejects(A, "select founder_change_deal_stage($1, $2, 'outreach', $3)", [rid(), dealA, d.updated_at], "FS422", "same stage refused");
await rejects(A, "select founder_change_deal_stage($1, $2, 'bogus', $3)", [rid(), dealA, d.updated_at], "FS422", "unknown stage refused");
await rejects(A, "select founder_change_deal_stage($1, $2, 'won', $3)", [rid(), dealA, d.updated_at], "FS422", "won needs terms");
await rejects(A, "select founder_change_deal_stage($1, $2, 'won', $3, null, null, 1497, 'USD', '2026-10-01')", [rid(), dealA, d.updated_at], "FS422", "won needs a setup fee");
await rejects(A, "select founder_change_deal_stage($1, $2, 'won', $3, null, 2500, -1, 'USD', '2026-10-01')", [rid(), dealA, d.updated_at], "FS422", "fees can't be negative");
await rejects(A, "select founder_change_deal_stage($1, $2, 'won', $3, null, 2500, 1497, 'US', '2026-10-01')", [rid(), dealA, d.updated_at], "FS422", "three-letter currency");
await rejects(A, "select founder_change_deal_stage($1, $2, 'won', $3, null, 2500, 1497, 'USD', '2999-01-01')", [rid(), dealA, d.updated_at], "FS422", "won date can't be in the future");
await rejects(A, "select founder_change_deal_stage($1, $2, 'lost', $3, null, null, null, null, null, '  ')", [rid(), dealA, d.updated_at], "FS422", "lost needs a reason");
assert.equal((await q("select count(*)::int n from founder_deal_activities where deal_id = $1", [dealA]))[0].n, 1, "refused changes record nothing");
await as(A, () => q("select founder_change_deal_stage($1, $2, 'won', $3, null, 2500, 1497, 'usd', '2026-10-01', 'Signed after audit')", [rid(), dealA, d.updated_at]));
d = await deal();
assert.deepEqual([d.stage, Number(d.won_setup_fee), Number(d.won_monthly_fee), d.currency, d.won_amount], ["won", 2500, 1497, "USD", null]);
const won = (await q("select * from founder_deal_activities where deal_id = $1 and kind = 'won'", [dealA]))[0];
assert.deepEqual([won.from_stage, won.to_stage, Number(won.setup_fee), Number(won.monthly_fee), won.currency], ["outreach", "won", 2500, 1497, "USD"]);
await rejects(A, "select founder_change_deal_stage($1, $2, 'lost', $3, null, null, null, null, null, 'Changed mind')", [rid(), dealA, d.updated_at], "FS422", "won -> lost must reopen first");
await as(A, () => q("select founder_change_deal_stage($1, $2, 'negotiation', $3, null, null, null, null, null, 'Terms reopened')", [rid(), dealA, d.updated_at]));
d = await deal();
assert.deepEqual([d.stage, d.won_setup_fee, d.won_on], ["negotiation", null, null], "reopening clears the outcome on the deal");
assert.equal((await q("select count(*)::int n from founder_deal_activities where deal_id = $1 and kind = 'reopened'", [dealA]))[0].n, 1);
assert.equal((await q("select count(*)::int n from founder_deal_activities where deal_id = $1 and kind = 'won'", [dealA]))[0].n, 1, "the original win stays in history");
await as(A, () => q("select founder_change_deal_stage($1, $2, 'lost', $3, null, null, null, null, null, 'Went with a competitor')", [rid(), dealA, d.updated_at]));
d = await deal();
assert.deepEqual([d.stage, d.lost_reason, d.lost_on != null], ["lost", "Went with a competitor", true]);
console.log("ok  stage changes: stale refused, retries idempotent, wins need terms (snapshot kept), losses need a reason, reopen recorded");

// --- 5. Logging evidence ---------------------------------------------------------------
const [{ id: dealB2 }] = await as(A, () => q("insert into founder_deals (name) values ('Beta Plumbing') returning id"));
d = await deal(dealB2);
await rejects(A, "select founder_log_deal_activity($1, $2, 'outreach', now() + interval '1 day')", [rid(), dealB2], "FS422", "no future events");
await rejects(A, "select founder_log_deal_activity($1, $2, 'paid', now())", [rid(), dealB2], "FS422", "unknown kinds refused (payments aren't sales activity)");
await rejects(A, "select founder_log_deal_activity($1, $2, 'outreach', now(), 'pigeon')", [rid(), dealB2], "FS422", "unknown channel");
await rejects(A, "select founder_log_deal_activity($1, $2, 'outreach', now(), 'email', null, now())", [rid(), dealB2], "FS422", "scheduled time only for booked meetings");
await rejects(A, "select founder_log_deal_activity($1, $2, 'reply_received', now(), 'email', null, null, 'won', $3)", [rid(), dealB2, d.updated_at], "FS422", "can't win via logging");
await rejects(A, "select founder_log_deal_activity($1, $2, 'reply_received', now(), 'email', null, null, 'replied', '2020-01-01')", [rid(), dealB2], "FS409", "stale stage advance");
assert.equal((await q("select count(*)::int n from founder_deal_activities where deal_id = $1", [dealB2]))[0].n, 0, "a refused advance records no evidence either (atomic)");
const ev = rid();
await as(A, () => q("select founder_log_deal_activity($1, $2, 'outreach', now() - interval '2 days', 'email', 'Intro email')", [ev, dealB2]));
await as(A, () => q("select founder_log_deal_activity($1, $2, 'outreach', now() - interval '2 days', 'email', 'Intro email')", [ev, dealB2]));
assert.equal((await q("select count(*)::int n from founder_deal_activities where deal_id = $1", [dealB2]))[0].n, 1, "duplicate evidence is ignored");
d = await deal(dealB2);
assert.equal(d.stage, "identified", "logging without a stage leaves the stage alone");
assert.ok(d.last_activity_at, "last_activity_at follows recorded activity");
await as(A, () => q("select founder_log_deal_activity($1, $2, 'reply_received', now(), 'email', 'Interested', null, 'replied', $3)", [rid(), dealB2, d.updated_at]));
d = await deal(dealB2);
assert.equal(d.stage, "replied");
assert.deepEqual((await q("select kind, from_stage, to_stage from founder_deal_activities where deal_id = $1 order by recorded_at, kind", [dealB2])).map((r) => `${r.kind}:${r.from_stage}:${r.to_stage}`).sort(), ["outreach:null:null", "reply_received:null:null", "stage_change:identified:replied"]);
const meet = rid();
await as(A, () => q("select founder_log_deal_activity($1, $2, 'meeting_booked', now(), 'video', null, now() + interval '3 days')", [meet, dealB2]));
console.log("ok  evidence: past only, valid kinds/channels, optional atomic stage advance, duplicates ignored");

// --- 6. Isolation and authorization --------------------------------------------------
await rejects(B, "select founder_log_deal_activity($1, $2, 'note', now())", [rid(), dealB2], "FS404", "another founder can't log on A's deal");
await rejects(B, "select founder_change_deal_stage($1, $2, 'qualified', now())", [rid(), dealB2], "FS404", "another founder can't move A's deal");
await rejects(C, "select founder_log_deal_activity($1, $2, 'note', now())", [rid(), dealB2], "FS404", "a non-founder can't use the functions");
await as(B, async () => {
  assert.equal((await q("select count(*)::int n from founder_deal_activities"))[0].n, 0, "B sees none of A's history");
  const [{ id }] = await q("insert into founder_deals (name) values ('B deal') returning id");
  await assert.rejects(q("select founder_log_deal_activity($1, $2, 'note', now())", [ev, id]), /request id already used/, "A's request id can't be replayed onto B's deal");
});
await as(C, async () => assert.equal((await q("select count(*)::int n from founder_deal_activities"))[0].n, 0, "non-founder sees nothing"));
const [{ id: bDeal }] = await q("select id from founder_deals where owner_id = $1 limit 1", [B]);
await q("delete from founder_users where user_id = $1", [B]);
await rejects(B, "select founder_log_deal_activity($1, $2, 'note', now())", [rid(), bDeal], "FS404", "a removed founder can't write even to deals they still own");
await rejects(B, "select founder_change_deal_stage($1, $2, 'qualified', now())", [rid(), bDeal], "FS404", "a removed founder can't move their old deals");
await q("insert into founder_users (user_id) values ($1)", [B]);
console.log("ok  owner-scoped: other founders and non-founders can't read, log, move or replay");

// --- 7. Append-only, void, delete ------------------------------------------------------
await rejects(A, "select founder_void_deal_activity($1, ' ')", [meet], "FS422", "void needs a reason");
await as(A, () => q("select founder_void_deal_activity($1, 'Wrong prospect')", [meet]));
assert.equal((await as(A, () => q("select founder_void_deal_activity($1, 'again') r", [meet])))[0].r.status, "duplicate");
const stageRow = (await q("select id from founder_deal_activities where deal_id = $1 and kind = 'stage_change'", [dealB2]))[0].id;
await rejects(A, "select founder_void_deal_activity($1, 'nope')", [stageRow], "FS422", "stage history can't be voided");
await rejects(null, "update founder_deal_activities set summary = 'rewritten' where id = $1", [ev], "FS403", "even the service role can't rewrite history", "service_role");
await rejects(null, "update founder_deal_activities set voided_at = null, void_reason = null where id = $1", [meet], "FS403", "a void can't be undone", "service_role");
await rejects(null, "update founder_deal_activities set voided_at = now(), void_reason = 'cover', summary = 'rewritten' where id = $1", [ev], "FS403", "voiding can't smuggle in an edit", "service_role");
await rejects(null, "delete from founder_deal_activities where id = $1", [ev], "FS403", "history can't be deleted while the deal exists", "service_role");
await rejects(A, "delete from founder_deals where id = $1", [dealB2], "23503", "a deal with history can't be deleted");
const [{ id: typo }] = await as(A, () => q("insert into founder_deals (name) values ('Typo') returning id"));
await as(A, async () => assert.equal((await q("delete from founder_deals where id = $1 returning id", [typo])).length, 1, "a deal with no history can be deleted"));
console.log("ok  append-only: one-time void with reason for evidence only; no rewrites, no deletes; deals with history kept");

// --- 8. Rollback: non-destructive, previous build can write -----------------------------
const before = { acts: (await q("select count(*)::int n from founder_deal_activities"))[0].n, deals: (await q("select count(*)::int n from founder_deals"))[0].n };
await db.exec(rollback);
await db.exec(rollback);
assert.equal((await q("select count(*)::int n from founder_deal_activities"))[0].n, before.acts, "history kept");
assert.equal((await q("select count(*)::int n from founder_deals"))[0].n, before.deals, "deals kept");
assert.equal((await q("select count(*)::int n from information_schema.columns where table_name = 'founder_deals' and column_name in ('won_setup_fee','won_monthly_fee','source','last_activity_at')"))[0].n, 4, "new columns kept");
assert.equal((await q("select count(*)::int n from pg_proc where proname in ('founder_change_deal_stage','founder_log_deal_activity','founder_void_deal_activity','founder_deals_sales_guard')"))[0].n, 0, "write paths removed");
assert.equal((await q("select stage from founder_deals where id = $1", [dealB2]))[0].stage, "replied", "stage values not rewritten");
await as(A, async () => {
  await q("insert into founder_deals (name, stage) values ('Old build lead', 'lead')");
  await q("insert into founder_deals (name, stage, won_amount, won_on) values ('Old build win', 'won', 3000, '2026-10-02')");
  await q("update founder_deals set stage = 'contacted' where name = 'Old build lead'");
  assert.equal((await q("select count(*)::int n from founder_deal_activities"))[0].n, before.acts, "RLS still scopes history");
});
await rejects(null, "delete from founder_deal_activities where id = $1", [ev], "FS403", "history still append-only after rollback", "service_role");
await rejects(A, "select founder_log_deal_activity($1, $2, 'note', now())", [rid(), dealB2], "42883", "functions are gone");
console.log("ok  rollback (twice): functions/guard removed, old-build writes work, every deal, column and activity kept");

// --- 9. Re-apply after rollback ---------------------------------------------------------
await assert.rejects(db.exec(forward), /no separate setup and monthly terms/, "a win recorded by the old build stops re-apply");
await db.exec("rollback");
assert.equal((await q("select count(*)::int n from founder_deals where stage = 'lead'"))[0].n, 0, "nothing half-applied");
assert.equal((await q("select count(*)::int n from founder_deals where stage = 'contacted'"))[0].n, 1);
await q("update founder_deals set won_setup_fee = 2500, won_monthly_fee = 500 where name = 'Old build win'");
await db.exec(forward);
assert.equal((await q("select stage from founder_deals where name = 'Old build lead'"))[0].stage, "outreach");
assert.equal((await q("select count(*)::int n from founder_deal_activities"))[0].n, before.acts);
console.log("ok  re-apply after rollback: stops on unsplit wins until fixed, then maps legacy stages and keeps history");

// --- 10. Account deletion still cascades -------------------------------------------------
await q("delete from auth.users where id = $1", [A]);
assert.equal((await q("select count(*)::int n from founder_deal_activities"))[0].n, 0);
console.log("ok  deleting the user account cascades (the append-only rule blocks only direct deletes)");
console.log("all founder sales OS checks passed");

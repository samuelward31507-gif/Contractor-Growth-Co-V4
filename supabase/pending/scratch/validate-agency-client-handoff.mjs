// Deal-to-client handoff: applies founder_command_center.sql,
// founder_daily_focus.sql, founder_sales_os.sql, a faithful copy of the
// agency foundation (agency_admins + is_agency_admin()) and
// agency_client_handoff.sql (twice) to an in-memory Postgres (PGlite), and
// proves: who may prepare / confirm / cancel / read, missing-field refusals,
// duplicate and concurrent-request safety, the stale-deal refusal, that a
// failure inside confirm leaves nothing partial, cancel-and-re-prepare
// recovery, that deal terms and activity history are never touched, and a
// non-destructive rollback.
//   cd supabase/pending/scratch && node validate-agency-client-handoff.mjs
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const file = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // founder (not an agency admin)
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // another founder
const ADM = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // agency admin (not a founder)
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // signed in, neither
let n = 0;
const rid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

const db = new PGlite();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
async function as(uid, fn, role = "authenticated") {
  if (uid) await db.exec(`set trackpr.test_uid = '${uid}'`);
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally { await db.exec("reset role"); await db.exec("reset trackpr.test_uid"); }
}
async function rejects(uid, sql, params, code, label, role) {
  await as(uid, async () => {
    let err;
    try { await db.query(sql, params); } catch (e) { err = e; }
    assert.ok(err, `${label}: expected an error`);
    if (code) assert.equal(err.code, code, `${label}: ${err.message}`);
  }, role);
}
const errorOf = async (uid, sql, params) => as(uid, async () => { try { await db.query(sql, params); return null; } catch (e) { return e; } });

await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema if not exists auth;
  create table auth.users (id uuid primary key);
  grant usage on schema auth to authenticated, service_role;
  create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('trackpr.test_uid', true), '')::uuid $$;
  create or replace function public.set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = clock_timestamp(); return new; end $$;
  grant usage on schema public to authenticated, anon, service_role;
`);
await q("insert into auth.users (id) values ($1), ($2), ($3), ($4)", [A, B, ADM, C]);
await db.exec(file("founder_command_center.sql"));
await db.exec(file("founder_daily_focus.sql"));
await db.exec(file("founder_sales_os.sql"));
// The agency foundation as deployed (20260918182032_agency_command_center_foundation.sql), minus agency_organizations (needs organizations).
await db.exec(`
  create table public.agency_admins (id uuid primary key default gen_random_uuid(), user_id uuid not null unique references auth.users(id) on delete cascade, created_at timestamptz not null default now());
  alter table public.agency_admins enable row level security;
  create policy agency_admins_select_self on public.agency_admins for select using (user_id = auth.uid());
  create or replace function public.is_agency_admin() returns boolean language sql stable security definer set search_path to 'public' as $$ select exists (select 1 from public.agency_admins where user_id = auth.uid()); $$;
  grant execute on function public.is_agency_admin() to authenticated;
`);
await q("insert into founder_users (user_id) values ($1), ($2)", [A, B]);
await q("insert into agency_admins (user_id) values ($1)", [ADM]);
const forward = file("agency_client_handoff.sql");
const rollback = file("agency_client_handoff_rollback.sql");
await db.exec(forward);
await db.exec(forward);
console.log("ok  applies twice on top of the founder + sales + agency schemas");

// A won deal for A, through the real sales functions.
async function wonDeal(name, fields = {}) {
  return as(A, async () => {
    const [{ id, updated_at }] = await q(
      "insert into founder_deals (name, stage, contact_name, contact_email, contact_phone) values ($1, 'negotiation', $2, $3, $4) returning id, updated_at",
      [name, fields.contactName === undefined ? "Dana Reyes" : fields.contactName, fields.email === undefined ? "dana@example.com" : fields.email, fields.phone ?? null],
    );
    await q("select founder_change_deal_stage($1, $2, 'won', $3, null, 2500, 1497, 'USD', '2026-10-01')", [rid(), id, updated_at]);
    return id;
  });
}
const SCOPE = "Lead response automation, follow-up sequences and monthly reporting.";
const prepare = (uid, request, deal, scope = SCOPE) => as(uid, async () => (await q("select founder_prepare_client_handoff($1, $2, $3) r", [request, deal, scope]))[0].r);
const confirm = (uid, handoff) => as(uid, async () => (await q("select agency_confirm_client_handoff($1) r", [handoff]))[0].r);
const count = async (table, where = "true", params = []) => (await q(`select count(*)::int n from ${table} where ${where}`, params))[0].n;

// --- 1. Missing information --------------------------------------------------------------
const [{ id: openDeal }] = await as(A, () => q("insert into founder_deals (name, stage) values ('Still open', 'negotiation') returning id"));
let err = await errorOf(A, "select founder_prepare_client_handoff($1, $2, $3)", [rid(), openDeal, SCOPE]);
assert.equal(err?.code, "FS422");
assert.match(err.message, /the deal must be won/);
const noContact = await wonDeal("No contact", { contactName: null, email: null });
err = await errorOf(A, "select founder_prepare_client_handoff($1, $2, $3)", [rid(), noContact, "short"]);
assert.match(err.message, /a decision-maker name; a contact email or phone; a written scope/);
assert.equal(await count("agency_client_handoffs"), 0, "refusals record nothing");
console.log("ok  missing information is listed and nothing is recorded (not won, no decision-maker, no contact route, no scope)");

// --- 2. Who may prepare -----------------------------------------------------------------
const deal1 = await wonDeal("Acme Roofing");
const dealSnapshot = async (id) => JSON.stringify({ deal: (await q("select * from founder_deals where id = $1", [id]))[0], acts: await q("select * from founder_deal_activities where deal_id = $1 order by recorded_at, id", [id]) });
const before1 = await dealSnapshot(deal1);
await rejects(ADM, "select founder_prepare_client_handoff($1, $2, $3)", [rid(), deal1, SCOPE], "FS404", "an agency admin who isn't the founder can't prepare");
await rejects(B, "select founder_prepare_client_handoff($1, $2, $3)", [rid(), deal1, SCOPE], "FS404", "another founder can't prepare on A's deal");
await rejects(C, "select founder_prepare_client_handoff($1, $2, $3)", [rid(), deal1, SCOPE], "FS404", "a non-founder can't prepare");
await rejects(null, "select founder_prepare_client_handoff($1, $2, $3)", [rid(), deal1, SCOPE], "42501", "anon can't call it", "anon");
await q("delete from founder_users where user_id = $1", [A]);
await rejects(A, "select founder_prepare_client_handoff($1, $2, $3)", [rid(), deal1, SCOPE], "FS404", "a founder removed from the allow-list can't prepare, even on deals they still own");
await q("insert into founder_users (user_id) values ($1)", [A]);
console.log("ok  only the deal's own founder can prepare");

// --- 3. Prepare: idempotent, one live handoff per deal -------------------------------------
const h1 = rid();
assert.deepEqual(await prepare(A, h1, deal1), { status: "prepared", handoff_id: h1, handoff_status: "prepared" });
assert.deepEqual(await prepare(A, h1, deal1), { status: "duplicate", handoff_id: h1, handoff_status: "prepared" }, "a retried request is a no-op");
assert.deepEqual(await prepare(A, rid(), deal1), { status: "exists", handoff_id: h1, handoff_status: "prepared" }, "a second request (another tab, double click) gets the existing handoff");
assert.equal(await count("agency_client_handoffs", "deal_id = $1", [deal1]), 1);
const deal2 = await wonDeal("Birch Plumbing");
await rejects(A, "select founder_prepare_client_handoff($1, $2, $3)", [h1, deal2, SCOPE], "FS422", "a request id can't be replayed onto another deal");
const row1 = (await q("select * from agency_client_handoffs where id = $1", [h1]))[0];
assert.deepEqual(
  [row1.client_name, row1.contact_name, row1.contact_email, Number(row1.setup_fee), Number(row1.monthly_fee), row1.currency, row1.scope, row1.prepared_by, row1.founder_owner_id],
  ["Acme Roofing", "Dana Reyes", "dana@example.com", 2500, 1497, "USD", SCOPE, A, A],
);
console.log("ok  prepare snapshots only the approved fields; retries and second requests never create a second handoff");

// --- 4. Reads and direct writes -----------------------------------------------------------
await as(A, async () => {
  assert.equal((await q("select count(*)::int n from agency_client_handoffs"))[0].n, 1, "the founder sees their handoff status");
  assert.equal((await q("select count(*)::int n from agency_clients"))[0].n, 0);
});
await as(B, async () => assert.equal((await q("select count(*)::int n from agency_client_handoffs"))[0].n, 0, "other founders see nothing"));
await as(C, async () => assert.equal((await q("select count(*)::int n from agency_client_handoffs"))[0].n, 0));
await as(ADM, async () => assert.equal((await q("select count(*)::int n from agency_client_handoffs"))[0].n, 1, "agency admins see prepared handoffs"));
await rejects(A, "insert into agency_clients (name, contact_name, contact_email, setup_fee, monthly_fee, currency, scope) values ('x', 'y', 'z@z.z', 1, 1, 'USD', 'ten chars!!')", [], "42501", "no direct client creation (founder)");
await rejects(ADM, "insert into agency_clients (name, contact_name, contact_email, setup_fee, monthly_fee, currency, scope) values ('x', 'y', 'z@z.z', 1, 1, 'USD', 'ten chars!!')", [], "42501", "no direct client creation (admin)");
await rejects(ADM, "update agency_client_handoffs set status = 'confirmed' where id = $1", [h1], "42501", "no direct status changes");
await rejects(A, "insert into agency_client_handoffs (deal_id, founder_owner_id, client_name, contact_name, contact_email, setup_fee, monthly_fee, currency, scope, prepared_by) values ($1, $2, 'x', 'y', 'z@z.z', 1, 1, 'USD', 'ten chars!!', $2)", [deal2, A], "42501", "no direct handoffs");
console.log("ok  founder sees only their own handoff status, never Agency clients; nobody writes the tables directly");

// --- 5. Confirm --------------------------------------------------------------------------------
await rejects(A, "select agency_confirm_client_handoff($1)", [h1], "FS404", "the founder alone can't confirm (not an agency admin)");
await rejects(B, "select agency_confirm_client_handoff($1)", [h1], "FS404", "another founder can't confirm");
await rejects(C, "select agency_confirm_client_handoff($1)", [h1], "FS404", "a non-admin can't confirm");
const confirmed = await confirm(ADM, h1);
assert.equal(confirmed.status, "confirmed");
const clientId = confirmed.agency_client_id;
assert.deepEqual(await confirm(ADM, h1), { status: "duplicate", agency_client_id: clientId }, "a repeated confirm returns the same client");
assert.equal(await count("agency_clients"), 1);
const client = (await q("select * from agency_clients where id = $1", [clientId]))[0];
assert.deepEqual(
  [client.name, client.contact_name, client.contact_email, Number(client.setup_fee), Number(client.monthly_fee), client.currency, client.scope, client.status, client.organization_id, client.source_deal_id, client.source_handoff_id, client.created_by],
  ["Acme Roofing", "Dana Reyes", "dana@example.com", 2500, 1497, "USD", SCOPE, "onboarding_not_started", null, deal1, h1, ADM],
);
const h1after = (await q("select status, confirmed_by, confirmed_at is not null as at, agency_client_id from agency_client_handoffs where id = $1", [h1]))[0];
assert.deepEqual(h1after, { status: "confirmed", confirmed_by: ADM, at: true, agency_client_id: clientId });
await as(A, async () => {
  assert.equal((await q("select count(*)::int n from agency_clients"))[0].n, 0, "even after confirmation the founder role can't read Agency clients");
  assert.equal((await q("select status from agency_client_handoffs where id = $1", [h1]))[0].status, "confirmed", "but sees that the handoff was confirmed");
});
await as(ADM, async () => assert.equal((await q("select count(*)::int n from agency_clients"))[0].n, 1));
assert.equal(await dealSnapshot(deal1), before1, "the deal's terms and activity history are unchanged");
err = await errorOf(A, "select cancel_client_handoff($1, 'changed my mind')", [h1]);
assert.equal(err?.code, "FS422");
assert.match(err.message, /confirmed - the Agency client already exists/, "a confirmed handoff can't be cancelled (and says why)");
assert.deepEqual(await prepare(A, rid(), deal1), { status: "exists", handoff_id: h1, handoff_status: "confirmed" }, "a won deal hands off once");
console.log("ok  confirm: agency admins only, creates exactly one client from the snapshot, idempotent, records who and when; deal untouched");

// --- 6. Duplicate-client backstops (whatever the timing) ------------------------------------------
await rejects(null, "insert into agency_clients (name, contact_name, contact_email, setup_fee, monthly_fee, currency, scope, source_deal_id) values ('Dup', 'y', 'z@z.z', 1, 1, 'USD', 'ten chars!!', $1)", [deal1], "23505", "one client per deal (unique source_deal_id)", "service_role");
await rejects(null, "insert into agency_client_handoffs (deal_id, founder_owner_id, client_name, contact_name, contact_email, setup_fee, monthly_fee, currency, scope, prepared_by) values ($1, $2, 'x', 'y', 'z@z.z', 1, 1, 'USD', 'ten chars!!', $2)", [deal1, A], "23505", "one live handoff per deal (unique index)", "service_role");
await rejects(null, "update agency_client_handoffs set scope = 'rewritten scope text' where id = $1", [h1], "FS422", "the snapshot can't be rewritten, even by the service role", "service_role");
await rejects(null, "update agency_client_handoffs set status = 'cancelled', cancelled_at = now(), cancel_reason = 'x', confirmed_at = null, confirmed_by = null, agency_client_id = null where id = $1", [h1], "FS422", "a confirmed handoff can't be un-confirmed", "service_role");
console.log("ok  database constraints stop a second client or a second live handoff even if requests race");

// --- 7. Stale deal, cancel and re-prepare (recovery) ------------------------------------------------
const h2 = rid();
await prepare(A, h2, deal2);
await as(A, () => q("update founder_deals set contact_email = 'new@example.com' where id = $1", [deal2]));
await rejects(ADM, "select agency_confirm_client_handoff($1)", [h2], "FS409", "the deal changed since preparing");
assert.equal(await count("agency_clients", "source_deal_id = $1", [deal2]), 0);
await rejects(A, "select cancel_client_handoff($1, ' ')", [h2], "FS422", "cancelling needs a reason");
await rejects(B, "select cancel_client_handoff($1, 'not mine')", [h2], "FS404", "another founder can't cancel");
await as(A, () => q("select cancel_client_handoff($1, 'Contact email changed')", [h2]));
assert.deepEqual(await as(A, async () => (await q("select cancel_client_handoff($1, 'again') r", [h2]))[0].r), { status: "duplicate" });
await rejects(ADM, "select agency_confirm_client_handoff($1)", [h2], "FS409", "a cancelled handoff can't be confirmed");
const h3 = rid();
assert.equal((await prepare(A, h3, deal2)).status, "prepared", "after cancelling, a fresh handoff can be prepared");
assert.equal((await q("select contact_email from agency_client_handoffs where id = $1", [h3]))[0].contact_email, "new@example.com");
assert.equal((await confirm(ADM, h3)).status, "confirmed");
assert.equal((await q("select status, cancel_reason, cancelled_by from agency_client_handoffs where id = $1", [h2]))[0].cancel_reason, "Contact email changed", "the cancelled handoff stays on record");
const deal3 = await wonDeal("Cedar HVAC");
const h4 = rid();
await prepare(A, h4, deal3);
await as(A, async () => {
  const [{ updated_at }] = await q("select updated_at from founder_deals where id = $1", [deal3]);
  await q("select founder_change_deal_stage($1, $2, 'negotiation', $3, null, null, null, null, null, 'Terms reopened')", [rid(), deal3, updated_at]);
});
await rejects(ADM, "select agency_confirm_client_handoff($1)", [h4], "FS409", "a reopened deal can't be confirmed");
await as(ADM, () => q("select cancel_client_handoff($1, 'Deal reopened')", [h4]));
const deal5 = await wonDeal("Elm Landscaping");
const h6 = rid();
await prepare(A, h6, deal5);
await as(ADM, () => q("select cancel_client_handoff($1, 'Client asked to wait')", [h6]));
err = await errorOf(ADM, "select agency_confirm_client_handoff($1)", [h6]);
assert.equal(err?.code, "FS409");
assert.match(err.message, /was cancelled/, "a cancelled handoff can't be confirmed even when the deal is unchanged");
assert.equal(await count("agency_clients", "source_deal_id = $1", [deal5]), 0);
console.log("ok  a changed or reopened deal is refused at confirm; cancel (founder or admin) and re-prepare recovers; history kept");

// --- 8. Partial failure inside confirm leaves nothing behind ------------------------------------------
const deal4 = await wonDeal("Dune Electric");
const h5 = rid();
await prepare(A, h5, deal4);
await db.exec(`create function public.zz_fail() returns trigger language plpgsql as $$ begin raise exception 'simulated failure'; end $$;
  create trigger zz_fail after insert on public.agency_clients for each row execute function public.zz_fail();`);
err = await errorOf(ADM, "select agency_confirm_client_handoff($1)", [h5]);
assert.match(err?.message ?? "", /simulated failure/);
assert.equal(await count("agency_clients", "source_deal_id = $1", [deal4]), 0, "no client left behind");
assert.equal((await q("select status from agency_client_handoffs where id = $1", [h5]))[0].status, "prepared", "the handoff is still prepared - retry is safe");
await db.exec("drop trigger zz_fail on public.agency_clients; drop function public.zz_fail();");
assert.equal((await confirm(ADM, h5)).status, "confirmed", "retrying after the failure succeeds once");
assert.equal(await count("agency_clients", "source_deal_id = $1", [deal4]), 1);
console.log("ok  a failure during confirm rolls back completely; retrying confirms exactly once");

// --- 9. Rollback: non-destructive ------------------------------------------------------------------------
const kept = { handoffs: await count("agency_client_handoffs"), clients: await count("agency_clients") };
await db.exec(rollback);
await db.exec(rollback);
assert.equal(await count("agency_client_handoffs"), kept.handoffs);
assert.equal(await count("agency_clients"), kept.clients);
assert.equal((await q("select count(*)::int n from pg_proc where proname in ('founder_prepare_client_handoff','agency_confirm_client_handoff','cancel_client_handoff','founder_handoff_missing')"))[0].n, 0);
await as(ADM, async () => assert.equal((await q("select count(*)::int n from agency_clients"))[0].n, kept.clients, "admins can still read what was recorded"));
await as(A, async () => assert.equal((await q("select count(*)::int n from agency_clients"))[0].n, 0, "founder still can't"));
await rejects(null, "update agency_client_handoffs set scope = 'rewritten scope text' where id = $1", [h1], "FS422", "snapshots stay protected after rollback", "service_role");
await rejects(A, "select founder_prepare_client_handoff($1, $2, $3)", [rid(), deal1, SCOPE], "42883", "no new handoffs after rollback");
await db.exec(forward);
assert.deepEqual(await prepare(A, rid(), deal1), { status: "exists", handoff_id: h1, handoff_status: "confirmed" }, "re-applying restores the functions over the kept data");
console.log("ok  rollback (twice) removes the write paths and keeps every handoff, client, policy and guard; re-apply works");

// --- 10. Account removal ---------------------------------------------------------------------------------
await q("delete from auth.users where id = $1", [A]);
assert.equal(await count("agency_client_handoffs"), 0);
assert.equal(await count("agency_clients"), kept.clients, "Agency clients outlive the founder account");
assert.equal(await count("agency_clients", "source_deal_id is not null or source_handoff_id is not null"), 0);
console.log("ok  deleting the founder account removes their handoffs; Agency clients remain (links cleared)");
console.log("all agency client handoff checks passed");

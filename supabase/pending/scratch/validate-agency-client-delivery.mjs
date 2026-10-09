// Agency client delivery (Phase 3): applies the founder, sales, agency
// foundation (agency_admins, organizations stub, agency_organizations),
// handoff and delivery SQL (twice) to an in-memory Postgres (PGlite),
// creates clients through the real Phase 2 handoff, and proves: admin-only
// access, immutable terms, scoped task generation and module additions,
// task transitions with reasons and evidence, the launch gate (in the
// database), launch evidence / acknowledgement / idempotency, explicit
// Trackpr linking limited to Agency-managed accounts, the append-only
// history, and a non-destructive rollback with Phase 2 still working.
//   cd supabase/pending/scratch && node validate-agency-client-delivery.mjs
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const file = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // founder
const ADM = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // agency admin
const ADM2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"; // second agency admin
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // signed in, neither
const ORG1 = "0f000000-0000-4000-8000-000000000001";
const ORG2 = "0f000000-0000-4000-8000-000000000002";
let n = 0;
const rid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

const db = new PGlite();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
async function as(uid, fn, role = "authenticated") {
  if (uid) await db.exec(`set trackpr.test_uid = '${uid}'`);
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally { await db.exec("reset role"); await db.exec("reset trackpr.test_uid"); }
}
const errorOf = async (uid, sql, params, role) => as(uid, async () => { try { await db.query(sql, params); return null; } catch (e) { return e; } }, role);
async function rejects(uid, sql, params, code, label, role) {
  const err = await errorOf(uid, sql, params, role);
  assert.ok(err, `${label}: expected an error`);
  if (code) assert.equal(err.code, code, `${label}: ${err.message}`);
  return err;
}
const one = async (uid, sql, params = []) => as(uid, async () => (await q(sql, params))[0]);
const count = async (table, where = "true", params = []) => (await q(`select count(*)::int n from ${table} where ${where}`, params))[0].n;

await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema if not exists auth;
  create table auth.users (id uuid primary key, email text);
  grant usage on schema auth to authenticated, service_role;
  create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('trackpr.test_uid', true), '')::uuid $$;
  create or replace function public.set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = clock_timestamp(); return new; end $$;
  grant usage on schema public to authenticated, anon, service_role;
`);
await q("insert into auth.users (id, email) values ($1, 'founder@x.test'), ($2, 'ops@x.test'), ($3, 'ops2@x.test'), ($4, 'someone@x.test')", [A, ADM, ADM2, C]);
await db.exec(file("founder_command_center.sql"));
await db.exec(file("founder_daily_focus.sql"));
await db.exec(file("founder_sales_os.sql"));
// Agency foundation as deployed (20260918182032), with a minimal organizations table.
await db.exec(`
  create table public.organizations (id uuid primary key, name text not null);
  create table public.agency_admins (id uuid primary key default gen_random_uuid(), user_id uuid not null unique references auth.users(id) on delete cascade, created_at timestamptz not null default now());
  alter table public.agency_admins enable row level security;
  create policy agency_admins_select_self on public.agency_admins for select using (user_id = auth.uid());
  create table public.agency_organizations (id uuid primary key default gen_random_uuid(), organization_id uuid not null unique references public.organizations(id) on delete cascade, created_at timestamptz not null default now());
  alter table public.agency_organizations enable row level security;
  create or replace function public.is_agency_admin() returns boolean language sql stable security definer set search_path to 'public' as $$ select exists (select 1 from public.agency_admins where user_id = auth.uid()); $$;
  create policy agency_organizations_select on public.agency_organizations for select using (is_agency_admin());
  grant execute on function public.is_agency_admin() to authenticated;
`);
await q("insert into founder_users (user_id) values ($1)", [A]);
await q("insert into agency_admins (user_id) values ($1), ($2)", [ADM, ADM2]);
await q("insert into organizations (id, name) values ($1, 'Managed Co'), ($2, 'Not managed Co')", [ORG1, ORG2]);
await q("insert into agency_organizations (organization_id) values ($1)", [ORG1]);
await db.exec(file("agency_client_handoff.sql"));
const forward = file("agency_client_delivery.sql");
const rollback = file("agency_client_delivery_rollback.sql");
await db.exec(forward);
await db.exec(forward);
console.log("ok  applies twice on top of the founder, sales, agency foundation and handoff schemas");

// A confirmed Agency client, through the real Phase 2 flow.
async function confirmedClient(name) {
  const deal = await as(A, async () => {
    const [{ id, updated_at }] = await q("insert into founder_deals (name, stage, contact_name, contact_email) values ($1, 'negotiation', 'Dana', 'dana@example.com') returning id, updated_at", [name]);
    await q("select founder_change_deal_stage($1, $2, 'won', $3, null, 2500, 1497, 'USD', '2026-10-01')", [rid(), id, updated_at]);
    return id;
  });
  const h = rid();
  await as(A, () => q("select founder_prepare_client_handoff($1, $2, 'Lead response, texting and monthly reporting')", [h, deal]));
  const { r } = await one(ADM, "select agency_confirm_client_handoff($1) r", [h]);
  return r.agency_client_id;
}
const client = async (id) => (await q("select * from agency_clients where id = $1", [id]))[0];
const c1 = await confirmedClient("Acme Roofing");
assert.equal((await client(c1)).status, "onboarding_not_started", "Phase 2 confirm still creates a not-started client");
console.log("ok  Phase 2 confirm still works and starts the client at onboarding not started");

// --- 1. Access ---------------------------------------------------------------------------------
let v = (await client(c1)).updated_at;
for (const [uid, label] of [[A, "founder"], [C, "non-admin"]]) {
  await rejects(uid, "select agency_start_onboarding($1, $2, array['sms'], null, null)", [c1, v], "FS404", `${label} can't start onboarding`);
  await as(uid, async () => {
    for (const t of ["agency_clients", "agency_client_tasks", "agency_client_events", "agency_client_launches"]) assert.equal((await q(`select count(*)::int n from ${t}`))[0].n, 0, `${label} reads no ${t}`);
    assert.equal((await q("select count(*)::int n from agency_admin_directory()"))[0].n, 0, `${label} sees no admin directory`);
  });
}
await rejects(null, "select agency_start_onboarding($1, $2, array['sms'], null, null)", [c1, v], "42501", "anon can't call it", "anon");
await rejects(ADM, "insert into agency_client_tasks (client_id, category, title, required) values ($1, 'other', 'x', false)", [c1], "42501", "no direct task inserts");
await rejects(ADM, "update agency_clients set status = 'live' where id = $1", [c1], "42501", "no direct client updates (no grant)");
await rejects(null, "update agency_clients set status = 'live' where id = $1", [c1], "FS422", "lifecycle only through the functions, even for the service role", "service_role");
await rejects(null, "update agency_clients set scope = 'Something else entirely' where id = $1", [c1], "FS422", "agreed scope is immutable", "service_role");
await rejects(null, "update agency_clients set monthly_fee = 1 where id = $1", [c1], "FS422", "agreed fees are immutable", "service_role");
assert.deepEqual((await as(ADM, () => q("select email from agency_admin_directory()"))).map((r) => r.email), ["ops2@x.test", "ops@x.test"]);
console.log("ok  agency admins only (founder, non-admin, anon refused and see nothing); terms, scope and lifecycle can't be written directly");

// --- 2. Start onboarding: scoped tasks ---------------------------------------------------------------
await rejects(ADM, "select agency_start_onboarding($1, '2020-01-01', array['sms'], null, null)", [c1], "FS409", "stale version");
await rejects(ADM, "select agency_start_onboarding($1, $2, array[]::text[], null, null)", [c1, v], "FS422", "at least one module");
await rejects(ADM, "select agency_start_onboarding($1, $2, array['sms','teleportation'], null, null)", [c1, v], "FS422", "unknown module");
await rejects(ADM, "select agency_start_onboarding($1, $2, array['sms'], $3, null)", [c1, v, A], "FS422", "owner must be an agency admin");
const started = await one(ADM, "select agency_start_onboarding($1, $2, array['sms','reporting','sms'], $3, '2026-11-15') r", [c1, v, ADM2]);
assert.deepEqual(started.r, { status: "recorded", tasks_created: 12 });
assert.deepEqual((await one(ADM, "select agency_start_onboarding($1, $2, array['booking'], null, null) r", [c1, v])).r, { status: "duplicate", client_status: "onboarding" }, "a retry doesn't regenerate");
assert.equal(await count("agency_client_tasks", "client_id = $1", [c1]), 12, "7 core + 3 texting + 2 reporting");
assert.equal(await count("agency_client_tasks", "client_id = $1 and module = 'booking'", [c1]), 0, "modules not sold get no tasks");
let cl = await client(c1);
assert.deepEqual([cl.status, cl.services, cl.owner_user_id, cl.target_launch_date instanceof Date || typeof cl.target_launch_date], ["onboarding", ["reporting", "sms"], ADM2, cl.target_launch_date instanceof Date ? true : "string"]);
assert.equal(await count("agency_client_events", "client_id = $1 and kind = 'onboarding_started'", [c1]), 1);
for (const uid of [A, C]) {
  await as(uid, async () => {
    for (const t of ["agency_client_tasks", "agency_client_events"]) assert.equal((await q(`select count(*)::int n from ${t}`))[0].n, 0, `${t} stay hidden from non-admins once they exist`);
  });
}
console.log("ok  start onboarding: core + selected modules only (12 tasks), owner must be an admin, retries don't duplicate, recorded");

// --- 3. Adding modules ----------------------------------------------------------------------------
v = (await client(c1)).updated_at;
assert.deepEqual((await one(ADM, "select agency_add_services($1, $2, array['sms']) r", [c1, v])).r, { status: "duplicate" });
await rejects(ADM, "select agency_add_services($1, '2020-01-01', array['booking'])", [c1], "FS409", "stale add");
assert.deepEqual((await one(ADM, "select agency_add_services($1, $2, array['booking']) r", [c1, v])).r, { status: "recorded", tasks_created: 2 });
cl = await client(c1);
assert.deepEqual(cl.services, ["booking", "reporting", "sms"], "added, never removed");
assert.equal(await count("agency_client_tasks", "client_id = $1", [c1]), 14);
assert.equal((await q("select details from agency_client_events where client_id = $1 and kind = 'services_added'", [c1]))[0].details.added[0], "booking");
console.log("ok  modules added later are recorded and add their tasks once; nothing is removed");

// --- 4. Tasks ------------------------------------------------------------------------------------------
const task = async (key) => (await q("select * from agency_client_tasks where client_id = $1 and template_key = $2", [c1, key]))[0];
const setStatus = (uid, t, status, reason = null) => one(uid, "select agency_set_task_status($1, $2, $3, $4) r", [t.id, t.updated_at, status, reason]);
let t = await task("core.kickoff");
await rejects(A, "select agency_set_task_status($1, $2, 'done', null)", [t.id, t.updated_at], "FS404", "founder can't change tasks");
await rejects(ADM, "select agency_set_task_status($1, '2020-01-01', 'done', null)", [t.id], "FS409", "stale task");
assert.equal((await setStatus(ADM, t, "done")).r.status, "recorded");
assert.equal((await setStatus(ADM, t, "done")).r.status, "duplicate", "a retry is a no-op");
t = await task("core.kickoff");
assert.ok(t.completed_at && t.completed_by === ADM, "completion evidence: who and when");
await rejects(ADM, "select agency_set_task_status($1, $2, 'blocked', '  ')", [t.id, t.updated_at], "FS422", "blocking needs a reason");
await rejects(ADM, "select agency_set_task_status($1, $2, 'wont_do', 'Not needed')", [t.id, t.updated_at], "FS422", "a required task can't be skipped");
await rejects(ADM, "select agency_set_task_status($1, $2, 'paused', null)", [t.id, t.updated_at], "FS422", "unknown status");
let a2p = await task("sms.a2p");
await setStatus(ADM, a2p, "blocked", "Waiting on the client's EIN");
a2p = await task("sms.a2p");
assert.equal(a2p.blocked_reason, "Waiting on the client's EIN");
await rejects(ADM, "select agency_set_task_details($1, $2, $3, null)", [a2p.id, a2p.updated_at, C], "FS422", "only admins can own tasks");
await as(ADM, () => q("select agency_set_task_details($1, $2, $3, '2026-11-01')", [a2p.id, a2p.updated_at, ADM2]));
assert.equal((await task("sms.a2p")).owner_user_id, ADM2);
const custom = rid();
await as(ADM, () => q("select agency_add_task($1, $2, 'Collect logo files', null, 'client_info', false, 'client', null, null)", [custom, c1]));
assert.equal((await one(ADM, "select agency_add_task($1, $2, 'Collect logo files', null, 'client_info', false, 'client', null, null) r", [custom, c1])).r.status, "duplicate");
const ct = (await q("select * from agency_client_tasks where id = $1", [custom]))[0];
await as(ADM, () => q("select agency_set_task_status($1, $2, 'wont_do', 'Client has no logo yet')", [ct.id, ct.updated_at]));
await rejects(null, "delete from agency_client_tasks where id = $1", [custom], "FS403", "tasks are never deleted", "service_role");
await rejects(null, "update agency_client_tasks set title = 'rewritten' where id = $1", [custom], "FS403", "tasks change only through the functions", "service_role");
await rejects(null, "update agency_client_events set kind = 'launched'", [], "FS403", "history is append-only", "service_role");
await rejects(null, "delete from agency_client_events", [], "FS403", "history can't be deleted", "service_role");
assert.ok(await count("agency_client_events", "client_id = $1 and kind like 'task_%'", [c1]) >= 5, "every task change is recorded");
console.log("ok  tasks: admins only, stale refused, retries no-ops, blocked/won't-do need reasons, required can't be skipped, owners are admins, nothing deleted or rewritten");

// --- 5. Launch gate ----------------------------------------------------------------------------------
v = (await client(c1)).updated_at;
let err = await rejects(ADM, "select agency_mark_ready_to_launch($1, $2)", [c1, v], "FS422", "incomplete");
assert.match(err.message, /not ready: 1 of 13 required tasks done, 1 blocked/);
await rejects(ADM, "select agency_approve_launch($1, $2, $3, $4)", [rid(), c1, v, { checks: [{ key: "x", status: "passed" }] }], "FS422", "can't launch from onboarding");
for (const tk of (await q("select * from agency_client_tasks where client_id = $1 and required and status <> 'done'", [c1]))) {
  if (tk.template_key === "sms.a2p") continue;
  await as(ADM, () => q("select agency_set_task_status($1, $2, 'done', null)", [tk.id, tk.updated_at]));
}
v = (await client(c1)).updated_at;
err = await rejects(ADM, "select agency_mark_ready_to_launch($1, $2)", [c1, v], "FS422", "one blocked required task still stops it");
assert.match(err.message, /12 of 13 required tasks done, 1 blocked/);
a2p = await task("sms.a2p");
await setStatus(ADM, a2p, "done");
v = (await client(c1)).updated_at;
assert.equal((await one(ADM, "select agency_mark_ready_to_launch($1, $2) r", [c1, v])).r.status, "recorded");
assert.equal((await client(c1)).status, "ready_to_launch");
const train = await task("core.training");
await setStatus(ADM, train, "in_progress");
assert.equal((await client(c1)).status, "onboarding", "reopening a required task takes the client back to onboarding");
assert.equal(await count("agency_client_events", "client_id = $1 and kind = 'readiness_lost'", [c1]), 1);
await setStatus(ADM, await task("core.training"), "done");
// Every task done but not marked ready: launch is still refused.
v = (await client(c1)).updated_at;
assert.equal((await client(c1)).status, "onboarding");
err = await rejects(ADM, "select agency_approve_launch($1, $2, $3, $4)", [rid(), c1, v, { checks: [{ key: "x", status: "passed" }] }], "FS422", "launch needs ready-to-launch, even with every task done");
assert.match(err.message, /mark the client ready to launch first/);
// A blocked optional task also stops readiness.
const baseline = await task("reporting.baseline");
await setStatus(ADM, baseline, "blocked", "Client hasn't sent last year's numbers");
v = (await client(c1)).updated_at;
err = await rejects(ADM, "select agency_mark_ready_to_launch($1, $2)", [c1, v], "FS422", "any blocked task stops readiness");
assert.match(err.message, /13 of 13 required tasks done, 1 blocked/);
await setStatus(ADM, await task("reporting.baseline"), "done");
const extra = rid();
v = (await client(c1)).updated_at;
await as(ADM, () => q("select agency_mark_ready_to_launch($1, $2)", [c1, v]));
await as(ADM, () => q("select agency_add_task($1, $2, 'Fix the intake form', null, 'lead_intake', true, 'agency', null, null)", [extra, c1]));
assert.equal((await client(c1)).status, "onboarding", "a new required task also takes it back");
const et = (await q("select * from agency_client_tasks where id = $1", [extra]))[0];
await as(ADM, () => q("select agency_set_task_status($1, $2, 'done', null)", [et.id, et.updated_at]));
v = (await client(c1)).updated_at;
await as(ADM, () => q("select agency_mark_ready_to_launch($1, $2)", [c1, v]));
console.log("ok  launch gate (database): required tasks done and nothing blocked; losing readiness is automatic and recorded");

// --- 6. Launch approval ------------------------------------------------------------------------------
v = (await client(c1)).updated_at;
const checks = [
  { key: "required_tasks", label: "Required tasks", status: "passed", critical: true },
  { key: "sms_configured", label: "Texting number", status: "unverified", critical: false, detail: "Unverified - no Trackpr account linked" },
];
const launch = (uid, req, expected, evidence) => one(uid, "select agency_approve_launch($1, $2, $3, $4) r", [req, c1, expected, evidence]);
await rejects(A, "select agency_approve_launch($1, $2, $3, $4)", [rid(), c1, v, { checks }], "FS404", "founder can't launch");
await rejects(ADM, "select agency_approve_launch($1, $2, $3, $4)", [rid(), c1, "2020-01-01", { checks, unverified_acknowledgement: "Checked by phone with the client" }], "FS409", "stale launch");
await rejects(ADM, "select agency_approve_launch($1, $2, $3, $4)", [rid(), c1, v, { checks: [] }], "FS422", "evidence required");
await rejects(ADM, "select agency_approve_launch($1, $2, $3, $4)", [rid(), c1, v, { checks: [{ key: "x", status: "maybe" }] }], "FS422", "evidence malformed");
await rejects(ADM, "select agency_approve_launch($1, $2, $3, $4)", [rid(), c1, v, { checks: [...checks, { key: "payment", status: "failed", critical: true }], unverified_acknowledgement: "Checked by phone with the client" }], "FS422", "a failed critical check blocks launch");
err = await rejects(ADM, "select agency_approve_launch($1, $2, $3, $4)", [rid(), c1, v, { checks, unverified_acknowledgement: "ok" }], "FS422", "unverified needs a written acknowledgement");
assert.match(err.message, /acknowledge the unverified checks/);
assert.equal(await count("agency_client_launches"), 0, "refusals record nothing");
// Defense in depth: even if a task were changed behind the functions' back while ready, launch re-checks the gate.
const kick = await task("core.kickoff");
await db.exec(`select set_config('agency.delivery_write', 'on', false); update agency_client_tasks set status = 'todo', completed_at = null, completed_by = null where id = '${kick.id}'; select set_config('agency.delivery_write', '', false);`);
assert.equal((await client(c1)).status, "ready_to_launch");
err = await rejects(ADM, "select agency_approve_launch($1, $2, $3, $4)", [rid(), c1, v, { checks, unverified_acknowledgement: "Texting confirmed manually on a call with Dana" }], "FS422", "launch re-checks the gate itself");
assert.match(err.message, /not ready: 13 of 14 required tasks done, 0 blocked/);
await db.exec(`select set_config('agency.delivery_write', 'on', false); update agency_client_tasks set status = 'done', completed_at = now(), completed_by = '${ADM}' where id = '${kick.id}'; select set_config('agency.delivery_write', '', false);`);
v = (await client(c1)).updated_at;
const L1 = rid();
assert.deepEqual((await launch(ADM, L1, v, { checks, unverified_acknowledgement: "Texting confirmed manually on a call with Dana" })).r, { status: "recorded", launch_id: L1 });
const second = (await launch(ADM2, rid(), v, { checks, unverified_acknowledgement: "Second approver trying again" })).r;
assert.equal(second.status, "duplicate");
assert.equal(second.launch_id, L1, "a second or concurrent launch returns the recorded one");
assert.equal(await count("agency_client_launches", "client_id = $1", [c1]), 1);
const rec = (await q("select * from agency_client_launches where id = $1", [L1]))[0];
assert.deepEqual([rec.approved_by, rec.resulting_status, rec.evidence.unverified_acknowledgement, rec.evidence.checks.length, rec.evidence.gate.passes], [ADM, "live", "Texting confirmed manually on a call with Dana", 2, true]);
cl = await client(c1);
assert.deepEqual([cl.status, cl.launched_by, cl.launched_at != null], ["live", ADM, true]);
await rejects(null, "insert into agency_client_launches (id, client_id, approved_by, resulting_status, evidence) values ($1, $2, $3, 'live', '{}')", [rid(), c1, ADM], "23505", "one launch per client, whatever the timing", "service_role");
await rejects(null, "update agency_client_launches set evidence = '{}'", [], "FS403", "launch records are immutable", "service_role");
v = cl.updated_at;
assert.equal((await one(ADM, "select agency_move_to_ongoing($1, $2) r", [c1, v])).r.status, "recorded");
assert.equal((await one(ADM, "select agency_move_to_ongoing($1, $2) r", [c1, v])).r.status, "duplicate");
console.log("ok  launch: needs ready status, version, valid evidence, no failed critical check and a written acknowledgement for unverified ones; recorded once with who/when/evidence");

// --- 7. Linking a Trackpr account ------------------------------------------------------------------------
const c2 = await confirmedClient("Birch Plumbing");
v = (await client(c2)).updated_at;
await rejects(ADM, "select agency_link_client_organization($1, $2, $3)", [c2, v, ORG2], "FS422", "only Agency-managed accounts can be linked");
await rejects(A, "select agency_link_client_organization($1, $2, $3)", [c2, v, ORG1], "FS404", "founder can't link");
const managedBefore = await count("agency_organizations");
assert.equal((await one(ADM, "select agency_link_client_organization($1, $2, $3) r", [c2, v, ORG1])).r.status, "recorded");
assert.equal(await count("agency_organizations"), managedBefore, "linking never adds to agency_organizations");
v = (await client(c1)).updated_at;
await rejects(ADM, "select agency_link_client_organization($1, $2, $3)", [c1, v, ORG1], "FS409", "one client per Trackpr account");
v = (await client(c2)).updated_at;
assert.equal((await one(ADM, "select agency_link_client_organization($1, $2, $3) r", [c2, v, ORG1])).r.status, "duplicate");
await rejects(null, "update agency_clients set organization_id = $2 where id = $1", [c2, ORG2], "FS422", "no direct relinking", "service_role");
console.log("ok  linking: explicit, admin only, Agency-managed accounts only, once per client and per account, never adds to agency_organizations");

// --- 8. Isolation between clients -------------------------------------------------------------------------
v = (await client(c2)).updated_at;
await as(ADM, () => q("select agency_start_onboarding($1, $2, array['crm'], null, null)", [c2, v]));
await rejects(ADM, "select agency_add_task($1, $2, 'Hijack', null, 'other', false, 'agency', null, null)", [custom, c2], "FS422", "a task id from another client can't be replayed");
assert.equal(await count("agency_client_tasks", "client_id = $1 and template_key like 'sms.%'", [c2]), 0, "each client gets only its own modules");
assert.equal((await client(c1)).status, "ongoing_management", "changes on one client never touch another");
console.log("ok  clients are isolated: own tasks, own modules, no replay across clients");

// --- 9. Rollback: non-destructive; Phase 2 keeps working ------------------------------------------------------
const kept = { tasks: await count("agency_client_tasks"), events: await count("agency_client_events"), launches: await count("agency_client_launches") };
await db.exec(rollback);
await db.exec(rollback);
assert.deepEqual({ tasks: await count("agency_client_tasks"), events: await count("agency_client_events"), launches: await count("agency_client_launches") }, kept);
assert.equal((await client(c1)).status, "ongoing_management", "lifecycle values kept");
assert.equal((await q("select count(*)::int n from pg_proc where proname like 'agency_%' and proname not in ('agency_client_handoffs_snapshot_guard','agency_confirm_client_handoff','agency_clients_delivery_guard','agency_delivery_rows_guard')"))[0].n, 0, "delivery write paths removed");
await rejects(null, "update agency_clients set scope = 'Something else entirely' where id = $1", [c1], "FS422", "terms still immutable after rollback", "service_role");
await rejects(null, "delete from agency_client_events", [], "FS403", "history still append-only after rollback", "service_role");
const c3 = await confirmedClient("Cedar HVAC");
assert.equal((await client(c3)).status, "onboarding_not_started", "Phase 2 confirm works after rollback");
await db.exec(forward);
assert.deepEqual({ tasks: await count("agency_client_tasks"), launches: await count("agency_client_launches") }, { tasks: kept.tasks, launches: kept.launches });
v = (await client(c3)).updated_at;
assert.equal((await one(ADM, "select agency_start_onboarding($1, $2, array['reporting'], null, null) r", [c3, v])).r.tasks_created, 9, "re-applied functions work over the kept data");
console.log("ok  rollback (twice) removes the write paths and keeps every task, event, launch and lifecycle value; Phase 2 still works; re-apply works");

// --- 10. Accounts ----------------------------------------------------------------------------------------------
await q("delete from auth.users where id = $1", [ADM2]);
assert.equal((await task("sms.a2p")).owner_user_id, null, "a removed admin's tasks become unassigned (history kept)");
const ADM3 = "ffffffff-ffff-4fff-8fff-ffffffffffff";
await q("insert into auth.users (id, email) values ($1, 'ops3@x.test')", [ADM3]);
await q("insert into agency_admins (user_id) values ($1)", [ADM3]);
const c3task = (await q("select * from agency_client_tasks where client_id = $1 order by sort_order limit 1", [c3]))[0];
await as(ADM3, () => q("select agency_set_task_status($1, $2, 'done', null)", [c3task.id, c3task.updated_at]));
let only = null;
try { await q("delete from auth.users where id = $1", [ADM3]); } catch (e) { only = e; }
assert.equal(only?.code, "23503", "an admin whose only footprint is completed tasks is refused by the strict evidence reference");
let blocked = null;
try { await q("delete from auth.users where id = $1", [ADM]); } catch (e) { blocked = e; }
// Refused either by the strict evidence references added here (23503) or, first, by the
// Phase 2 handoff state check on confirmed_by (23514) - a pre-existing Phase 2 behavior.
assert.ok(blocked && ["23503", "23514"].includes(blocked.code), `an admin who completed tasks, confirmed handoffs or approved a launch can't be silently removed (${blocked?.code})`);
assert.equal(await count("agency_client_launches", "approved_by = $1", [ADM]), 1, "the approver is still recorded");
console.log("ok  removing an admin unassigns their tasks; completion and launch evidence is protected");
console.log("all agency client delivery checks passed");

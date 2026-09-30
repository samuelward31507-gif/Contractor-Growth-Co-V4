// Parity harness for supabase/migrations/20260930044405_organization_health_inputs.sql
// (Performance Pass 3; applied to the test project and production).
//
// Builds an in-memory Postgres (PGlite) from the REAL migrations (the same
// boot as validate-dashboard-sql.mjs, which now already includes this one),
// applies the function's file again TWICE (idempotency), seeds boundary organizations, then runs BOTH health
// implementations end to end through @supabase/supabase-js against the
// PostgREST-compatible layer (pglite-postgrest.mjs), with an anchored clock:
//
//   legacy  = lib/automation-health/health.ts exactly as it is on origin/main
//             (six PostgREST requests), loaded from git into a temp file
//   current = lib/automation-health/health.ts in this worktree (one RPC)
//
// and requires every field of OrganizationHealthSummary (except the
// generatedAt timestamp) to be identical, per organization, plus:
//   - request counts: legacy 6, current 1
//   - a failed read degrades identically (both point at an unreachable URL)
//   - security as the real roles: a member reads their organization, a
//     non-member gets nothing of it (RLS), anon cannot execute
//   - object inventory: SECURITY INVOKER, STABLE, search_path=public, grants
//   - rollback drops the function; re-apply restores it and parity holds
//
// It never opens a network connection other than to its own local server.
//
// Run from the repo root:
//   TZ=UTC                 node --import ./lib/automation/test-loader.mjs supabase/pending/scratch/validate-organization-health-sql.mjs
//   TZ=America/Los_Angeles node --import ./lib/automation/test-loader.mjs supabase/pending/scratch/validate-organization-health-sql.mjs
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startPostgrest } from "./pglite-postgrest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../../..");
const FORWARD = readFileSync(path.join(ROOT, "supabase/migrations/20260930044405_organization_health_inputs.sql"), "utf8");
const ROLLBACK = readFileSync(path.join(ROOT, "supabase/pending/organization_health_inputs_rollback.sql"), "utf8");

let passed = 0;
let failed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    failures.push(`${label}\n       expected ${e}\n       actual   ${a}`);
    console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`);
  }
}

// ---------------------------------------------------------------------------
// Anchored clock (validate-dashboard-sql.mjs's own): starts at NOW and keeps
// moving (PGlite's runtime spins on a frozen clock).
// ---------------------------------------------------------------------------
const NOW_ISO = "2026-10-15T15:30:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const RealDate = Date;
const START_REAL = RealDate.now();
const clockNow = () => NOW_MS + (RealDate.now() - START_REAL);
class AnchoredDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(clockNow());
    else super(...args);
  }
  static now() {
    return clockNow();
  }
}
globalThis.Date = AnchoredDate;

// ---------------------------------------------------------------------------
// Database from the real migrations (validate-dashboard-sql.mjs's boot).
// ---------------------------------------------------------------------------
const db = new PGlite({ extensions: { pgcrypto, btree_gist } });
await db.exec(`
  create schema if not exists extensions; create extension if not exists pgcrypto schema extensions;
  do $$ begin create role anon; exception when others then null; end $$;
  do $$ begin create role authenticated; exception when others then null; end $$;
  do $$ begin create role service_role; exception when others then null; end $$;
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key, email text, raw_user_meta_data jsonb, created_at timestamptz default now());
  create or replace function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
  create or replace function auth.role() returns text language sql stable as $f$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $f$;
  create or replace function auth.jwt() returns jsonb language sql stable as $f$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $f$;
  create schema if not exists storage; create schema if not exists realtime;
  create extension if not exists btree_gist schema extensions;
  set search_path = public, extensions;
`);
for (const f of [...readdirSync(path.join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort().map((f) => path.join(ROOT, "supabase/migrations", f)), path.join(ROOT, "supabase/pending/online_payments.sql")]) {
  try {
    await db.exec(readFileSync(f, "utf8"));
  } catch (error) {
    if (!f.endsWith("_authorize_agency_admin_account.sql")) throw new Error(`${path.basename(f)}: ${error.message}`);
  }
}

const inventory = async () =>
  (
    await db.query(`
      select p.prosecdef as security_definer, p.provolatile as volatility, l.lanname as language, array_to_string(p.proconfig, ',') as config,
             pg_get_function_identity_arguments(p.oid) as args, pg_get_function_result(p.oid) as returns, md5(pg_get_functiondef(p.oid)) as body_md5,
             has_function_privilege('authenticated', p.oid, 'execute') as authenticated_exec,
             has_function_privilege('anon', p.oid, 'execute') as anon_exec,
             exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0) as public_exec
      from pg_proc p join pg_language l on l.oid = p.prolang
      where p.oid = to_regprocedure('public.organization_health_inputs(uuid, timestamptz, timestamptz)')`)
  ).rows[0] ?? null;

console.log("\n[1] apply the function, twice");
await db.exec(FORWARD);
const inv1 = await inventory();
check("SECURITY INVOKER, STABLE, language sql, search_path=public", [inv1.security_definer, inv1.volatility, inv1.language, inv1.config], [false, "s", "sql", "search_path=public"]);
check("signature and return type", [inv1.args, inv1.returns], ["p_organization_id uuid, p_executions_from timestamp with time zone, p_executions_to timestamp with time zone", "jsonb"]);
check("EXECUTE: authenticated yes, anon no, PUBLIC no", [inv1.authenticated_exec, inv1.anon_exec, inv1.public_exec], [true, false, false]);
await db.exec(FORWARD);
check("second apply leaves the function identical (idempotent)", await inventory(), inv1);
const body = (await db.query(`select pg_get_functiondef(to_regprocedure('public.organization_health_inputs(uuid, timestamptz, timestamptz)')) as d`)).rows[0].d;
check("reads only the five sources the summary uses (never automation_events), each filtered by the organization", {
  events: /automation_events/.test(body),
  orgFilters: (body.match(/organization_id = p_organization_id/g) ?? []).length,
  orgRow: /o\.id = p_organization_id/.test(body),
  liveness: /get_scheduled_automation_liveness\(\)/.test(body),
}, { events: false, orgFilters: 3, orgRow: true, liveness: true });

// ---------------------------------------------------------------------------
// Seed. Deterministic ids: md5(label)::uuid. Triggers off for seeding only;
// CHECK and NOT NULL still apply.
// ---------------------------------------------------------------------------
const ORG = Object.fromEntries(["NORMAL", "EMPTY", "PAUSED", "UNPAID", "SUSPENDED", "CANCELLED", "CAPS", "WINDOWCAP", "BOUNDARY", "ONLYOLD"].map((k) => [k, `md5('health-${k}')::uuid`]));
const NONEXISTENT = "'00000000-0000-4000-8000-00000000abcd'::uuid";
const T = (iso) => `'${iso}'::timestamptz`;
const ago = (ms) => new RealDate(NOW_MS - ms).toISOString();
const MIN = 60_000;
const DAY = 86_400_000;

await db.exec(`
set session_replication_role = replica;
insert into public.organizations (id, name, timezone, payment_status, automation_paused) values
  (${ORG.NORMAL}, 'Normal', 'UTC', 'active', false),
  (${ORG.EMPTY}, 'Empty', 'UTC', 'active', false),
  (${ORG.PAUSED}, 'Paused', 'UTC', 'active', true),
  (${ORG.UNPAID}, 'Unpaid', 'UTC', 'payment_required', false),
  (${ORG.SUSPENDED}, 'Suspended', 'UTC', 'suspended', true),
  (${ORG.CANCELLED}, 'Cancelled', 'UTC', 'cancelled', false),
  (${ORG.CAPS}, 'Caps', 'UTC', 'active', false),
  (${ORG.WINDOWCAP}, 'Window cap', 'UTC', 'active', false),
  (${ORG.BOUNDARY}, 'Boundary', 'UTC', 'active', false),
  (${ORG.ONLYOLD}, 'Only old history', 'UTC', 'active', false);

-- Normal: several workflows, every execution status, inside and outside the 30-day window.
insert into public.workflow_executions (organization_id, workflow_name, status, started_at) values
  (${ORG.NORMAL}, 'lead.created', 'completed', ${T(ago(2 * MIN))}),
  (${ORG.NORMAL}, 'lead.created', 'failed', ${T(ago(3 * DAY))}),
  (${ORG.NORMAL}, 'lead.created', 'completed', ${T(ago(40 * DAY))}),
  (${ORG.NORMAL}, 'estimate.followup', 'failed', ${T(ago(5 * MIN))}),
  (${ORG.NORMAL}, 'estimate.followup', 'completed', ${T(ago(1 * DAY))}),
  (${ORG.NORMAL}, 'appointment.reminder', 'running', ${T(ago(1 * MIN))}),
  (${ORG.NORMAL}, 'appointment.reminder', 'completed', ${T(ago(2 * DAY))}),
  (${ORG.NORMAL}, 'job.post_followup', 'cancelled', ${T(ago(10 * DAY))}),
  (${ORG.NORMAL}, 'lead.reactivation', 'failed', ${T(ago(35 * DAY))});
-- Incidents in every status x severity, several categories, incl. the ones the summary treats specially.
insert into public.automation_incidents (organization_id, category, severity, status, fingerprint, title, updated_at) values
  (${ORG.NORMAL}, 'workflow_failed', 'critical', 'open', 'n1', 't', ${T(ago(1 * MIN))}),
  (${ORG.NORMAL}, 'workflow_stuck', 'warning', 'open', 'n2', 't', ${T(ago(2 * MIN))}),
  (${ORG.NORMAL}, 'workflow_stuck', 'critical', 'acknowledged', 'n3', 't', ${T(ago(3 * MIN))}),
  (${ORG.NORMAL}, 'sms_delivery_failed', 'warning', 'acknowledged', 'n4', 't', ${T(ago(4 * MIN))}),
  (${ORG.NORMAL}, 'sms_delivery_failed', 'info', 'open', 'n5', 't', ${T(ago(5 * MIN))}),
  (${ORG.NORMAL}, 'human_escalation_requested', 'critical', 'open', 'n6', 't', ${T(ago(6 * MIN))}),
  (${ORG.NORMAL}, 'human_escalation_requested', 'info', 'acknowledged', 'n7', 't', ${T(ago(7 * MIN))}),
  (${ORG.NORMAL}, 'n8n_dispatch_failed', 'info', 'open', 'n8', 't', ${T(ago(8 * MIN))}),
  (${ORG.NORMAL}, 'workflow_failed', 'critical', 'resolved', 'n9', 't', ${T(ago(9 * MIN))}),
  (${ORG.NORMAL}, 'scheduled_automation_stale', 'warning', 'resolved', 'n10', 't', ${T(ago(10 * MIN))});

-- Paused / payment states: some incidents and executions too, so precedence is exercised.
insert into public.automation_incidents (organization_id, category, severity, status, fingerprint, title, updated_at)
  select o, 'workflow_failed', 'critical', 'open', 'p' || o::text, 't', ${T(ago(MIN))}
  from unnest(array[${ORG.PAUSED}, ${ORG.UNPAID}, ${ORG.SUSPENDED}, ${ORG.CANCELLED}]) o;
insert into public.workflow_executions (organization_id, workflow_name, status, started_at)
  select o, 'lead.created', s, ${T(ago(DAY))}
  from unnest(array[${ORG.PAUSED}, ${ORG.UNPAID}, ${ORG.SUSPENDED}, ${ORG.CANCELLED}]) o, unnest(array['completed', 'failed']) s;

-- Caps: 600 executions (only the newest 500 feed name stats) and 230 open incidents (only the newest 200 count).
insert into public.workflow_executions (organization_id, workflow_name, status, started_at)
  select ${ORG.CAPS}, 'wf-' || (g % 7), (array['completed','failed','running','cancelled'])[1 + (g % 4)], ${T(NOW_ISO)} - make_interval(mins => g)
  from generate_series(1, 600) g;
insert into public.workflow_executions (organization_id, workflow_name, status, started_at)
  select ${ORG.CAPS}, 'wf-old-only', 'failed', ${T(NOW_ISO)} - make_interval(mins => 601 + g) from generate_series(1, 5) g;
insert into public.automation_incidents (organization_id, category, severity, status, fingerprint, title, updated_at)
  select ${ORG.CAPS}, case when g % 5 = 0 then 'human_escalation_requested' when g % 3 = 0 then 'workflow_stuck' else 'sms_delivery_failed' end,
         (array['info','warning','critical'])[1 + (g % 3)], case when g % 2 = 0 then 'open' else 'acknowledged' end, 'c' || g, 't', ${T(NOW_ISO)} - make_interval(secs => g)
  from generate_series(1, 230) g;

-- Window cap: 10,001 completed executions inside the window (the 10,000-row cap; all one status, so any capped subset is deterministic).
insert into public.workflow_executions (organization_id, workflow_name, status, started_at)
  select ${ORG.WINDOWCAP}, 'bulk', 'completed', ${T(NOW_ISO)} - make_interval(secs => g) from generate_series(1, 10001) g;

-- Only history older than the 30-day window.
insert into public.workflow_executions (organization_id, workflow_name, status, started_at) values
  (${ORG.ONLYOLD}, 'lead.created', 'completed', ${T(ago(45 * DAY))}),
  (${ORG.ONLYOLD}, 'lead.created', 'failed', ${T(ago(50 * DAY))});

-- Scheduled-automation liveness is platform-wide: one healthy, two stale, one unknown id (ignored), the rest never ran (unverified).
insert into public.automation_schedule_runs (automation_id, ran_at, candidate_count) values
  ('appointment-reminders', ${T(ago(5 * MIN))}, 3),
  ('appointment-reminders', ${T(ago(2 * DAY))}, 1),
  ('estimate-followup', ${T(ago(2 * 60 * MIN))}, 0),
  ('lost-lead-nurture', ${T(ago(3 * DAY))}, 7),
  ('not-a-scheduled-automation', ${T(ago(MIN))}, 1);
set session_replication_role = origin;
`);

// Boundary: executions exactly at the window's start (included) and end (excluded), from the app's own resolveDateRange.
const { resolveDateRange } = await import(path.join(ROOT, "lib/bi/queries.ts"));
const range = resolveDateRange("last30Days");
await db.exec(`
set session_replication_role = replica;
insert into public.workflow_executions (organization_id, workflow_name, status, started_at) values
  (${ORG.BOUNDARY}, 'edge', 'completed', ${T(range.from)}),
  (${ORG.BOUNDARY}, 'edge', 'failed', ${T(range.to)}),
  (${ORG.BOUNDARY}, 'edge', 'failed', '${new RealDate(Date.parse(range.from) - 1).toISOString()}'::timestamptz);
set session_replication_role = origin;
`);

// ---------------------------------------------------------------------------
// The two implementations.
// ---------------------------------------------------------------------------
const legacySource = execFileSync("git", ["show", "origin/main:lib/automation-health/health.ts"], { cwd: ROOT, encoding: "utf8" });
const tmp = mkdtempSync(path.join(os.tmpdir(), "health-parity-"));
const legacyPath = path.join(tmp, "legacy-health.ts");
writeFileSync(
  legacyPath,
  legacySource
    .replace('import { cache } from "react";', `import { createRequire } from "node:module";\nconst { cache } = createRequire(${JSON.stringify(path.join(ROOT, "package.json"))})("react");`)
    .replace(/from "\.\/(queries|scheduled-automation-liveness|types)"/g, 'from "@/lib/automation-health/$1"'),
);
const legacy = await import(legacyPath);
const current = await import(path.join(ROOT, "lib/automation-health/health.ts"));
check("the legacy module really is the six-read version and the current one is the RPC version", {
  legacyUsesOverview: /getAutomationOverview\(supabase, organizationId\)/.test(legacySource),
  currentUsesRpc: /supabase\.rpc\("organization_health_inputs"/.test(readFileSync(path.join(ROOT, "lib/automation-health/health.ts"), "utf8")),
}, { legacyUsesOverview: true, currentUsesRpc: true });

const requests = [];
const pg = await startPostgrest(db, { onRequest: (r) => requests.push(r) });
const { createClient } = await import("@supabase/supabase-js");
const supabase = createClient(pg.url, "fake-anon-key-local-only", { auth: { persistSession: false, autoRefreshToken: false } });
const withoutClock = (summary) => {
  const copy = { ...summary };
  delete copy.generatedAt;
  return copy;
};
const idOf = async (expr) => (await db.query(`select ${expr}::text as v`)).rows[0].v;

console.log("\n[2] parity: legacy (six reads) vs current (one RPC), every field but generatedAt");
const expectations = {};
for (const [key, expr] of [...Object.entries(ORG), ["NONEXISTENT", NONEXISTENT]]) {
  const organizationId = await idOf(expr);
  requests.length = 0;
  const before = withoutClock(await legacy.getOrganizationHealth(supabase, organizationId));
  const legacyRequests = requests.length;
  requests.length = 0;
  const after = withoutClock(await current.getOrganizationHealth(supabase, organizationId));
  const currentRequests = requests.length;
  check(`${key}: identical OrganizationHealthSummary`, after, before);
  check(`${key}: requests legacy 6 -> current 1`, [legacyRequests, currentRequests], [6, 1]);
  expectations[key] = before;
}

// The fixtures actually exercise what they claim to (so parity is not vacuous).
const e = expectations;
check("fixtures: statuses cover healthy/unhealthy/paused/payment_blocked", [e.EMPTY.status, e.NORMAL.status, e.PAUSED.status, e.UNPAID.status, e.SUSPENDED.status, e.CANCELLED.status, e.NONEXISTENT.status], ["degraded", "unhealthy", "paused", "payment_blocked", "payment_blocked", "payment_blocked", "payment_blocked"]);
check("fixtures: stale scheduled automations counted (2 stale, 1 healthy, 1 unknown id ignored, rest unverified)", e.EMPTY.staleScheduledAutomationCount, 2);
check("fixtures: NORMAL incident counts (human escalations and resolved excluded from health counts)", [e.NORMAL.activeIncidentCount, e.NORMAL.criticalIncidentCount, e.NORMAL.warningIncidentCount, e.NORMAL.infoIncidentCount, e.NORMAL.stuckExecutionCount, e.NORMAL.smsDeliveryFailureCount, e.NORMAL.humanEscalationCount], [6, 2, 2, 2, 2, 2, 2]);
check("fixtures: NORMAL window counts only in-window executions", [e.NORMAL.failedWorkflowExecutions, Math.round(e.NORMAL.automationSuccessRate * 100) / 100], [2, 60]);
check("fixtures: NORMAL last success/failure come from per-workflow latest executions", [e.NORMAL.lastSuccessfulActivityAt !== null, e.NORMAL.lastFailureAt !== null], [true, true]);
check("fixtures: EMPTY has no rate and no timestamps", [e.EMPTY.automationSuccessRate, e.EMPTY.lastSuccessfulActivityAt, e.EMPTY.lastFailureAt, e.EMPTY.failedWorkflowExecutions], [null, null, null, 0]);
check("fixtures: CAPS counts only the newest 200 incidents", e.CAPS.activeIncidentCount + e.CAPS.humanEscalationCount, 200);
check("fixtures: WINDOWCAP counts exactly the 10,000-row cap", Math.round(e.WINDOWCAP.automationSuccessRate), 100);
check("fixtures: ONLYOLD has timestamps from name stats but no in-window counts", [e.ONLYOLD.automationSuccessRate, e.ONLYOLD.failedWorkflowExecutions, e.ONLYOLD.lastSuccessfulActivityAt !== null], [null, 0, true]);
check("fixtures: BOUNDARY includes the window start and excludes the end", [e.BOUNDARY.failedWorkflowExecutions, e.BOUNDARY.automationSuccessRate], [0, 100]);

console.log("\n[3] a failed read degrades identically");
const broken = createClient("http://127.0.0.1:1", "x", { auth: { persistSession: false, autoRefreshToken: false } });
const normalId = await idOf(ORG.NORMAL);
const legacyBroken = withoutClock(await legacy.getOrganizationHealth(broken, normalId));
const currentBroken = withoutClock(await current.getOrganizationHealth(broken, normalId));
check("unreachable database: identical fail-closed summary", currentBroken, legacyBroken);
check("unreachable database: payment_blocked, zero counts, no rate", [currentBroken.status, currentBroken.activeIncidentCount, currentBroken.automationSuccessRate, currentBroken.staleScheduledAutomationCount], ["payment_blocked", 0, null, 0]);

console.log("\n[4] security as the real roles");
const u = { member: "md5('health-user-member')::uuid", outsider: "md5('health-user-outsider')::uuid" };
await db.exec(`
  set session_replication_role = replica;
  insert into auth.users (id, email) values (${u.member}, 'member@example.com'), (${u.outsider}, 'outsider@example.com');
  insert into public.organization_members (organization_id, user_id, role) values (${ORG.NORMAL}, ${u.member}, 'member'), (${ORG.EMPTY}, ${u.outsider}, 'owner');
  set session_replication_role = origin;
  grant usage on schema public to authenticated, anon, service_role;
  grant select, insert, update, delete on all tables in schema public to authenticated, anon, service_role;
`);
const asRole = async (role, sub, q) => {
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', ${sub ? `(${sub})::text` : "''"}, false); select set_config('request.jwt.claim.role', '${role}', false);`);
  try {
    return await db.query(q);
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
};
const call = `select public.organization_health_inputs(${ORG.NORMAL}, '${range.from}'::timestamptz, '${range.to}'::timestamptz) as h`;
const asSuper = (await db.query(call)).rows[0].h;
const mine = (await asRole("authenticated", u.member, call)).rows[0].h;
const theirs = (await asRole("authenticated", u.outsider, call)).rows[0].h;
check("a member (role 'member') reads exactly their organization's inputs", mine, asSuper);
check("a non-member asking for that organization gets nothing of it (RLS)", { org: theirs.organization, incidents: theirs.incidents.length, names: theirs.name_stats.length, window: theirs.window_status_counts }, { org: null, incidents: 0, names: 0, window: { failed: 0, completed: 0 } });
let anonDenied = false;
try {
  await asRole("anon", null, call);
} catch (error) {
  anonDenied = /permission denied/i.test(String(error.message));
}
check("anon cannot execute organization_health_inputs", anonDenied, true);

console.log("\n[5] rollback, then re-apply");
await db.exec(ROLLBACK);
check("rollback drops the function", (await db.query(`select to_regprocedure('public.organization_health_inputs(uuid, timestamptz, timestamptz)') as f`)).rows[0].f, null);
await db.exec(ROLLBACK);
check("rollback is idempotent", true, true);
await db.exec(FORWARD);
check("re-apply restores the identical function", await inventory(), inv1);
requests.length = 0;
check("and parity holds again after re-apply (NORMAL)", withoutClock(await current.getOrganizationHealth(supabase, normalId)), expectations.NORMAL);

await pg.close?.();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed  (TZ=${process.env.TZ ?? "system"})`);
if (failed) {
  console.log(failures.map((f) => ` - ${f}`).join("\n"));
  process.exit(1);
}
process.exit(0);

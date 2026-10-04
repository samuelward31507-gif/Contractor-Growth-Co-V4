// Parity harness for supabase/pending/dashboard_sql.sql (Phase 2D, PENDING).
//
// Builds an in-memory Postgres (PGlite) from the REAL migrations (plus the
// applied-to-test online_payments.sql and the pending dashboard_sql.sql),
// seeds deterministic organizations, and runs the application's REAL
// TypeScript loaders against it through a PostgREST-compatible adapter
// (pglite-postgrest.mjs) with a fixed clock.
//
//   capture  - records what the pre-Phase-2D code renders (page figures,
//              getDashboardData, daily briefing, end-of-day summary) as the
//              frozen baseline: dashboard-parity-baseline.<TZ>.json
//   verify   - runs the SQL-backed path and asserts:
//                * below every old row cap: exact parity with the frozen
//                  baseline (money at displayed cent precision, timestamps
//                  and strings exact);
//                * above the caps: parity with the SAME TypeScript
//                  definitions applied to the complete data (the old path's
//                  capped result is reported alongside);
//                * organization isolation, SECURITY INVOKER/STABLE, and the
//                  RLS/grant behavior of the three functions.
//
// Run from the repository root, once per server timezone:
//   TZ=UTC                 node --import ./lib/automation/test-loader.mjs supabase/pending/scratch/validate-dashboard-sql.mjs <capture|verify>
//   TZ=America/Los_Angeles node --import ./lib/automation/test-loader.mjs supabase/pending/scratch/validate-dashboard-sql.mjs <capture|verify>
// It never opens a network connection beyond 127.0.0.1.
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { readFileSync, readdirSync, writeFileSync, existsSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startPostgrest } from "./pglite-postgrest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../../..");
const MODE = process.argv[2];
if (!["capture", "verify"].includes(MODE)) throw new Error("usage: validate-dashboard-sql.mjs <capture|verify>");
const TZ = process.env.TZ || "UTC";
const T0 = performance.now();
const debug = (msg) => { if (process.env.DEBUG) writeSync(2, `[harness +${Math.round(performance.now() - T0)}ms] ${msg}\n`); };
const BASELINE = path.join(here, `dashboard-parity-baseline.${TZ.replace(/\//g, "_")}.json`);

// ---------------------------------------------------------------------------
// Anchored clock: `new Date()` / Date.now() start at NOW and advance in real
// time from process start (a run takes seconds; every relative-time string
// and threshold in the Dashboard has minute/hour granularity). The clock must
// keep moving: PGlite's WebAssembly runtime reads Date.now() for its own
// timing and spins forever on a frozen clock.
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
// Database
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
const migrationFiles = readdirSync(path.join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
debug("boot start");
for (const f of [...migrationFiles.map((f) => path.join(ROOT, "supabase/migrations", f)), path.join(ROOT, "supabase/pending/online_payments.sql")]) {
  try {
    await db.exec(readFileSync(f, "utf8"));
  } catch (error) {
    // The one data-only migration that seeds a specific production admin account.
    if (!f.endsWith("_authorize_agency_admin_account.sql")) throw new Error(`${path.basename(f)}: ${error.message}`);
  }
}
await db.exec(readFileSync(path.join(ROOT, "supabase/pending/dashboard_sql.sql"), "utf8"));
await db.exec(readFileSync(path.join(ROOT, "supabase/pending/dashboard_attention_sql.sql"), "utf8"));
// Phase 3 (W1): the pending create-or-replace that classifies on inbound + successful outbound evidence.
await db.exec(readFileSync(path.join(ROOT, "supabase/migrations/20261004110145_dashboard_conversation_attention_successful_reply.sql"), "utf8"));
debug("schema ready");

// ---------------------------------------------------------------------------
// Seed (deterministic ids: md5(label)::uuid). Triggers are disabled for
// seeding only (session_replication_role = replica) so historical rows can be
// written directly with self-consistent values; CHECK/NOT NULL still apply.
// ---------------------------------------------------------------------------
const id = (label) => `md5('${label}')::uuid`;
const ORG = { E: "md5('org-E')::uuid", A: "md5('org-A')::uuid", B: "md5('org-B')::uuid", BIG: "md5('org-BIG')::uuid", RR: "md5('org-RR')::uuid", AT: "md5('org-AT')::uuid", TIE: "md5('org-TIE')::uuid", BIGL: "md5('org-BIGL')::uuid", ATH: "md5('org-ATH')::uuid", ATV: "md5('org-ATV')::uuid" };
const orgId = async (key) => (await db.query(`select ${ORG[key]}::text as v`)).rows[0].v;
const T = (iso) => `'${iso}'::timestamptz`;

await db.exec(`
set session_replication_role = replica;
insert into public.organizations (id, name, timezone, payment_status) values
  (${ORG.E}, 'Org Empty', 'UTC', 'active'),
  (${ORG.A}, 'Org A', 'America/New_York', 'active'),
  (${ORG.RR}, 'Org Review/Referral order', 'UTC', 'active'),
  (${ORG.B}, 'Org B', 'America/Chicago', 'active'),
  (${ORG.BIG}, 'Org Big', 'UTC', 'active');

-- ============================ Org A (normal) ============================
insert into public.contacts (id, organization_id, first_name, last_name, created_at) values
  (${id("A-c1")}, ${ORG.A}, 'Ann', 'Able', ${T("2026-09-01T10:00:00Z")}),
  (${id("A-c2")}, ${ORG.A}, 'Bob', 'Baker', ${T("2026-09-02T10:00:00Z")}),
  (${id("A-c3")}, ${ORG.A}, null, null, ${T("2026-09-03T10:00:00Z")}),
  (${id("A-c4")}, ${ORG.A}, 'Cam', null, ${T("2026-09-04T10:00:00Z")}),
  (${id("A-c5")}, ${ORG.A}, 'Dee', 'Dunn', ${T("2026-09-05T10:00:00Z")}),
  (${id("A-c6")}, ${ORG.A}, 'Eve', 'Ely', ${T("2026-09-06T10:00:00Z")}),
  (${id("A-c7")}, ${ORG.A}, 'Fay', 'Fox', ${T("2026-09-07T10:00:00Z")}),
  (${id("A-c8")}, ${ORG.A}, 'Gus', 'Gray', ${T("2026-09-08T10:00:00Z")});

insert into public.leads (id, organization_id, contact_id, status, temperature, estimated_value, service, created_at) values
  (${id("A-l1")}, ${ORG.A}, ${id("A-c1")}, 'new', 'hot', 1200.10, 'Roof', ${T("2026-10-15T10:00:00Z")}),
  (${id("A-l2")}, ${ORG.A}, ${id("A-c2")}, 'contacted', 'warm', 3400.55, 'Gutter', ${T("2026-10-10T10:00:00Z")}),
  (${id("A-l3")}, ${ORG.A}, ${id("A-c3")}, 'qualified', 'cold', null, null, ${T("2026-10-09T10:00:00Z")}),
  (${id("A-l4")}, ${ORG.A}, ${id("A-c4")}, 'appointment', 'hot', 800.20, 'Siding', ${T("2026-10-08T10:00:00Z")}),
  (${id("A-l5")}, ${ORG.A}, null, 'estimate', 'warm', 0.10, 'Paint', ${T("2026-10-07T10:00:00Z")}),
  (${id("A-l6")}, ${ORG.A}, ${id("A-c1")}, 'won', 'hot', 9999.00, 'Deck', ${T("2026-10-06T10:00:00Z")}),
  (${id("A-l7")}, ${ORG.A}, ${id("A-c2")}, 'lost', 'cold', 5000.00, 'Fence', ${T("2026-10-05T10:00:00Z")}),
  (${id("A-l8")}, ${ORG.A}, null, 'new', 'warm', 0.20, null, ${T("2026-10-15T00:00:00Z")}),
  (${id("A-l9")}, ${ORG.A}, null, 'new', 'cold', 12000.00, 'Addition', ${T("2026-10-15T07:00:00Z")});

-- Appointments: server-local day boundaries for both UTC and America/Los_Angeles
-- (LA day = 07:00Z..next 07:00Z in October), statuses, overdue, awaiting confirmation.
insert into public.appointments (id, organization_id, contact_id, lead_id, title, status, start_at, end_at, created_at, confirmation_requested_at, confirmed_at) values
  (${id("A-a1")}, ${ORG.A}, ${id("A-c1")}, ${id("A-l1")}, 'UTC day start', 'scheduled', ${T("2026-10-15T00:00:00Z")}, ${T("2026-10-15T00:00:00.001Z")}, ${T("2026-10-15T09:00:00Z")}, null, null),
  (${id("A-a2")}, ${ORG.A}, ${id("A-c2")}, null, 'UTC prev day end', 'scheduled', ${T("2026-10-14T23:59:59.999Z")}, ${T("2026-10-15T00:00:00Z")}, ${T("2026-10-14T09:00:00Z")}, null, null),
  (${id("A-a3")}, ${ORG.A}, null, null, 'UTC day last ms', 'confirmed', ${T("2026-10-15T23:59:59.999Z")}, ${T("2026-10-16T00:00:00Z")}, ${T("2026-10-15T14:00:00Z")}, null, null),
  (${id("A-a4")}, ${ORG.A}, ${id("A-c3")}, null, 'UTC next day start', 'scheduled', ${T("2026-10-16T00:00:00Z")}, ${T("2026-10-16T00:00:00.001Z")}, ${T("2026-10-13T09:00:00Z")}, null, null),
  (${id("A-a5")}, ${ORG.A}, ${id("A-c4")}, null, 'LA day start cancelled', 'cancelled', ${T("2026-10-15T07:00:00Z")}, ${T("2026-10-15T07:00:00.001Z")}, ${T("2026-10-15T07:00:00Z")}, null, null),
  (${id("A-a6")}, ${ORG.A}, ${id("A-c1")}, null, 'LA day last ms', 'scheduled', ${T("2026-10-16T06:59:59.999Z")}, ${T("2026-10-16T07:00:00Z")}, ${T("2026-10-10T09:00:00Z")}, null, null),
  (${id("A-a7")}, ${ORG.A}, ${id("A-c2")}, null, 'LA next day start', 'scheduled', ${T("2026-10-16T07:00:00Z")}, ${T("2026-10-16T07:00:00.001Z")}, ${T("2026-10-10T09:00:00Z")}, null, null),
  (${id("A-a8")}, ${ORG.A}, ${id("A-c1")}, ${id("A-l4")}, 'Overdue visit', 'scheduled', ${T("2026-10-12T15:00:00Z")}, ${T("2026-10-12T16:00:00Z")}, ${T("2026-10-01T09:00:00Z")}, null, null),
  (${id("A-a9")}, ${ORG.A}, ${id("A-c2")}, null, 'Awaiting confirmation', 'scheduled', ${T("2026-10-18T15:00:00Z")}, ${T("2026-10-18T16:00:00Z")}, ${T("2026-10-11T09:00:00Z")}, ${T("2026-10-14T12:00:00Z")}, null),
  (${id("A-a10")}, ${ORG.A}, ${id("A-c1")}, null, 'Midday today', 'confirmed', ${T("2026-10-15T18:00:00Z")}, ${T("2026-10-15T19:00:00Z")}, ${T("2026-10-15T08:00:00Z")}, ${T("2026-10-14T12:00:00Z")}, ${T("2026-10-14T13:00:00Z")}),
  (${id("A-a11")}, ${ORG.A}, null, null, 'Completed earlier', 'completed', ${T("2026-10-15T12:00:00Z")}, ${T("2026-10-15T13:00:00Z")}, ${T("2026-10-02T09:00:00Z")}, null, null);

insert into public.estimates (id, organization_id, contact_id, lead_id, title, amount, status, sent_at, responded_at, created_at, updated_at) values
  (${id("A-e1")}, ${ORG.A}, ${id("A-c1")}, ${id("A-l5")}, 'Sent A', 100.10, 'sent', ${T("2026-10-15T09:00:00Z")}, null, ${T("2026-10-15T08:00:00Z")}, ${T("2026-10-15T09:00:00Z")}),
  (${id("A-e2")}, ${ORG.A}, null, null, 'Sent no amount', null, 'sent', ${T("2026-10-14T09:00:00Z")}, null, ${T("2026-10-14T08:00:00Z")}, ${T("2026-10-14T09:00:00Z")}),
  (${id("A-e3")}, ${ORG.A}, ${id("A-c3")}, null, 'Sent B', 200.20, 'sent', ${T("2026-10-15T00:00:00Z")}, null, ${T("2026-10-13T08:00:00Z")}, ${T("2026-10-15T00:00:00Z")}),
  (${id("A-e4")}, ${ORG.A}, ${id("A-c2")}, null, 'Accepted with job', 400.40, 'accepted', ${T("2026-10-01T09:00:00Z")}, ${T("2026-10-02T09:00:00Z")}, ${T("2026-10-01T08:00:00Z")}, ${T("2026-10-02T09:00:00Z")}),
  (${id("A-e5")}, ${ORG.A}, ${id("A-c4")}, null, 'Accepted no job', 300.30, 'accepted', ${T("2026-10-03T09:00:00Z")}, ${T("2026-10-04T09:00:00Z")}, ${T("2026-10-03T08:00:00Z")}, ${T("2026-10-04T09:00:00Z")}),
  (${id("A-e6")}, ${ORG.A}, null, null, 'Accepted no amount', null, 'accepted', ${T("2026-10-05T09:00:00Z")}, null, ${T("2026-10-05T08:00:00Z")}, ${T("2026-10-05T09:00:00Z")}),
  (${id("A-e7")}, ${ORG.A}, null, null, 'Declined', 999.99, 'declined', ${T("2026-10-06T09:00:00Z")}, ${T("2026-10-07T09:00:00Z")}, ${T("2026-10-06T08:00:00Z")}, ${T("2026-10-07T09:00:00Z")}),
  (${id("A-e8")}, ${ORG.A}, null, null, 'Draft', 55.55, 'draft', null, null, ${T("2026-10-15T11:00:00Z")}, ${T("2026-10-15T11:00:00Z")});

insert into public.jobs (id, organization_id, contact_id, estimate_id, title, amount, status, started_at, completed_at, created_at) values
  (${id("A-j1")}, ${ORG.A}, ${id("A-c2")}, ${id("A-e4")}, 'Scheduled with estimate', 50.05, 'scheduled', null, null, ${T("2026-10-03T08:00:00Z")}),
  (${id("A-j2")}, ${ORG.A}, ${id("A-c1")}, null, 'In progress no amount', null, 'in_progress', ${T("2026-10-10T08:00:00Z")}, null, ${T("2026-10-09T08:00:00Z")}),
  (${id("A-j3")}, ${ORG.A}, ${id("A-c1")}, null, 'Completed recently', 700.70, 'completed', ${T("2026-10-11T08:00:00Z")}, ${T("2026-10-12T15:00:00Z")}, ${T("2026-10-11T08:00:00Z")}),
  (${id("A-j4")}, ${ORG.A}, null, null, 'Completed 10 days ago', 800.80, 'completed', null, ${T("2026-10-05T15:00:00Z")}, ${T("2026-10-04T08:00:00Z")}),
  (${id("A-j5")}, ${ORG.A}, null, null, 'Legacy completed', 900.90, 'completed', null, ${T("2026-09-20T15:00:00Z")}, ${T("2026-09-19T08:00:00Z")}),
  (${id("A-j6")}, ${ORG.A}, ${id("A-c4")}, null, 'Completed void invoice only', 110.11, 'completed', null, ${T("2026-10-06T15:00:00Z")}, ${T("2026-10-06T08:00:00Z")}),
  (${id("A-j7")}, ${ORG.A}, null, null, 'Completed invoiced', 220.22, 'completed', null, ${T("2026-10-07T15:00:00Z")}, ${T("2026-10-07T08:00:00Z")}),
  (${id("A-j8")}, ${ORG.A}, null, null, 'Completed no completed_at', null, 'completed', null, null, ${T("2026-10-08T08:00:00Z")}),
  (${id("A-j9")}, ${ORG.A}, null, null, 'Cancelled created today', 330.33, 'cancelled', null, null, ${T("2026-10-15T10:00:00Z")}),
  (${id("A-j10")}, ${ORG.A}, ${id("A-c2")}, null, 'Scheduled created today', 440.44, 'scheduled', null, null, ${T("2026-10-15T11:00:00Z")}),
  (${id("A-j11")}, ${ORG.A}, null, null, 'Completed today', 550.55, 'completed', null, ${T("2026-10-15T14:00:00Z")}, ${T("2026-10-01T08:00:00Z")}),
  (${id("A-j12")}, ${ORG.A}, null, null, 'Legacy by created_at', 10.00, 'completed', null, null, ${T("2026-09-28T16:24:59.999Z")}),
  (${id("A-j13")}, ${ORG.A}, null, null, 'Exactly at cutoff', 20.00, 'completed', null, ${T("2026-09-28T16:25:00Z")}, ${T("2026-09-01T08:00:00Z")}),
  (${id("A-j14")}, ${ORG.A}, null, null, 'Scheduled for i8', 1.00, 'scheduled', null, null, ${T("2026-10-02T07:00:00Z")}),
  (${id("A-j15")}, ${ORG.A}, null, null, 'Scheduled for i9', 2.00, 'scheduled', null, null, ${T("2026-10-02T07:30:00Z")});

insert into public.invoices (id, organization_id, job_id, contact_id, number, title, status, subtotal, tax_amount, total, amount_paid, issued_at, due_date, voided_at, created_at) values
  (${id("A-i1")}, ${ORG.A}, ${id("A-j2")}, null, 1, 'Draft', 'draft', 75.00, 0, 75.00, 0, null, null, null, ${T("2026-10-10T08:00:00Z")}),
  (${id("A-i2")}, ${ORG.A}, ${id("A-j3")}, null, 2, 'Overdue sent', 'sent', 100.00, 0, 100.00, 0, ${T("2026-10-01T08:00:00Z")}, '2026-10-14', null, ${T("2026-10-01T08:00:00Z")}),
  (${id("A-i3")}, ${ORG.A}, ${id("A-j4")}, null, 3, 'Partial future', 'partially_paid', 200.00, 0, 200.00, 50.00, ${T("2026-10-02T08:00:00Z")}, '2026-10-20', null, ${T("2026-10-02T08:00:00Z")}),
  (${id("A-i4")}, ${ORG.A}, ${id("A-j7")}, null, 4, 'Paid', 'paid', 300.00, 0, 300.00, 300.00, ${T("2026-10-03T08:00:00Z")}, '2026-10-10', null, ${T("2026-10-03T08:00:00Z")}),
  (${id("A-i5")}, ${ORG.A}, ${id("A-j6")}, null, 5, 'Void', 'void', 400.00, 0, 400.00, 0, ${T("2026-10-04T08:00:00Z")}, '2026-10-11', ${T("2026-10-05T08:00:00Z")}, ${T("2026-10-04T08:00:00Z")}),
  (${id("A-i6")}, ${ORG.A}, ${id("A-j1")}, null, 6, 'Due today', 'sent', 40.00, 0, 40.00, 0, ${T("2026-10-05T08:00:00Z")}, '2026-10-15', null, ${T("2026-10-05T08:00:00Z")}),
  (${id("A-i7")}, ${ORG.A}, ${id("A-j11")}, null, 7, 'Partial overdue', 'partially_paid', 500.00, 0, 500.00, 125.25, ${T("2026-09-29T08:00:00Z")}, '2026-10-01', null, ${T("2026-09-29T08:00:00Z")}),
  (${id("A-i8")}, ${ORG.A}, ${id("A-j14")}, null, 8, 'Overdue same day as i2', 'sent', 0.10, 0, 0.10, 0, ${T("2026-10-02T08:00:00Z")}, '2026-10-14', null, ${T("2026-10-02T08:00:00Z")}),
  (${id("A-i9")}, ${ORG.A}, ${id("A-j15")}, null, 9, 'Overdue same day float', 'sent', 0.20, 0, 0.20, 0, ${T("2026-10-02T08:00:00Z")}, '2026-10-14', null, ${T("2026-10-02T08:00:00Z")});

insert into public.customer_payments (id, organization_id, invoice_id, job_id, amount, method, received_at, reverses_payment_id, created_at) values
  (${id("A-p1")}, ${ORG.A}, ${id("A-i3")}, ${id("A-j4")}, 50.00, 'cash', ${T("2026-10-05T08:00:00Z")}, null, ${T("2026-10-05T08:00:00Z")}),
  (${id("A-p2")}, ${ORG.A}, ${id("A-i4")}, ${id("A-j7")}, 300.00, 'check', ${T("2026-10-06T08:00:00Z")}, null, ${T("2026-10-06T08:00:00Z")}),
  (${id("A-p3")}, ${ORG.A}, ${id("A-i7")}, ${id("A-j11")}, 125.25, 'card_elsewhere', ${T("2026-10-07T08:00:00Z")}, null, ${T("2026-10-07T08:00:00Z")}),
  (${id("A-p4")}, ${ORG.A}, ${id("A-i2")}, ${id("A-j3")}, 60.00, 'cash', ${T("2026-10-08T08:00:00Z")}, null, ${T("2026-10-08T08:00:00Z")}),
  (${id("A-p5")}, ${ORG.A}, ${id("A-i2")}, ${id("A-j3")}, -60.00, 'cash', ${T("2026-10-09T08:00:00Z")}, ${id("A-p4")}, ${T("2026-10-09T08:00:00Z")}),
  (${id("A-p6")}, ${ORG.A}, ${id("A-i3")}, ${id("A-j4")}, 0.10, 'other', ${T("2026-10-10T08:00:00Z")}, null, ${T("2026-10-10T08:00:00Z")}),
  (${id("A-p7")}, ${ORG.A}, ${id("A-i3")}, ${id("A-j4")}, 0.20, 'other', ${T("2026-10-10T09:00:00Z")}, null, ${T("2026-10-10T09:00:00Z")});

-- Conversations: awaiting_reply (6 candidates -> top 5), abandoned (48h
-- boundary, won lead excluded), closed, no messages, unnamed contact,
-- updated_at later than the last message.
insert into public.conversations (id, organization_id, contact_id, lead_id, channel, status, ai_enabled, created_at, updated_at) values
  (${id("A-cv1")}, ${ORG.A}, ${id("A-c1")}, null, 'sms', 'open', true, ${T("2026-10-01T00:00:00Z")}, ${T("2026-10-15T10:00:00Z")}),
  (${id("A-cv2")}, ${ORG.A}, ${id("A-c2")}, ${id("A-l1")}, 'sms', 'open', true, ${T("2026-10-01T00:00:00Z")}, ${T("2026-10-10T00:00:00Z")}),
  (${id("A-cv3")}, ${ORG.A}, ${id("A-c4")}, null, 'sms', 'open', true, ${T("2026-10-01T00:00:00Z")}, ${T("2026-10-10T00:00:00Z")}),
  (${id("A-cv4")}, ${ORG.A}, ${id("A-c5")}, ${id("A-l6")}, 'sms', 'open', true, ${T("2026-10-01T00:00:00Z")}, ${T("2026-10-10T00:00:00Z")}),
  (${id("A-cv5")}, ${ORG.A}, ${id("A-c2")}, null, 'sms', 'closed', true, ${T("2026-10-01T00:00:00Z")}, ${T("2026-10-15T11:00:00Z")}),
  (${id("A-cv6")}, ${ORG.A}, ${id("A-c6")}, null, 'sms', 'open', false, ${T("2026-10-01T00:00:00Z")}, ${T("2026-10-15T12:00:00Z")}),
  (${id("A-cv7")}, ${ORG.A}, ${id("A-c3")}, null, 'sms', 'open', false, ${T("2026-10-01T00:00:00Z")}, ${T("2026-10-12T00:00:00Z")}),
  (${id("A-cv8")}, ${ORG.A}, null, null, 'web', 'open', true, ${T("2026-10-01T00:00:00Z")}, ${T("2026-10-15T13:00:00Z")}),
  (${id("A-cv9")}, ${ORG.A}, ${id("A-c7")}, ${id("A-l7")}, 'sms', 'open', true, ${T("2026-10-01T00:00:00Z")}, ${T("2026-10-01T00:00:00Z")}),
  (${id("A-cv10")}, ${ORG.A}, ${id("A-c2")}, null, 'email', 'open', true, ${T("2026-10-01T00:00:00Z")}, ${T("2026-10-11T00:00:00Z")}),
  (${id("A-cv11")}, ${ORG.A}, ${id("A-c8")}, null, 'sms', 'open', true, ${T("2026-10-01T00:00:00Z")}, ${T("2026-10-11T00:00:00Z")});
insert into public.messages (id, organization_id, conversation_id, direction, sender_type, body, status, created_at) values
  (${id("A-m1")}, ${ORG.A}, ${id("A-cv1")}, 'outbound', 'ai', 'hi', 'sent', ${T("2026-10-15T12:30:00Z")}),
  (${id("A-m2")}, ${ORG.A}, ${id("A-cv1")}, 'inbound', 'customer', 'hello', 'received', ${T("2026-10-15T14:30:00Z")}),
  (${id("A-m3")}, ${ORG.A}, ${id("A-cv2")}, 'outbound', 'ai', 'following up', 'sent', ${T("2026-10-13T14:30:00Z")}),
  (${id("A-m4")}, ${ORG.A}, ${id("A-cv3")}, 'outbound', 'ai', 'just under 48h', 'sent', ${T("2026-10-13T16:30:00Z")}),
  (${id("A-m5")}, ${ORG.A}, ${id("A-cv4")}, 'outbound', 'ai', 'won lead', 'sent', ${T("2026-10-12T03:30:00Z")}),
  (${id("A-m6")}, ${ORG.A}, ${id("A-cv5")}, 'inbound', 'customer', 'closed one', 'received', ${T("2026-10-15T11:00:00Z")}),
  (${id("A-m7")}, ${ORG.A}, ${id("A-cv7")}, 'inbound', 'customer', 'unnamed', 'received', ${T("2026-10-14T09:00:00Z")}),
  (${id("A-m8")}, ${ORG.A}, ${id("A-cv8")}, 'inbound', 'customer', 'web', 'received', ${T("2026-10-15T09:00:00Z")}),
  (${id("A-m9")}, ${ORG.A}, ${id("A-cv9")}, 'outbound', 'user', 'lost lead', 'sent', ${T("2026-10-11T00:00:00Z")}),
  (${id("A-m10")}, ${ORG.A}, ${id("A-cv10")}, 'inbound', 'customer', 'email', 'received', ${T("2026-10-14T08:00:00Z")}),
  (${id("A-m11")}, ${ORG.A}, ${id("A-cv11")}, 'inbound', 'customer', 'sms', 'received', ${T("2026-10-14T07:00:00Z")}),
  (${id("A-m12")}, ${ORG.A}, ${id("A-cv6")}, 'outbound', 'system', 'exactly 48h', 'sent', ${T("2026-10-13T15:30:00Z")});
update public.conversations set updated_at = ${T("2026-10-13T15:30:00Z")} where id = ${id("A-cv6")};

insert into public.automation_incidents (id, organization_id, category, severity, status, fingerprint, title, description, metadata, last_seen_at) values
  (${id("A-inc1")}, ${ORG.A}, 'human_escalation_requested', 'warning', 'open', 'fp-a1', 'Escalation', 'Customer asked for a person', jsonb_build_object('conversationId', ${id("A-cv1")}), ${T("2026-10-15T10:00:00Z")}),
  (${id("A-inc2")}, ${ORG.A}, 'human_escalation_requested', 'warning', 'acknowledged', 'fp-a2', 'Escalation', null, '{}'::jsonb, ${T("2026-10-14T10:00:00Z")}),
  (${id("A-inc3")}, ${ORG.A}, 'human_escalation_requested', 'warning', 'resolved', 'fp-a3', 'Escalation', 'resolved one', '{}'::jsonb, ${T("2026-10-15T11:00:00Z")});
insert into public.calendar_connections (id, organization_id, provider, status, account_email) values (${id("A-cal")}, ${ORG.A}, 'google', 'error', 'owner@example.com');

insert into public.review_requests (id, organization_id, job_id, contact_id, status, created_at) values
  (${id("A-rv1")}, ${ORG.A}, ${id("A-j3")}, ${id("A-c1")}, 'responded', ${T("2026-10-12T00:00:00Z")}),
  (${id("A-rv2")}, ${ORG.A}, ${id("A-j4")}, null, 'requested', ${T("2026-10-11T00:00:00Z")}),
  (${id("A-rv3")}, ${ORG.A}, ${id("A-j7")}, null, 'responded', ${T("2026-10-13T00:00:00Z")});
insert into public.referral_requests (id, organization_id, job_id, contact_id, status, created_at) values
  (${id("A-rf1")}, ${ORG.A}, ${id("A-j3")}, ${id("A-c1")}, 'responded', ${T("2026-10-12T00:00:00Z")}),
  (${id("A-rf2")}, ${ORG.A}, ${id("A-j11")}, null, 'responded', ${T("2026-10-14T00:00:00Z")}),
  (${id("A-rf3")}, ${ORG.A}, ${id("A-j4")}, null, 'responded', ${T("2026-10-10T00:00:00Z")});
insert into public.audit_log (id, organization_id, action, entity_type, created_at) values
  (${id("A-au1")}, ${ORG.A}, 'lead.created', 'lead', ${T("2026-10-15T09:00:00Z")}),
  (${id("A-au2")}, ${ORG.A}, 'job.completed', 'job', ${T("2026-10-12T15:00:00Z")});

-- ======================= Org B (isolation: big values) ======================
insert into public.contacts (id, organization_id, first_name, last_name) values (${id("B-c1")}, ${ORG.B}, 'Zed', 'Other');
insert into public.leads (id, organization_id, contact_id, status, temperature, estimated_value, created_at) values
  (${id("B-l1")}, ${ORG.B}, ${id("B-c1")}, 'new', 'hot', 777777.77, ${T("2026-10-15T09:00:00Z")});
insert into public.appointments (id, organization_id, contact_id, title, status, start_at, end_at, created_at) values
  (${id("B-a1")}, ${ORG.B}, ${id("B-c1")}, 'B today', 'scheduled', ${T("2026-10-15T17:00:00Z")}, ${T("2026-10-15T18:00:00Z")}, ${T("2026-10-15T09:00:00Z")});
insert into public.estimates (id, organization_id, title, amount, status, sent_at, created_at) values (${id("B-e1")}, ${ORG.B}, 'B sent', 88888.88, 'sent', ${T("2026-10-15T09:00:00Z")}, ${T("2026-10-15T08:00:00Z")});
insert into public.jobs (id, organization_id, title, amount, status, completed_at, created_at) values
  (${id("B-j1")}, ${ORG.B}, 'B job', 66666.66, 'scheduled', null, ${T("2026-10-15T08:00:00Z")}),
  (${id("B-j2")}, ${ORG.B}, 'B done', 1.00, 'completed', ${T("2026-10-14T08:00:00Z")}, ${T("2026-10-10T08:00:00Z")});
insert into public.invoices (id, organization_id, job_id, number, title, status, subtotal, tax_amount, total, amount_paid, issued_at, due_date, created_at) values
  (${id("B-i1")}, ${ORG.B}, ${id("B-j1")}, 1, 'B overdue', 'sent', 55555.55, 0, 55555.55, 0, ${T("2026-10-01T08:00:00Z")}, '2026-10-02', ${T("2026-10-01T08:00:00Z")});
insert into public.customer_payments (id, organization_id, invoice_id, job_id, amount, method, received_at) values (${id("B-p1")}, ${ORG.B}, ${id("B-i1")}, ${id("B-j1")}, 44444.44, 'cash', ${T("2026-10-03T08:00:00Z")});
insert into public.conversations (id, organization_id, contact_id, channel, status, ai_enabled, updated_at) values (${id("B-cv1")}, ${ORG.B}, ${id("B-c1")}, 'sms', 'open', false, ${T("2026-10-15T15:00:00Z")});
insert into public.messages (id, organization_id, conversation_id, direction, sender_type, body, status, created_at) values (${id("B-m1")}, ${ORG.B}, ${id("B-cv1")}, 'inbound', 'customer', 'B', 'received', ${T("2026-10-15T15:10:00Z")});
insert into public.review_requests (id, organization_id, status, created_at) values (${id("B-rv1")}, ${ORG.B}, 'responded', ${T("2026-10-14T00:00:00Z")});

-- ======================= Org BIG (every old row cap exceeded) ======================
insert into public.contacts (id, organization_id, first_name, last_name, created_at)
  select md5('BIG-c' || g)::uuid, ${ORG.BIG}, 'Person', g::text, ${T("2025-01-01T00:00:00Z")} + g * interval '1 minute' from generate_series(1, 20) g;
-- 1,100 old appointments (the old read kept only the OLDEST 1,000), then 3 today.
insert into public.appointments (id, organization_id, title, status, start_at, end_at, created_at)
  select md5('BIG-a' || g)::uuid, ${ORG.BIG}, 'Old ' || g, 'completed', ${T("2025-01-01T12:00:00Z")} + g * interval '1 hour', ${T("2025-01-01T13:00:00Z")} + g * interval '1 hour', ${T("2025-01-01T00:00:00Z")} + g * interval '1 hour' from generate_series(1, 1100) g;
insert into public.appointments (id, organization_id, contact_id, title, status, start_at, end_at, created_at) values
  (${id("BIG-t1")}, ${ORG.BIG}, md5('BIG-c1')::uuid, 'Today 1', 'scheduled', ${T("2026-10-15T16:00:00Z")}, ${T("2026-10-15T17:00:00Z")}, ${T("2026-10-15T10:00:00Z")}),
  (${id("BIG-t2")}, ${ORG.BIG}, null, 'Today 2', 'confirmed', ${T("2026-10-15T17:00:00Z")}, ${T("2026-10-15T18:00:00Z")}, ${T("2026-10-15T10:05:00Z")}),
  (${id("BIG-t3")}, ${ORG.BIG}, md5('BIG-c2')::uuid, 'Today 3', 'scheduled', ${T("2026-10-15T18:00:00Z")}, ${T("2026-10-15T19:00:00Z")}, ${T("2026-10-15T10:10:00Z")});
-- 1,050 sent estimates; 20 of the OLDEST were sent today (the old newest-1,000 read missed them).
insert into public.estimates (id, organization_id, title, amount, status, sent_at, created_at)
  select md5('BIG-e' || g)::uuid, ${ORG.BIG}, 'Est ' || g, 10.00, 'sent',
         case when g <= 20 then ${T("2026-10-15T09:00:00Z")} else ${T("2025-06-01T09:00:00Z")} end,
         ${T("2025-01-01T00:00:00Z")} + g * interval '1 hour' from generate_series(1, 1050) g;
-- 1,050 scheduled jobs; 1,050 overdue sent invoices on them; 5,100 payments.
insert into public.jobs (id, organization_id, title, amount, status, created_at)
  select md5('BIG-j' || g)::uuid, ${ORG.BIG}, 'Job ' || g, 5.00, 'scheduled', ${T("2025-01-01T00:00:00Z")} + g * interval '1 hour' from generate_series(1, 1050) g;
insert into public.jobs (id, organization_id, title, amount, status, completed_at, created_at)
  select md5('BIG-jc' || g)::uuid, ${ORG.BIG}, 'Done ' || g, 3.00, 'completed', ${T("2026-10-14T12:00:00Z")}, ${T("2024-01-01T00:00:00Z")} + g * interval '1 minute' from generate_series(1, 30) g;
insert into public.invoices (id, organization_id, job_id, number, title, status, subtotal, tax_amount, total, amount_paid, issued_at, due_date, created_at)
  select md5('BIG-i' || g)::uuid, ${ORG.BIG}, md5('BIG-j' || g)::uuid, g, 'Inv ' || g, 'sent', 10.00, 0, 10.00, 0, ${T("2026-09-30T00:00:00Z")}, '2026-10-01', ${T("2026-09-30T00:00:00Z")} + g * interval '1 second' from generate_series(1, 1050) g;
insert into public.customer_payments (id, organization_id, invoice_id, job_id, amount, method, received_at)
  select md5('BIG-p' || g)::uuid, ${ORG.BIG}, md5('BIG-i' || (1 + g % 1050))::uuid, md5('BIG-j' || (1 + g % 1050))::uuid, 1.00, 'cash', ${T("2026-10-01T00:00:00Z")} + g * interval '1 second' from generate_series(1, 5100) g;
-- 520 open conversations, 2,100+ messages. bc-old has the NEWEST message but an
-- updated_at outside the newest 500 conversations; bc-lost has a recent
-- updated_at but its only (inbound) message is older than the newest 2,000.
insert into public.conversations (id, organization_id, contact_id, channel, status, ai_enabled, updated_at)
  select md5('BIG-cv' || g)::uuid, ${ORG.BIG}, null, 'sms', 'open', true, ${T("2026-09-01T00:00:00Z")} + g * interval '1 hour' from generate_series(1, 520) g;
insert into public.messages (id, organization_id, conversation_id, direction, sender_type, body, status, created_at)
  select md5('BIG-m' || g)::uuid, ${ORG.BIG}, md5('BIG-cv' || (1 + g % 520))::uuid, case when g % 3 = 0 then 'inbound' else 'outbound' end, 'customer', 'm', 'received', ${T("2026-09-01T00:00:00Z")} + g * interval '10 minutes' from generate_series(1, 2100) g;
insert into public.conversations (id, organization_id, contact_id, channel, status, ai_enabled, updated_at) values
  (${id("BIG-cv-old")}, ${ORG.BIG}, md5('BIG-c3')::uuid, 'sms', 'open', true, ${T("2020-01-01T00:00:00Z")}),
  (${id("BIG-cv-lost")}, ${ORG.BIG}, md5('BIG-c4')::uuid, 'sms', 'open', true, ${T("2026-10-15T15:00:00Z")});
insert into public.messages (id, organization_id, conversation_id, direction, sender_type, body, status, created_at) values
  (${id("BIG-m-old")}, ${ORG.BIG}, ${id("BIG-cv-old")}, 'inbound', 'customer', 'newest message overall', 'received', ${T("2026-10-15T15:20:00Z")}),
  (${id("BIG-m-lost")}, ${ORG.BIG}, ${id("BIG-cv-lost")}, 'inbound', 'customer', 'ancient', 'received', ${T("2020-01-01T00:00:00Z")});
-- 8 responded reviews inserted NEWEST first (heap order != created_at order), with
-- rv4..rv6 sharing one created_at so the id tie-breaker decides the 5th slot, plus
-- two older non-responded rows that must never be selected.
insert into public.review_requests (id, organization_id, job_id, status, created_at)
  select md5('BIG-rv' || g)::uuid, ${ORG.BIG}, md5('BIG-jc' || g)::uuid, 'responded', ${T("2026-10-01T00:00:00Z")} + least(g, 4) * interval '1 hour' + greatest(g - 6, 0) * interval '1 hour' from generate_series(8, 1, -1) g;
insert into public.review_requests (id, organization_id, status, created_at) values
  (md5('BIG-rv-req')::uuid, ${ORG.BIG}, 'requested', ${T("2026-09-01T00:00:00Z")}),
  (md5('BIG-rv-done')::uuid, ${ORG.BIG}, 'completed', ${T("2026-09-02T00:00:00Z")});

-- Org RR: more than five responded requests of BOTH kinds, inserted newest first, with
-- created_at ties straddling the 5th slot, plus older rows in other statuses.
insert into public.review_requests (id, organization_id, status, created_at)
  select md5('RR-rv' || g)::uuid, ${ORG.RR}, 'responded', ${T("2026-10-05T00:00:00Z")} + least(g, 3) * interval '1 day' from generate_series(7, 1, -1) g;
insert into public.review_requests (id, organization_id, status, created_at) values (md5('RR-rv-req')::uuid, ${ORG.RR}, 'requested', ${T("2026-09-01T00:00:00Z")});
insert into public.referral_requests (id, organization_id, status, created_at)
  select md5('RR-rf' || g)::uuid, ${ORG.RR}, 'responded', ${T("2026-10-02T00:00:00Z")} + least(g, 4) * interval '1 day' from generate_series(8, 1, -1) g;
insert into public.referral_requests (id, organization_id, status, created_at) values
  (md5('RR-rf-conv')::uuid, ${ORG.RR}, 'converted', ${T("2026-09-01T00:00:00Z")}),
  (md5('RR-rf-decl')::uuid, ${ORG.RR}, 'declined', ${T("2026-09-02T00:00:00Z")});
set session_replication_role = origin;
`);

// ---------------------------------------------------------------------------
// Phase 2E seeds: record-attention rules (dashboard_attention_sql.sql).
//   AT   - a boundary case for every rule (below every cap, so the legacy
//          loader is a valid oracle), UTC organization.
//   TIE  - identical timestamps, to pin the deterministic tie contract.
//   BIGL - above the leads (500), appointments (200) and estimates (500) caps.
// ---------------------------------------------------------------------------
await db.exec(`
set session_replication_role = replica;
insert into public.organizations (id, name, timezone, payment_status) values
  (${ORG.AT}, 'Org Attention boundaries', 'UTC', 'active'),
  (${ORG.TIE}, 'Org Ties', 'UTC', 'active'),
  (${ORG.BIGL}, 'Org Big records', 'UTC', 'active');

insert into public.contacts (id, organization_id, first_name, last_name) values
  (${id("AT-c1")}, ${ORG.AT}, 'Ann', 'Able'),
  (${id("AT-c2")}, ${ORG.AT}, null, null),
  (${id("AT-c3")}, ${ORG.AT}, '  ', null);

insert into public.leads (id, organization_id, contact_id, status, temperature, estimated_value, service, created_at) values
  (${id("AT-l1")}, ${ORG.AT}, ${id("AT-c1")}, 'new', 'hot', 100, 'Roof', ${T("2026-10-15T10:00:00Z")}),
  (${id("AT-l2")}, ${ORG.AT}, null, 'contacted', 'hot', null, 'Gutter', ${T("2026-10-15T09:00:00Z")}),
  (${id("AT-l3")}, ${ORG.AT}, ${id("AT-c2")}, 'qualified', 'hot', null, null, ${T("2026-10-15T08:00:00Z")}),
  (${id("AT-l4")}, ${ORG.AT}, null, 'appointment', 'hot', 5000, 'Siding', ${T("2026-10-15T07:00:00Z")}),
  (${id("AT-l5")}, ${ORG.AT}, null, 'estimate', 'hot', 250.5, 'Paint', ${T("2026-10-15T06:00:00Z")}),
  (${id("AT-l6")}, ${ORG.AT}, null, 'new', 'hot', null, 'Sixth hot', ${T("2026-10-15T05:00:00Z")}),
  (${id("AT-l7")}, ${ORG.AT}, null, 'won', 'hot', 7000, 'Won hot', ${T("2026-10-15T11:00:00Z")}),
  (${id("AT-l8")}, ${ORG.AT}, null, 'lost', 'hot', null, 'Lost hot', ${T("2026-10-15T12:00:00Z")}),
  (${id("AT-l9")}, ${ORG.AT}, null, 'new', 'warm', 5000.00, 'Exactly threshold', ${T("2026-10-14T10:00:00Z")}),
  (${id("AT-l10")}, ${ORG.AT}, null, 'contacted', 'cold', 4999.99, 'Just below', ${T("2026-10-14T09:00:00Z")}),
  (${id("AT-l11")}, ${ORG.AT}, null, 'qualified', 'warm', null, 'No value', ${T("2026-10-14T08:00:00Z")}),
  (${id("AT-l12")}, ${ORG.AT}, null, 'won', 'warm', 90000, 'Won big', ${T("2026-10-14T07:00:00Z")}),
  (${id("AT-l13")}, ${ORG.AT}, ${id("AT-c3")}, 'new', 'cold', 12000, null, ${T("2026-10-14T06:00:00Z")}),
  (${id("AT-l14")}, ${ORG.AT}, null, 'new', 'warm', 6000, 'HV 14', ${T("2026-10-13T10:00:00Z")}),
  (${id("AT-l15")}, ${ORG.AT}, null, 'contacted', 'warm', 7000, 'HV 15', ${T("2026-10-13T09:00:00Z")}),
  (${id("AT-l16")}, ${ORG.AT}, null, 'estimate', 'cold', 8000, 'HV 16', ${T("2026-10-13T08:00:00Z")}),
  (${id("AT-l17")}, ${ORG.AT}, null, 'appointment', 'warm', 9000, 'HV 17 (6th)', ${T("2026-10-13T07:00:00Z")}),
  (${id("AT-l18")}, ${ORG.AT}, null, 'lost', 'cold', null, 'Lost with sent estimate', ${T("2026-10-12T10:00:00Z")}),
  (${id("AT-l19")}, ${ORG.AT}, null, 'new', 'warm', null, 'Draft only', ${T("2026-10-12T09:00:00Z")}),
  (${id("AT-l20")}, ${ORG.AT}, null, 'new', 'warm', 42, 'Two sent', ${T("2026-10-12T08:00:00Z")}),
  (${id("AT-l21")}, ${ORG.AT}, null, 'contacted', 'warm', null, 'Accepted only', ${T("2026-10-12T07:00:00Z")}),
  (${id("AT-l22")}, ${ORG.AT}, null, 'new', 'warm', null, null, ${T("2026-10-12T06:00:00Z")});

-- Appointments. The fixed rule-level "now" is ${NOW_ISO}: a1 starts exactly then, a2 1 ms before.
insert into public.appointments (id, organization_id, contact_id, lead_id, title, status, start_at, end_at, created_at, confirmation_requested_at, confirmed_at) values
  (${id("AT-a1")}, ${ORG.AT}, ${id("AT-c1")}, null, 'Starts exactly now', 'scheduled', ${T("2026-10-15T15:30:00Z")}, ${T("2026-10-15T15:31:00Z")}, ${T("2026-10-01T09:00:00Z")}, ${T("2026-10-14T12:00:00Z")}, null),
  (${id("AT-a2")}, ${ORG.AT}, ${id("AT-c2")}, null, 'One ms before now', 'scheduled', ${T("2026-10-15T15:29:59.999Z")}, ${T("2026-10-15T15:30:00Z")}, ${T("2026-10-01T09:01:00Z")}, null, null),
  (${id("AT-a3")}, ${ORG.AT}, null, null, 'Requested and confirmed', 'scheduled', ${T("2026-10-16T10:00:00Z")}, ${T("2026-10-16T11:00:00Z")}, ${T("2026-10-01T09:02:00Z")}, ${T("2026-10-14T12:00:00Z")}, ${T("2026-10-14T13:00:00Z")}),
  (${id("AT-a4")}, ${ORG.AT}, null, null, 'Confirmed, past', 'confirmed', ${T("2026-10-15T12:00:00Z")}, ${T("2026-10-15T13:00:00Z")}, ${T("2026-10-01T09:03:00Z")}, null, null),
  (${id("AT-a5")}, ${ORG.AT}, null, null, 'Overdue 5 (6th)', 'scheduled', ${T("2026-10-14T10:00:00Z")}, ${T("2026-10-14T10:30:00Z")}, ${T("2026-10-01T09:04:00Z")}, null, null),
  (${id("AT-a6")}, ${ORG.AT}, null, null, 'Overdue 6', 'scheduled', ${T("2026-10-14T11:00:00Z")}, ${T("2026-10-14T11:30:00Z")}, ${T("2026-10-01T09:05:00Z")}, null, null),
  (${id("AT-a7")}, ${ORG.AT}, ${id("AT-c3")}, null, 'Overdue 7', 'scheduled', ${T("2026-10-14T12:00:00Z")}, ${T("2026-10-14T12:30:00Z")}, ${T("2026-10-01T09:06:00Z")}, null, null),
  (${id("AT-a8")}, ${ORG.AT}, null, null, 'Overdue 8', 'scheduled', ${T("2026-10-14T13:00:00Z")}, ${T("2026-10-14T13:30:00Z")}, ${T("2026-10-01T09:07:00Z")}, null, null),
  (${id("AT-a9")}, ${ORG.AT}, null, null, 'Overdue 9', 'scheduled', ${T("2026-10-14T14:00:00Z")}, ${T("2026-10-14T14:30:00Z")}, ${T("2026-10-01T09:08:00Z")}, null, null),
  (${id("AT-a10")}, ${ORG.AT}, null, ${id("AT-l1")}, 'Cancelled (not booked)', 'cancelled', ${T("2026-10-13T10:00:00Z")}, ${T("2026-10-13T11:00:00Z")}, ${T("2026-10-01T09:09:00Z")}, null, null),
  (${id("AT-a11")}, ${ORG.AT}, null, ${id("AT-l2")}, 'No-show (not booked)', 'no_show', ${T("2026-10-13T12:00:00Z")}, ${T("2026-10-13T13:00:00Z")}, ${T("2026-10-01T09:10:00Z")}, null, null),
  (${id("AT-a12")}, ${ORG.AT}, null, ${id("AT-l3")}, 'Completed (booked)', 'completed', ${T("2026-10-13T14:00:00Z")}, ${T("2026-10-13T15:00:00Z")}, ${T("2026-10-01T09:11:00Z")}, null, null),
  (${id("AT-a13")}, ${ORG.AT}, null, ${id("AT-l4")}, 'Booked future', 'scheduled', ${T("2026-10-22T10:00:00Z")}, ${T("2026-10-22T11:00:00Z")}, ${T("2026-10-01T09:12:00Z")}, null, null),
  (${id("AT-a14")}, ${ORG.AT}, null, ${id("AT-l4")}, 'Booked again', 'confirmed', ${T("2026-10-23T10:00:00Z")}, ${T("2026-10-23T11:00:00Z")}, ${T("2026-10-01T09:13:00Z")}, null, null),
  (${id("AT-a15")}, ${ORG.AT}, null, null, 'Awaiting 15', 'scheduled', ${T("2026-10-17T10:00:00Z")}, ${T("2026-10-17T11:00:00Z")}, ${T("2026-10-01T09:14:00Z")}, ${T("2026-10-14T12:00:00Z")}, null),
  (${id("AT-a16")}, ${ORG.AT}, ${id("AT-c1")}, null, 'Awaiting 16', 'scheduled', ${T("2026-10-18T10:00:00Z")}, ${T("2026-10-18T11:00:00Z")}, ${T("2026-10-01T09:15:00Z")}, ${T("2026-10-14T12:00:00Z")}, null),
  (${id("AT-a17")}, ${ORG.AT}, null, null, 'Awaiting 17', 'scheduled', ${T("2026-10-19T10:00:00Z")}, ${T("2026-10-19T11:00:00Z")}, ${T("2026-10-01T09:16:00Z")}, ${T("2026-10-13T12:00:00Z")}, null),
  (${id("AT-a18")}, ${ORG.AT}, null, null, 'Awaiting 18', 'scheduled', ${T("2026-10-20T10:00:00Z")}, ${T("2026-10-20T11:00:00Z")}, ${T("2026-10-01T09:17:00Z")}, ${T("2026-10-12T12:00:00Z")}, null),
  (${id("AT-a19")}, ${ORG.AT}, null, null, 'Awaiting 19', 'scheduled', ${T("2026-10-21T10:00:00Z")}, ${T("2026-10-21T11:00:00Z")}, ${T("2026-10-01T09:18:00Z")}, ${T("2026-10-11T12:00:00Z")}, null),
  (${id("AT-a20")}, ${ORG.AT}, null, null, 'Confirmed status, unconfirmed flag', 'confirmed', ${T("2026-10-24T10:00:00Z")}, ${T("2026-10-24T11:00:00Z")}, ${T("2026-10-01T09:19:00Z")}, ${T("2026-10-14T12:00:00Z")}, null);

insert into public.estimates (id, organization_id, lead_id, title, amount, status, sent_at, created_at) values
  (${id("AT-e1")}, ${ORG.AT}, ${id("AT-l1")}, 'Sent l1', 10, 'sent', ${T("2026-10-14T09:00:00Z")}, ${T("2026-10-14T08:00:00Z")}),
  (${id("AT-e2")}, ${ORG.AT}, ${id("AT-l18")}, 'Sent l18', 10, 'sent', ${T("2026-10-14T09:00:00Z")}, ${T("2026-10-14T08:00:00Z")}),
  (${id("AT-e3")}, ${ORG.AT}, ${id("AT-l19")}, 'Draft l19', 10, 'draft', null, ${T("2026-10-14T08:00:00Z")}),
  (${id("AT-e4")}, ${ORG.AT}, ${id("AT-l20")}, 'Sent l20 a', 10, 'sent', ${T("2026-10-14T09:00:00Z")}, ${T("2026-10-14T08:00:00Z")}),
  (${id("AT-e5")}, ${ORG.AT}, ${id("AT-l20")}, 'Sent l20 b', 10, 'sent', ${T("2026-10-14T09:00:00Z")}, ${T("2026-10-14T08:00:00Z")}),
  (${id("AT-e6")}, ${ORG.AT}, ${id("AT-l21")}, 'Accepted l21', 10, 'accepted', ${T("2026-10-14T09:00:00Z")}, ${T("2026-10-14T08:00:00Z")}),
  (${id("AT-e7")}, ${ORG.AT}, null, 'Sent, no lead', 10, 'sent', ${T("2026-10-14T09:00:00Z")}, ${T("2026-10-14T08:00:00Z")}),
  (${id("AT-e8")}, ${ORG.AT}, ${id("AT-l22")}, 'Sent l22 (no contact, no service)', 10, 'sent', ${T("2026-10-14T09:00:00Z")}, ${T("2026-10-14T08:00:00Z")});

insert into public.opportunities (id, organization_id, type, status, source_entity_type, source_entity_id, title, created_at) values
  (${id("AT-o1")}, ${ORG.AT}, 'uncontacted_lead', 'open', 'lead', ${id("AT-l1")}, 'Uncontacted hot', ${T("2026-10-15T10:01:00Z")}),
  (${id("AT-o2")}, ${ORG.AT}, 'uncontacted_lead', 'open', 'lead', ${id("AT-l9")}, 'Uncontacted high-value', ${T("2026-10-15T10:02:00Z")}),
  (${id("AT-o3")}, ${ORG.AT}, 'uncontacted_lead', 'open', 'lead', ${id("AT-l19")}, 'Uncontacted plain', ${T("2026-10-15T10:03:00Z")}),
  (${id("AT-o4")}, ${ORG.AT}, 'uncontacted_lead', 'open', 'lead', ${id("AT-l7")}, 'Uncontacted won-hot', ${T("2026-10-15T10:04:00Z")}),
  (${id("AT-o5")}, ${ORG.AT}, 'uncontacted_lead', 'dismissed', 'lead', ${id("AT-l2")}, 'Dismissed hot', ${T("2026-10-15T10:05:00Z")});


-- ATH / ATV: AT's leads split so the global 10-item attention list isn't
-- filled by appointments - ATH gets the hot leads, ATV the rest - with their
-- contacts, estimates and opportunities, so every mapped field of hot_lead,
-- high_value_lead, pending_estimate and the uncontacted de-duplication is
-- compared against the legacy loader.
insert into public.organizations (id, name, timezone, payment_status) values
  (${ORG.ATH}, 'Org AT hot leads', 'UTC', 'active'), (${ORG.ATV}, 'Org AT other leads', 'UTC', 'active');
insert into public.contacts (id, organization_id, first_name, last_name)
  select md5(c.id::text || k.tag)::uuid, k.org, c.first_name, c.last_name from public.contacts c, (values (${ORG.ATH}, 'ATH'), (${ORG.ATV}, 'ATV')) k(org, tag) where c.organization_id = ${ORG.AT};
insert into public.leads (id, organization_id, contact_id, status, temperature, estimated_value, service, created_at)
  select md5(l.id::text || k.tag)::uuid, k.org, md5(l.contact_id::text || k.tag)::uuid, l.status, l.temperature, l.estimated_value, l.service, l.created_at
  from public.leads l, (values (${ORG.ATH}, 'ATH', true), (${ORG.ATV}, 'ATV', false)) k(org, tag, hot)
  where l.organization_id = ${ORG.AT} and (l.temperature = 'hot') = k.hot;
insert into public.estimates (id, organization_id, lead_id, title, amount, status, sent_at, created_at)
  select md5(e.id::text || l.organization_id::text)::uuid, l.organization_id, l.id, e.title, e.amount, e.status, e.sent_at, e.created_at
  from public.estimates e join public.leads l on l.id in (md5(e.lead_id::text || 'ATH')::uuid, md5(e.lead_id::text || 'ATV')::uuid) where e.organization_id = ${ORG.AT};
insert into public.opportunities (id, organization_id, type, status, source_entity_type, source_entity_id, title, created_at)
  select md5(o.id::text || l.organization_id::text)::uuid, l.organization_id, o.type, o.status, o.source_entity_type, l.id, o.title, o.created_at
  from public.opportunities o join public.leads l on l.id in (md5(o.source_entity_id::text || 'ATH')::uuid, md5(o.source_entity_id::text || 'ATV')::uuid) where o.organization_id = ${ORG.AT};

-- TIE: equal created_at among hot leads straddling the 5th slot, and equal
-- start_at among cancelled appointments (the only statuses that may overlap).
insert into public.leads (id, organization_id, status, temperature, service, created_at)
  select md5('TIE-l' || g)::uuid, ${ORG.TIE}, 'new', 'hot', 'Tie ' || g, case when g <= 3 then ${T("2026-10-15T10:00:00Z")} else ${T("2026-10-14T10:00:00Z")} end from generate_series(1, 7) g;
insert into public.appointments (id, organization_id, title, status, start_at, end_at, created_at)
  select md5('TIE-a' || g)::uuid, ${ORG.TIE}, 'Tie appt ' || g, 'cancelled', ${T("2026-10-20T10:00:00Z")}, ${T("2026-10-20T11:00:00Z")}, ${T("2026-10-01T00:00:00Z")} + g * interval '1 minute' from generate_series(1, 7) g;

-- BIGL: the newest 500 leads are all lost/cold, so every actionable lead is
-- older than the legacy newest-500 read; 230 future appointments push all 30
-- overdue ones (and the 6 nearest awaiting confirmation) out of the legacy
-- latest-start-200 read; the 4 sent estimates are inserted after 510 drafts,
-- beyond the legacy unordered 500-row read.
insert into public.leads (id, organization_id, status, temperature, created_at)
  select md5('BIGL-new' || g)::uuid, ${ORG.BIGL}, 'lost', 'cold', ${T("2026-10-01T00:00:00Z")} + g * interval '1 minute' from generate_series(1, 500) g;
insert into public.leads (id, organization_id, status, temperature, estimated_value, service, created_at)
  select md5('BIGL-old' || g)::uuid, ${ORG.BIGL},
         case when g between 11 and 14 then 'contacted' else 'new' end,
         case when g <= 7 then 'hot' else 'warm' end,
         case when g between 8 and 10 then 7000 else null end,
         'Old ' || g, ${T("2025-01-01T00:00:00Z")} + g * interval '1 hour' from generate_series(1, 100) g;
insert into public.appointments (id, organization_id, lead_id, title, status, start_at, end_at, created_at, confirmation_requested_at)
  select md5('BIGL-f' || g)::uuid, ${ORG.BIGL}, case when g = 1 then md5('BIGL-old20')::uuid end, 'Future ' || g, 'scheduled',
         ${T("2026-10-16T00:00:00Z")} + g * interval '1 hour', ${T("2026-10-16T00:30:00Z")} + g * interval '1 hour', ${T("2026-09-01T00:00:00Z")} + g * interval '1 minute',
         case when g <= 6 or g >= 228 then ${T("2026-10-14T12:00:00Z")} end
  from generate_series(1, 230) g;
insert into public.appointments (id, organization_id, title, status, start_at, end_at, created_at)
  select md5('BIGL-p' || g)::uuid, ${ORG.BIGL}, 'Overdue ' || g, 'scheduled', ${T("2026-09-01T00:00:00Z")} + g * interval '1 hour', ${T("2026-09-01T00:30:00Z")} + g * interval '1 hour', ${T("2026-08-01T00:00:00Z")} + g * interval '1 minute' from generate_series(1, 30) g;
insert into public.estimates (id, organization_id, title, amount, status, created_at)
  select md5('BIGL-d' || g)::uuid, ${ORG.BIGL}, 'Draft ' || g, 1, 'draft', ${T("2025-01-01T00:00:00Z")} + g * interval '1 minute' from generate_series(1, 510) g;
insert into public.estimates (id, organization_id, lead_id, title, amount, status, sent_at, created_at)
  select md5('BIGL-s' || g)::uuid, ${ORG.BIGL}, md5('BIGL-old' || (10 + g))::uuid, 'Sent ' || g, 1, 'sent', ${T("2026-10-10T00:00:00Z")}, ${T("2026-10-10T00:00:00Z")} + g * interval '1 minute' from generate_series(1, 4) g;
insert into public.opportunities (id, organization_id, type, status, source_entity_type, source_entity_id, title, created_at) values
  (${id("BIGL-o1")}, ${ORG.BIGL}, 'uncontacted_lead', 'open', 'lead', md5('BIGL-old1')::uuid, 'Uncontacted old hot lead', ${T("2026-10-15T10:00:00Z")}),
  (${id("BIGL-o2")}, ${ORG.BIGL}, 'uncontacted_lead', 'open', 'lead', md5('BIGL-old50')::uuid, 'Uncontacted old plain lead', ${T("2026-10-15T10:01:00Z")});
set session_replication_role = origin;
`);

// ---------------------------------------------------------------------------
// App modules and client
// ---------------------------------------------------------------------------
const requestLog = [];
const pg = await startPostgrest(db, { onRequest: (r) => { requestLog.push(r); debug(`req ${r.kind} ${r.table} rows=${r.rows}`); } });
debug("seeded; adapter at " + pg.url);
const { createClient } = await import("@supabase/supabase-js");
const supabase = createClient(pg.url, "fake-anon-key-local-only", { auth: { persistSession: false, autoRefreshToken: false } });
const imp = (p) => import(path.join(ROOT, p));
const { getHotLeadCount } = await imp("lib/leads/queries.ts");
const { getDashboardPipelineValue } = await imp("lib/dashboard/business-metrics.ts");
const { getAppointments, summarizeAppointments } = await imp("lib/appointments/queries.ts");
const { getEstimatesResult } = await imp("lib/estimates/queries.ts");
const { getJobsResult } = await imp("lib/jobs/queries.ts");
const { getInvoicesResult, getCustomerPaymentsResult } = await imp("lib/invoices/queries.ts");
const { computeMoneySnapshot } = await imp("lib/money/snapshot.ts");
const { summarizeInvoiceMoney } = await imp("lib/invoices/summary.ts");
const { calendarDateInTimeZone } = await imp("lib/invoices/domain.ts");
const { getOrganizationTimezone } = await imp("lib/settings/queries.ts");
const dashboardQueries = await imp("lib/dashboard/queries.ts");
const briefing = await imp("lib/briefing/queries.ts");
const { getOperationalExceptions, getConversationSignals } = await imp("lib/opportunities/intelligence.ts");
const sql = await imp("lib/dashboard/sql.ts");
const { attachLastMessages } = await imp("lib/conversations/queries.ts");

// ---------------------------------------------------------------------------
// What the Dashboard renders
// ---------------------------------------------------------------------------
const stripGenerated = (o) => {
  const { generatedAt, ...rest } = o;
  void generatedAt;
  return rest;
};
const cents = (v) => Math.round(v * 100) / 100;
function canon(value) {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, canon(v)]));
  if (typeof value === "number") return cents(value);
  return value;
}
const pickAttention = (items) => items.map(({ id, kind, title, detail, value, href, incidentId, incidentStatus }) => ({ id, kind, title, detail, value, href, incidentId, incidentStatus }));

/** The pre-Phase-2D page figures, from the pre-Phase-2D loaders (still in the codebase: other pages use them). */
async function oldPageFigures(org) {
  const [hotLeadCount, pipeline, appointments, estimatesResult, jobsResult, invoicesResult, paymentsResult, timeZone] = await Promise.all([
    getHotLeadCount(supabase, org),
    getDashboardPipelineValue(supabase, org),
    getAppointments(supabase, org),
    getEstimatesResult(supabase, org),
    getJobsResult(supabase, org),
    getInvoicesResult(supabase, org),
    getCustomerPaymentsResult(supabase, org),
    getOrganizationTimezone(supabase, org),
  ]);
  const money = computeMoneySnapshot(estimatesResult.data, jobsResult.data);
  const today = calendarDateInTimeZone(new Date(), timeZone ?? "UTC");
  return canon({
    hotLeadCount,
    pipelineValue: pipeline.pipelineValue,
    appointmentsToday: summarizeAppointments(appointments).today,
    money: { quotesOutCount: money.quotesOut.length, readyToScheduleCount: money.readyToSchedule.length, wonNotFinishedCount: money.wonNotFinished.length, knownOpportunityValue: money.knownOpportunityValue },
    invoiceSummary: summarizeInvoiceMoney({ invoices: invoicesResult.data, payments: paymentsResult.data, jobs: jobsResult.data, today }),
    moneyDataFailed: estimatesResult.failed || jobsResult.failed || invoicesResult.failed || paymentsResult.failed,
  });
}

/** The Phase 2D page figures, from dashboard_summary. */
async function newPageFigures(org) {
  const [summary, timeZone] = await Promise.all([sql.getDashboardSummary(supabase, org), getOrganizationTimezone(supabase, org)]);
  const today = calendarDateInTimeZone(new Date(), timeZone ?? "UTC");
  return canon({
    hotLeadCount: summary.data.hot_lead_count,
    pipelineValue: summary.data.pipeline_value,
    appointmentsToday: summary.data.appointments_today,
    money: sql.dashboardMoneyCounts(summary.data),
    invoiceSummary: sql.dashboardInvoiceSummary(summary.data, today),
    moneyDataFailed: summary.failed,
  });
}

/** getDashboardData + briefing + end-of-day: whatever version is currently in lib (options select the Phase 2D path once it exists). */
async function sections(org, options) {
  const data = options ? await dashboardQueries.getDashboardData(supabase, org, options.dashboard) : await dashboardQueries.getDashboardData(supabase, org);
  const daily = options ? await briefing.getOwnerDailyBriefing(supabase, org, new Date(), options.briefing) : await briefing.getOwnerDailyBriefing(supabase, org);
  const endOfDay = options ? await briefing.getEndOfDaySummary(supabase, org, new Date(), options.briefing) : await briefing.getEndOfDaySummary(supabase, org);
  return canon({
    attentionItems: pickAttention(data.attentionItems),
    operationalExceptions: getOperationalExceptions(data.attentionItems),
    conversationSignals: getConversationSignals(data.attentionItems).map(({ kind, title, href, tier, recommendedAction }) => ({ kind, title, href, tier, recommendedAction })),
    overview: data.overview,
    recentActivity: data.recentActivity,
    partialData: data.partialData,
    dailyBriefing: stripGenerated(daily),
    endOfDay: stripGenerated(endOfDay),
  });
}

// ---------------------------------------------------------------------------
// Uncapped reference: the same TypeScript definitions over COMPLETE data.
// ---------------------------------------------------------------------------
async function all(table, select, orderCol, ascending, org) {
  const { data, error } = await supabase.from(table).select(select).eq("organization_id", org).order(orderCol, { ascending }).limit(1000000);
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}
/** The Phase 2D contract for responded review/referral requests, computed in JS: status responded, created_at ASC then id ASC (uuid order == lowercase-hex string order), first five. */
function oldestResponded(rows) {
  return rows
    .filter((r) => r.status === "responded")
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, 5)
    .map((r) => r.id);
}
async function uncappedReference(org) {
  const contact = "contact:contacts(id, first_name, last_name, company_name, phone, email)";
  const [appointments, estimates, jobs, invoices, payments, conversations, messages, reviews, referrals, timeZone] = await Promise.all([
    all("appointments", `*, ${contact}`, "start_at", true, org),
    all("estimates", `*, ${contact}`, "created_at", false, org),
    all("jobs", `*, ${contact}`, "created_at", false, org),
    all("invoices", "*", "created_at", false, org),
    all("customer_payments", "*", "received_at", false, org),
    all("conversations", `*, ${contact}, lead:leads(id, status)`, "updated_at", false, org),
    all("messages", "*", "created_at", false, org),
    all("review_requests", "*", "created_at", true, org),
    all("referral_requests", "*", "created_at", true, org),
    getOrganizationTimezone(supabase, org),
  ]);
  const now = new Date();
  const today = calendarDateInTimeZone(now, timeZone ?? "UTC");
  const money = computeMoneySnapshot(estimates, jobs);
  const lastMessages = new Map();
  for (const m of messages) if (!lastMessages.has(m.conversation_id)) lastMessages.set(m.conversation_id, m);
  // Phase 3 (W1): the canonical evidence - newest inbound or sent/delivered outbound message per conversation.
  const lastEvidence = new Map();
  for (const m of messages) if (!lastEvidence.has(m.conversation_id) && (m.direction === "inbound" || ["sent", "delivered"].includes(m.status))) lastEvidence.set(m.conversation_id, m);
  const withLast = attachLastMessages(conversations, lastMessages);
  const nameOf = (c) => {
    const n = c ? [c.first_name, c.last_name].filter(Boolean).join(" ").trim() : "";
    return n || null;
  };
  const awaiting = withLast.filter((c) => c.status === "open" && lastEvidence.get(c.id)?.direction === "inbound").slice(0, 5).map((c) => `reply-${c.id}:${nameOf(c.contact) ?? "Customer"}`);
  const abandoned = withLast
    .filter((c) => c.status === "open" && lastEvidence.get(c.id)?.direction === "outbound" && now.getTime() - new Date(c.lastActivityAt).getTime() >= 48 * 3600 * 1000 && (c.lead == null || ["new", "contacted", "qualified"].includes(c.lead.status)))
    .slice(0, 5)
    .map((c) => `abandoned-${c.id}:${nameOf(c.contact) ?? "Customer"}`);
  const isToday = (iso) => {
    const d = new Date(iso);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  };
  const sevenDaysAgo = now.getTime() - 7 * 24 * 3600 * 1000;
  const estimatesSentToday = estimates.filter((e) => e.sent_at && isToday(e.sent_at));
  const jobsToday = jobs.filter((j) => (j.status !== "cancelled" && isToday(j.created_at)) || (j.status === "completed" && j.completed_at && isToday(j.completed_at)));
  return canon({
    page: {
      appointmentsToday: summarizeAppointments(appointments).today,
      money: { quotesOutCount: money.quotesOut.length, readyToScheduleCount: money.readyToSchedule.length, wonNotFinishedCount: money.wonNotFinished.length, knownOpportunityValue: money.knownOpportunityValue },
      invoiceSummary: summarizeInvoiceMoney({ invoices, payments, jobs, today }),
    },
    attention: { awaiting, abandoned },
    briefing: {
      appointmentsToday: appointments.filter((a) => isToday(a.start_at) && (a.status === "scheduled" || a.status === "confirmed")).slice(0, 5).map((a) => a.id),
      estimatesAwaitingAction: estimates.filter((e) => e.status === "sent").slice(0, 5).map((e) => e.id),
      jobsRecentlyCompleted: jobs.filter((j) => j.status === "completed" && j.completed_at && new Date(j.completed_at).getTime() >= sevenDaysAgo).slice(0, 5).map((j) => j.id),
      reviewReferral: [...oldestResponded(reviews), ...oldestResponded(referrals)].slice(0, 5),
      appointmentsBooked: appointments.filter((a) => isToday(a.created_at)).length,
      estimatesSent: estimatesSentToday.length,
      jobsWonOrCompleted: jobsToday.length,
      valueRepresented: estimatesSentToday.reduce((s, e) => s + (e.amount ?? 0), 0) + jobsToday.reduce((s, j) => s + (j.amount ?? 0), 0),
    },
  });
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------
let failures = 0;
let passes = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passes++;
    return true;
  }
  failures++;
  console.log(`FAIL ${label}\n  expected: ${e.slice(0, 1500)}\n  actual:   ${a.slice(0, 1500)}`);
  if (process.env.FAIL_DIR) writeFileSync(`${process.env.FAIL_DIR}/fail-${failures}.json`, JSON.stringify({ label, expected, actual }));
  return false;
}
async function rowsFor(fn) {
  const start = requestLog.length;
  const result = await fn();
  const slice = requestLog.slice(start);
  return { result, requests: slice.length, rows: slice.reduce((s, r) => s + r.rows, 0) };
}

const orgs = { E: await orgId("E"), A: await orgId("A"), B: await orgId("B"), BIG: await orgId("BIG") };

if (MODE === "capture") {
  const baseline = { tz: TZ, now: NOW_ISO, orgs: {} };
  for (const [key, org] of Object.entries(orgs)) {
    const page = await rowsFor(() => oldPageFigures(org));
    const sec = await rowsFor(() => sections(org, null));
    baseline.orgs[key] = { page: page.result, sections: sec.result, cost: { pageRequests: page.requests, pageRows: page.rows, sectionRequests: sec.requests, sectionRows: sec.rows } };
    console.log(`captured ${key}: page ${page.requests} requests/${page.rows} rows, sections ${sec.requests} requests/${sec.rows} rows`);
  }
  writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + "\n");
  console.log(`wrote ${path.relative(ROOT, BASELINE)}`);
} else {
  if (!existsSync(BASELINE)) throw new Error(`missing ${BASELINE} - run capture first (before switching)`);
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
  const phase2d = { dashboard: { conversationAttention: "sql" }, briefing: { source: "sql" } };
  const supportsOptions = typeof dashboardQueries.getDashboardSqlData === "function";

  for (const [key, org] of Object.entries(orgs)) {
    const base = baseline.orgs[key];
    const page = await rowsFor(() => newPageFigures(org));
    const oldNow = await rowsFor(() => oldPageFigures(org));
    const sec = await rowsFor(() => sections(org, supportsOptions ? phase2d : null));
    const capped = key === "BIG";

    // The frozen baseline must still describe the pre-Phase-2D loaders exactly (they still exist).
    check(`${key}: pre-2D page loaders unchanged vs frozen baseline`, oldNow.result, base.page);

    if (!capped) {
      check(`${key}: page figures (dashboard_summary) == frozen baseline`, page.result, base.page);
      // reviewReferralOpportunities: the old reads had no ORDER BY (undefined order); Phase 2D
      // intentionally orders created_at ASC, id ASC. Every other field must equal the baseline exactly.
      const withoutRR = (x) => ({ ...x, dailyBriefing: { ...x.dailyBriefing, reviewReferralOpportunities: undefined } });
      check(`${key}: attention/briefing/end-of-day (Phase 2D path) == frozen baseline, all fields except reviewReferralOpportunities`, withoutRR(sec.result), withoutRR(base.sections));
      const [rvAll, rfAll] = await Promise.all([all("review_requests", "*", "created_at", true, org), all("referral_requests", "*", "created_at", true, org)]);
      check(`${key}: reviewReferralOpportunities == new contract (created_at ASC, id ASC, first five)`, sec.result.dailyBriefing.reviewReferralOpportunities.map((x) => x.id), [...oldestResponded(rvAll), ...oldestResponded(rfAll)].slice(0, 5));
      check(`${key}: reviewReferralOpportunities holds the same items as the baseline (only order may differ)`, sec.result.dailyBriefing.reviewReferralOpportunities.map((x) => JSON.stringify(x)).sort(), base.sections.dailyBriefing.reviewReferralOpportunities.map((x) => JSON.stringify(x)).sort());
    } else {
      const ref = await uncappedReference(org);
      check(`${key}: page figures == TypeScript definitions over complete data`, { appointmentsToday: page.result.appointmentsToday, money: page.result.money, invoiceSummary: page.result.invoiceSummary }, ref.page);
      const attention = [...sec.result.attentionItems.filter((i) => i.kind === "awaiting_reply").map((i) => `${i.id}:${i.title}`)];
      const abandoned = sec.result.attentionItems.filter((i) => i.kind === "abandoned_conversation").map((i) => `${i.id}:${i.title}`);
      check(`${key}: awaiting_reply == definition over complete data`, attention, ref.attention.awaiting);
      check(`${key}: abandoned_conversation == definition over complete data`, abandoned, ref.attention.abandoned);
      const d = sec.result.dailyBriefing;
      const e = sec.result.endOfDay;
      check(`${key}: briefing lists/counts == definition over complete data`, {
        appointmentsToday: d.appointmentsToday.map((a) => a.id),
        estimatesAwaitingAction: d.estimatesAwaitingAction.map((x) => x.id),
        jobsRecentlyCompleted: d.jobsRecentlyCompleted.map((x) => x.id),
        reviewReferral: d.reviewReferralOpportunities.map((x) => x.id),
        appointmentsBooked: e.appointmentsBooked,
        estimatesSent: e.estimatesSent,
        jobsWonOrCompleted: e.jobsWonOrCompleted,
        valueRepresented: e.valueRepresented,
      }, ref.briefing);
      // Everything the caps never touched still matches the baseline exactly.
      check(`${key}: uncapped-independent figures == frozen baseline`, { hot: page.result.hotLeadCount, pipeline: page.result.pipelineValue, recentActivity: sec.result.recentActivity, overview: sec.result.overview, partial: sec.result.partialData }, { hot: base.page.hotLeadCount, pipeline: base.page.pipelineValue, recentActivity: base.sections.recentActivity, overview: base.sections.overview, partial: base.sections.partialData });
      console.log(`  ${key} above the caps - old (capped) vs new (complete):`);
      console.log(`    appointments today      ${base.page.appointmentsToday} -> ${page.result.appointmentsToday}`);
      console.log(`    quotes out              ${base.page.money.quotesOutCount} -> ${page.result.money.quotesOutCount}`);
      console.log(`    jobs in progress        ${base.page.money.wonNotFinishedCount} -> ${page.result.money.wonNotFinishedCount}`);
      console.log(`    invoiced / overdue      ${base.page.invoiceSummary.invoiced} / ${base.page.invoiceSummary.overdue} -> ${page.result.invoiceSummary.invoiced} / ${page.result.invoiceSummary.overdue}`);
      console.log(`    collected (payments)    ${base.page.invoiceSummary.collected} -> ${page.result.invoiceSummary.collected}`);
      console.log(`    briefing appts today    ${base.sections.dailyBriefing.appointmentsToday.length} -> ${sec.result.dailyBriefing.appointmentsToday.length}`);
      console.log(`    EOD estimates sent      ${base.sections.endOfDay.estimatesSent} -> ${sec.result.endOfDay.estimatesSent}`);
      console.log(`    awaiting_reply ids      ${base.sections.attentionItems.filter((i) => i.kind === "awaiting_reply").map((i) => i.id.slice(6, 14)).join(",")} -> ${sec.result.attentionItems.filter((i) => i.kind === "awaiting_reply").map((i) => i.id.slice(6, 14)).join(",")}`);
    }
    console.log(`  ${key} cost: page ${base.cost.pageRequests} req/${base.cost.pageRows} rows -> ${page.requests} req/${page.rows} rows; sections ${base.cost.sectionRequests} req/${base.cost.sectionRows} rows -> ${sec.requests} req/${sec.rows} rows`);
  }

  // ---- More than five responded review/referral requests (org RR, and BIG's reviews) ----
  if (supportsOptions) {
    const rr = await orgId("RR");
    const [rvAll, rfAll] = await Promise.all([all("review_requests", "*", "created_at", true, rr), all("referral_requests", "*", "created_at", true, rr)]);
    const inputs = await sql.getDashboardBriefingInputs(supabase, rr, new Date());
    check("RR: >5 responded reviews - SQL selects the five oldest (created_at ASC, id ASC)", inputs.data.responded_reviews.map((r) => r.id), oldestResponded(rvAll));
    check("RR: >5 responded referrals - SQL selects the five oldest (created_at ASC, id ASC)", inputs.data.responded_referrals.map((r) => r.id), oldestResponded(rfAll));
    check("RR: the 5th-slot created_at tie is broken by id ASC", { reviews: rvAll.filter((r) => r.status === "responded").length, referrals: rfAll.filter((r) => r.status === "responded").length, tiedAtCut: [inputs.data.responded_reviews[4].id < rvAll.filter((r) => r.status === "responded" && r.created_at === rvAll.find((x) => x.id === inputs.data.responded_reviews[4].id).created_at && !inputs.data.responded_reviews.some((s) => s.id === r.id)).map((r) => r.id).sort()[0], inputs.data.responded_referrals[4].id < rfAll.filter((r) => r.status === "responded" && r.created_at === rfAll.find((x) => x.id === inputs.data.responded_referrals[4].id).created_at && !inputs.data.responded_referrals.some((s) => s.id === r.id)).map((r) => r.id).sort()[0]] }, { reviews: 7, referrals: 8, tiedAtCut: [true, true] });
    const daily = await briefing.getOwnerDailyBriefing(supabase, rr, new Date(), phase2d.briefing);
    check("RR: briefing reviewReferralOpportunities == five oldest reviews, then referrals, first five", daily.reviewReferralOpportunities.map((x) => `${x.kind}:${x.id}`), [...oldestResponded(rvAll).map((id) => `review:${id}`), ...oldestResponded(rfAll).map((id) => `referral:${id}`)].slice(0, 5));
    const legacy = await briefing.getOwnerDailyBriefing(supabase, rr, new Date());
    console.log(`  RR reviewReferral selection  legacy (no ORDER BY): ${legacy.reviewReferralOpportunities.map((x) => x.id.slice(0, 8)).join(",")}  ->  2D: ${daily.reviewReferralOpportunities.map((x) => x.id.slice(0, 8)).join(",")}`);
  }

  // ---- Phase 2E: record attention (dashboard_record_attention) ----
  if (typeof sql.getDashboardRecordAttention === "function") {
    const phase2e = { dashboard: { conversationAttention: "sql", recordAttention: "sql" }, briefing: { source: "sql" } };
    const HV = dashboardQueries.HIGH_VALUE_THRESHOLD;
    const ACTIVE = new Set(["new", "contacted", "qualified", "appointment", "estimate"]);
    const byDesc = (key) => (a, b) => Date.parse(b[key]) - Date.parse(a[key]) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    // The legacy rules, restated over COMPLETE data at a fixed "now", with the
    // deterministic (timestamp DESC, id ASC) contract.
    async function refRecord(org, nowMs) {
      const [leads, appts, ests, opps] = await Promise.all([all("leads", "*", "created_at", false, org), all("appointments", "*", "start_at", false, org), all("estimates", "*", "created_at", false, org), all("opportunities", "*", "created_at", false, org)]);
      const leadsSorted = leads.slice().sort(byDesc("created_at"));
      const apptsSorted = appts.slice().sort(byDesc("start_at"));
      const sentLeadIds = new Set(ests.filter((e) => e.lead_id && e.status === "sent").map((e) => e.lead_id));
      const bookedLeadIds = new Set(appts.filter((a) => a.lead_id && ["scheduled", "confirmed", "completed"].includes(a.status)).map((a) => a.lead_id));
      const hotOrHv = (l) => ACTIVE.has(l.status) && (l.temperature === "hot" || (l.estimated_value != null && Number(l.estimated_value) >= HV));
      const uncontactedSources = new Set(opps.filter((o) => o.status === "open" && o.type === "uncontacted_lead").map((o) => o.source_entity_id));
      const ids = (rows) => rows.slice(0, 5).map((r) => r.id);
      return {
        overdue: ids(apptsSorted.filter((a) => a.status === "scheduled" && Date.parse(a.start_at) < nowMs)),
        awaiting: ids(apptsSorted.filter((a) => a.status === "scheduled" && a.confirmation_requested_at != null && a.confirmed_at == null && Date.parse(a.start_at) >= nowMs)),
        hot: ids(leadsSorted.filter((l) => l.temperature === "hot" && ACTIVE.has(l.status))),
        highValue: ids(leadsSorted.filter((l) => l.temperature !== "hot" && ACTIVE.has(l.status) && l.estimated_value != null && Number(l.estimated_value) >= HV)),
        pending: ids(leadsSorted.filter((l) => sentLeadIds.has(l.id))),
        dedup: leads.filter((l) => hotOrHv(l) && uncontactedSources.has(l.id)).map((l) => l.id).sort(),
        recentLeads: ids(leadsSorted),
        recentAppointments: ids(apptsSorted),
        newLeads: leads.filter((l) => l.status === "new").length,
        openLeads: leads.filter((l) => ACTIVE.has(l.status)).length,
        upcoming: appts.filter((a) => (a.status === "scheduled" || a.status === "confirmed") && Date.parse(a.start_at) >= nowMs).length,
        pendingEstimates: ests.filter((e) => e.status === "sent").length,
        pipeline: { new: leads.filter((l) => l.status === "new").length, contacted: leads.filter((l) => l.status === "contacted").length, qualified: leads.filter((l) => l.status === "qualified").length, appointment: leads.filter((l) => bookedLeadIds.has(l.id)).length, estimate: leads.filter((l) => sentLeadIds.has(l.id)).length, won: leads.filter((l) => l.status === "won").length },
      };
    }
    const sqlProjection = (d) => ({
      overdue: d.overdue_appointments.map((r) => r.id),
      awaiting: d.awaiting_confirmation.map((r) => r.id),
      hot: d.hot_leads.map((r) => r.id),
      highValue: d.high_value_leads.map((r) => r.id),
      pending: d.pending_estimate_leads.map((r) => r.id),
      dedup: d.uncontacted_dedup_lead_ids.slice().sort(),
      recentLeads: d.recent_leads.map((r) => r.id),
      recentAppointments: d.recent_appointments.map((r) => r.id),
      newLeads: Number(d.new_leads),
      openLeads: Number(d.open_leads),
      upcoming: Number(d.upcoming_appointments),
      pendingEstimates: Number(d.pending_estimates),
      // jsonb stores keys in its own order; compare in the TypeScript key order.
      pipeline: Object.fromEntries(["new", "contacted", "qualified", "appointment", "estimate", "won"].map((k) => [k, Number(d.pipeline[k])])),
    });
    const RULES = ["overdue", "awaiting", "hot", "highValue", "pending", "dedup", "recentLeads", "recentAppointments", "newLeads", "openLeads", "upcoming", "pendingEstimates", "pipeline"];
    const recordCore = (d) => ({ attentionItems: pickAttention(d.attentionItems), overview: d.overview, pipeline: d.pipeline, recentActivity: d.recentActivity, partialData: d.partialData, partialDataSourceCount: d.partialDataSourceCount });

    // 1. Normal orgs: the full Phase 2E Dashboard equals the frozen baseline
    //    exactly (reviewReferralOpportunities under its approved 2D contract).
    for (const key of ["E", "A", "B"]) {
      const org = orgs[key];
      const base = baseline.orgs[key];
      const sec = await rowsFor(() => sections(org, phase2e));
      const withoutRR = (x) => ({ ...x, dailyBriefing: { ...x.dailyBriefing, reviewReferralOpportunities: undefined } });
      check(`2E ${key}: attention/briefing/end-of-day/overview/pipeline/activity == frozen baseline (all fields except reviewReferralOpportunities)`, withoutRR(sec.result), withoutRR(base.sections));
      const full2e = recordCore(await dashboardQueries.getDashboardData(supabase, org, phase2e.dashboard));
      const full2d = recordCore(await dashboardQueries.getDashboardData(supabase, org, { conversationAttention: "sql" }));
      check(`2E ${key}: getDashboardData (record SQL) == Phase 2D getDashboardData, incl. pipeline`, full2e, full2d);
      console.log(`  2E ${key} cost: sections ${base.cost.sectionRequests} req/${base.cost.sectionRows} rows (pre-2D) -> ${sec.requests} req/${sec.rows} rows`);
    }

    // 2. Every rule at its boundaries (AT), ties (TIE), above every cap (BIGL),
    //    and the existing orgs - SQL vs the rules over complete data at a fixed now.
    for (const key of ["E", "A", "B", "BIG", "RR", "AT", "ATH", "ATV", "TIE", "BIGL"]) {
      const org = await orgId(key);
      const got = await sql.getDashboardRecordAttention(supabase, org, HV, NOW_MS);
      check(`2E ${key}: dashboard_record_attention succeeded`, got.failed, false);
      const ref = await refRecord(org, NOW_MS);
      const proj = sqlProjection(got.data);
      for (const rule of RULES) check(`2E ${key}: ${rule} == rule over complete data (ordering and selected records)`, proj[rule], ref[rule]);
    }

    // 3. AT is below every cap and tie-free, so the legacy loader is a valid
    //    oracle for the complete mapped output (titles, details, values, hrefs).
    for (const key of ["AT", "ATH", "ATV"]) {
      const org = await orgId(key);
      const legacy = recordCore(await dashboardQueries.getDashboardData(supabase, org, { conversationAttention: "sql" }));
      const next = recordCore(await dashboardQueries.getDashboardData(supabase, org, phase2e.dashboard));
      check(`2E ${key}: full getDashboardData output == legacy (every attention item field, overview, pipeline, activity)`, next, legacy);
      const kinds = (d) => Object.entries(d.attentionItems.reduce((m, i) => ({ ...m, [i.kind]: (m[i.kind] ?? 0) + 1 }), {})).map(([k, n]) => `${k}=${n}`).join(" ");
      console.log(`  2E ${key} attention covered: ${kinds(next)}`);
    }

    // 4. Above the caps: what the legacy capped reads surfaced vs 2E.
    {
      const big = await orgId("BIGL");
      const legacyRun = await rowsFor(() => dashboardQueries.getDashboardData(supabase, big, { conversationAttention: "sql" }));
      const nextRun = await rowsFor(() => dashboardQueries.getDashboardData(supabase, big, phase2e.dashboard));
      const summarize = (d) => ({ kinds: d.attentionItems.reduce((m, i) => ({ ...m, [i.kind]: (m[i.kind] ?? 0) + 1 }), {}), overview: d.overview, pipeline: d.pipeline, uncontactedShown: d.attentionItems.filter((i) => i.kind === "uncontacted_lead").map((i) => i.title) });
      console.log("  BIGL above the caps - legacy (capped) vs 2E (complete):");
      console.log("    legacy: " + JSON.stringify(summarize(legacyRun.result)));
      console.log("    2E:     " + JSON.stringify(summarize(nextRun.result)));
      console.log(`  BIGL cost: getDashboardData ${legacyRun.requests} req/${legacyRun.rows} rows -> ${nextRun.requests} req/${nextRun.rows} rows`);
      const tie = await orgId("TIE");
      const legacyTie = await dashboardQueries.getDashboardData(supabase, tie, { conversationAttention: "sql" });
      const nextTie = await dashboardQueries.getDashboardData(supabase, tie, phase2e.dashboard);
      console.log(`  TIE hot leads  legacy (created_at DESC only): ${legacyTie.attentionItems.filter((i) => i.kind === "hot_lead").map((i) => i.title).join(", ")}`);
      console.log(`  TIE hot leads  2E (created_at DESC, id ASC):  ${nextTie.attentionItems.filter((i) => i.kind === "hot_lead").map((i) => i.title).join(", ")}`);
    }

    // 5. A failed record read is disclosed as the three reads it replaces were.
    {
      const failing = await dashboardQueries.getDashboardData(createClient("http://127.0.0.1:1", "x", { auth: { persistSession: false } }), orgs.A, phase2e.dashboard);
      check("2E: failed record read -> partialData true, empty record items, count covers leads+appointments+estimates", { partial: failing.partialData, atLeast3: failing.partialDataSourceCount >= 3, overview: failing.overview, recordKinds: failing.attentionItems.filter((i) => ["overdue_appointment", "awaiting_confirmation", "hot_lead", "high_value_lead", "pending_estimate"].includes(i.kind)).length }, { partial: true, atLeast3: true, overview: { newLeads: 0, upcomingAppointments: 0, pendingEstimates: 0, openOpportunities: 0 }, recordKinds: 0 });
    }
  }

  // ---- Phase 3 (W1): waiting rule - inbound + successful outbound evidence only ----
  {
    const WR = "md5('org-WR')::uuid";
    await db.exec(`
      set session_replication_role = replica;
      insert into public.organizations (id, name, timezone, payment_status) values (${WR}, 'Org Waiting rule', 'UTC', 'active');
      insert into public.conversations (id, organization_id, contact_id, lead_id, channel, status, ai_enabled, created_at, updated_at) values
        (${id("WR-cv1")}, ${WR}, null, null, 'sms', 'open', true, ${T("2026-10-01T00:00:00Z")}, ${T("2026-10-01T00:00:00Z")}),
        (${id("WR-cv2")}, ${WR}, null, null, 'sms', 'open', true, ${T("2026-10-01T00:00:00Z")}, ${T("2026-10-01T00:00:00Z")}),
        (${id("WR-cv3")}, ${WR}, null, null, 'sms', 'open', true, ${T("2026-10-01T00:00:00Z")}, ${T("2026-10-01T00:00:00Z")}),
        (${id("WR-cv4")}, ${WR}, null, null, 'sms', 'open', true, ${T("2026-10-01T00:00:00Z")}, ${T("2026-10-01T00:00:00Z")}),
        (${id("WR-cv5")}, ${WR}, null, null, 'sms', 'open', true, ${T("2026-10-01T00:00:00Z")}, ${T("2026-10-01T00:00:00Z")}),
        (${id("WR-cv6")}, ${WR}, null, null, 'sms', 'open', true, ${T("2026-10-01T00:00:00Z")}, ${T("2026-10-01T00:00:00Z")}),
        (${id("WR-cv7")}, ${WR}, null, null, 'sms', 'open', true, ${T("2026-10-01T00:00:00Z")}, ${T("2026-10-01T00:00:00Z")});
      insert into public.messages (id, organization_id, conversation_id, direction, sender_type, body, status, created_at) values
        (${id("WR-m1a")}, ${WR}, ${id("WR-cv1")}, 'inbound', 'customer', 'x', 'received', ${T("2026-10-12T10:00:00Z")}),
        (${id("WR-m1b")}, ${WR}, ${id("WR-cv1")}, 'outbound', 'ai', 'x', 'failed', ${T("2026-10-12T11:00:00Z")}),
        (${id("WR-m2a")}, ${WR}, ${id("WR-cv2")}, 'inbound', 'customer', 'x', 'received', ${T("2026-10-15T10:00:00Z")}),
        (${id("WR-m2b")}, ${WR}, ${id("WR-cv2")}, 'outbound', 'user', 'note', 'logged', ${T("2026-10-15T11:00:00Z")}),
        (${id("WR-m3a")}, ${WR}, ${id("WR-cv3")}, 'inbound', 'customer', 'x', 'received', ${T("2026-10-15T09:00:00Z")}),
        (${id("WR-m3b")}, ${WR}, ${id("WR-cv3")}, 'outbound', 'ai', 'x', 'queued', ${T("2026-10-15T09:05:00Z")}),
        (${id("WR-m4a")}, ${WR}, ${id("WR-cv4")}, 'inbound', 'customer', 'x', 'received', ${T("2026-10-15T08:00:00Z")}),
        (${id("WR-m4b")}, ${WR}, ${id("WR-cv4")}, 'outbound', 'ai', 'x', 'undelivered', ${T("2026-10-15T08:05:00Z")}),
        (${id("WR-m5a")}, ${WR}, ${id("WR-cv5")}, 'inbound', 'customer', 'x', 'received', ${T("2026-10-10T08:00:00Z")}),
        (${id("WR-m5b")}, ${WR}, ${id("WR-cv5")}, 'outbound', 'ai', 'x', 'delivered', ${T("2026-10-11T08:00:00Z")}),
        (${id("WR-m5c")}, ${WR}, ${id("WR-cv5")}, 'outbound', 'ai', 'x', 'failed', ${T("2026-10-12T08:00:00Z")}),
        (${id("WR-m6a")}, ${WR}, ${id("WR-cv6")}, 'outbound', 'ai', 'x', 'failed', ${T("2026-10-10T08:00:00Z")}),
        (${id("WR-m7a")}, ${WR}, ${id("WR-cv7")}, 'inbound', 'customer', 'x', 'received', ${T("2026-10-15T12:00:00Z")}),
        (${id("WR-m7b")}, ${WR}, ${id("WR-cv7")}, 'outbound', 'user', 'x', 'delivered', ${T("2026-10-15T13:00:00Z")});
      set session_replication_role = origin;
    `);
    const wr = (await db.query(`select ${WR}::text as v`)).rows[0].v;
    const names = new Map();
    for (const n of [1, 2, 3, 4, 5, 6, 7]) names.set((await db.query(`select ${id(`WR-cv${n}`)}::text as v`)).rows[0].v, `cv${n}`);
    const label = (items) => items.map((i) => names.get(i.id.replace(/^(reply|abandoned)-/, "")) ?? i.id);
    const EXPECTED = { awaiting: ["cv2", "cv3", "cv4", "cv1"], abandoned: ["cv5"] };
    const viaSql = await sql.getDashboardConversationAttention(supabase, wr, NOW_MS);
    check("W1 SQL: failed / logged / queued / undelivered after the customer are waiting; answered-then-failed is went quiet; failed-only and answered are neither", { awaiting: label(viaSql.awaitingReply), abandoned: label(viaSql.abandonedConversations) }, EXPECTED);
    // The legacy app path reads one-to-many embeds (conversations -> messages) this emulator cannot serve;
    // its parity with the SQL is checked against real PostgREST on TEST (lib/dashboard/queries.waiting-rule.integration.test.ts).

    // Rollback restores the previous definition exactly (newest message of any status decides), then re-apply.
    await db.exec(readFileSync(path.join(ROOT, "supabase/pending/dashboard_conversation_attention_successful_reply_rollback.sql"), "utf8"));
    const rolledBack = await sql.getDashboardConversationAttention(supabase, wr, NOW_MS);
    check("W1 rollback: the previous rule (any-status last message) is back", { awaiting: label(rolledBack.awaitingReply), abandoned: label(rolledBack.abandonedConversations).sort() }, { awaiting: [], abandoned: ["cv1", "cv5", "cv6"] });
    await db.exec(readFileSync(path.join(ROOT, "supabase/migrations/20261004110145_dashboard_conversation_attention_successful_reply.sql"), "utf8"));
    const reapplied = await sql.getDashboardConversationAttention(supabase, wr, NOW_MS);
    check("W1 re-apply after rollback: idempotent", { awaiting: label(reapplied.awaitingReply), abandoned: label(reapplied.abandonedConversations) }, EXPECTED);
  }

  // ---- Organization isolation, grants and RLS (as the real roles) ----
  const u = { A: "md5('user-A')::uuid", B: "md5('user-B')::uuid" };
  await db.exec(`
    set session_replication_role = replica;
    insert into auth.users (id, email) values (${u.A}, 'a@example.com'), (${u.B}, 'b@example.com');
    insert into public.organization_members (organization_id, user_id, role) values (${ORG.A}, ${u.A}, 'owner'), (${ORG.B}, ${u.B}, 'owner');
    set session_replication_role = origin;
    -- Supabase's platform-level defaults (not part of the migrations): the API
    -- roles hold table privileges and RLS decides which rows they see.
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
  const args = `(${ORG.A}, now() - interval '1 day', now() + interval '1 day', '2026-09-28T16:25:00Z')`;
  const mine = await asRole("authenticated", u.A, `select public.dashboard_summary${args} as s`);
  const theirs = await asRole("authenticated", u.B, `select public.dashboard_summary${args} as s`);
  check("isolation: org A's member sees org A's pipeline", Number(mine.rows[0].s.pipeline_value) > 0, true);
  check("isolation: org B's member asking for org A gets nothing of A (RLS)", { pipeline: Number(theirs.rows[0].s.pipeline_value), invoiced: Number(theirs.rows[0].s.invoiced), hot: Number(theirs.rows[0].s.hot_lead_count) }, { pipeline: 0, invoiced: 0, hot: 0 });
  const theirsAttention = await asRole("authenticated", u.B, `select count(*)::int n from public.dashboard_conversation_attention(${ORG.A}, now())`);
  check("isolation: org B's member gets no org A conversation attention", theirsAttention.rows[0].n, 0);
  const theirsBriefing = await asRole("authenticated", u.B, `select public.dashboard_briefing(${ORG.A}, now() - interval '30 days', now() + interval '1 day', now() - interval '7 days') as b`);
  check("isolation: org B's member gets no org A briefing rows", { appts: theirsBriefing.rows[0].b.appointments_today.length, est: theirsBriefing.rows[0].b.estimates_awaiting.length, booked: Number(theirsBriefing.rows[0].b.appointments_booked_today) }, { appts: 0, est: 0, booked: 0 });
  const recordArgs = `(${ORG.A}, now(), 5000)`;
  const recordSummary = (r) => ({ hot: r.hot_leads.length, overdue: r.overdue_appointments.length, recent: r.recent_leads.length + r.recent_appointments.length, newLeads: Number(r.new_leads), pendingEstimates: Number(r.pending_estimates), pipelineNew: Number(r.pipeline.new) });
  const mineRecord = await asRole("authenticated", u.A, `select public.dashboard_record_attention${recordArgs} as r`);
  const theirsRecord = await asRole("authenticated", u.B, `select public.dashboard_record_attention${recordArgs} as r`);
  check("2E isolation: org A's member sees org A's record attention", recordSummary(mineRecord.rows[0].r).hot > 0 && recordSummary(mineRecord.rows[0].r).recent > 0, true);
  check("2E isolation: org B's member asking for org A gets nothing of A (RLS)", recordSummary(theirsRecord.rows[0].r), { hot: 0, overdue: 0, recent: 0, newLeads: 0, pendingEstimates: 0, pipelineNew: 0 });
  let anonRecordDenied = false;
  try {
    await asRole("anon", null, `select public.dashboard_record_attention${recordArgs}`);
  } catch (error) {
    anonRecordDenied = /permission denied/i.test(String(error.message));
  }
  check("2E grants: anon cannot execute dashboard_record_attention", anonRecordDenied, true);
  let anonDenied = false;
  try {
    await asRole("anon", null, `select public.dashboard_summary${args}`);
  } catch (error) {
    anonDenied = /permission denied/i.test(String(error.message));
  }
  check("grants: anon cannot execute dashboard_summary", anonDenied, true);
  await db.exec(`set session_replication_role = replica; update public.organizations set payment_status = 'suspended' where id = ${ORG.A}; set session_replication_role = origin;`);
  const gated = await asRole("authenticated", u.A, `select public.dashboard_summary${args} as s`);
  const gatedRecord = await asRole("authenticated", u.A, `select public.dashboard_record_attention${recordArgs} as r`);
  await db.exec(`set session_replication_role = replica; update public.organizations set payment_status = 'active' where id = ${ORG.A}; set session_replication_role = origin;`);
  check("2E payment gate: a suspended organization's member sees no record attention", recordSummary(gatedRecord.rows[0].r), { hot: 0, overdue: 0, recent: 0, newLeads: 0, pendingEstimates: 0, pipelineNew: 0 });
  check("payment gate: a suspended organization's member sees no gated data through the function", { pipeline: Number(gated.rows[0].s.pipeline_value), hot: Number(gated.rows[0].s.hot_lead_count) }, { pipeline: 0, hot: 0 });
  const defs = await db.query(`select proname, prosecdef, provolatile, proconfig from pg_proc where proname in ('dashboard_summary', 'dashboard_conversation_attention', 'dashboard_briefing', 'dashboard_record_attention') order by 1`);
  check("functions: all SECURITY INVOKER, STABLE, fixed search_path", defs.rows.map((r) => [r.proname, r.prosecdef, r.provolatile, r.proconfig]), [
    ["dashboard_briefing", false, "s", ["search_path=public"]],
    ["dashboard_conversation_attention", false, "s", ["search_path=public"]],
    ["dashboard_record_attention", false, "s", ["search_path=public"]],
    ["dashboard_summary", false, "s", ["search_path=public"]],
  ]);

  // ---- Query plans (PGlite, seeded data; production statistics will differ) ----
  if (process.env.EXPLAIN) {
    // A SQL function called as `select f(...)` shows only a Result node, so explain each
    // function BODY with its parameters bound as literals - the statement the planner runs.
    await db.exec("analyze");
    const bind = {
      dashboard_summary: { p_organization_id: `${ORG.BIG}`, p_day_start: "'2026-10-15T00:00:00Z'::timestamptz", p_day_end: "'2026-10-16T00:00:00Z'::timestamptz", p_invoicing_live_at: "'2026-09-28T16:25:00Z'::timestamptz" },
      dashboard_conversation_attention: { p_organization_id: `${ORG.BIG}`, p_now: `'${NOW_ISO}'::timestamptz` },
      dashboard_briefing: { p_organization_id: `${ORG.BIG}`, p_day_start: "'2026-10-15T00:00:00Z'::timestamptz", p_day_end: "'2026-10-16T00:00:00Z'::timestamptz", p_seven_days_ago: "'2026-10-08T15:30:00Z'::timestamptz" },
      dashboard_record_attention: { p_organization_id: `${ORG.BIGL}`, p_now: `'${NOW_ISO}'::timestamptz`, p_high_value_threshold: "5000::numeric" },
    };
    const counts = await db.query(`select relname, n_live_tup from pg_stat_user_tables where relname in ('leads','appointments','estimates','jobs','invoices','customer_payments','conversations','messages','review_requests','referral_requests','contacts') order by 1`);
    console.log("\nrow counts (all orgs): " + counts.rows.map((r) => `${r.relname}=${r.n_live_tup}`).join(" "));
    for (const [fn, params] of Object.entries(bind)) {
      const src = (await db.query(`select prosrc from pg_proc where proname = $1`, [fn])).rows[0].prosrc;
      let body = src.trim().replace(/;\s*$/, "");
      for (const [name, lit] of Object.entries(params)) body = body.replace(new RegExp(`\\b${name}\\b`, "g"), lit);
      for (const mode of ["default", "enable_seqscan=off"]) {
        if (mode !== "default") await db.exec(`set ${mode}`);
        const plan = await db.query(`explain (analyze, costs true, timing true, buffers false) ${body}`);
        if (mode !== "default") await db.exec(`reset enable_seqscan`);
        const text = plan.rows.map((r) => Object.values(r)[0]).join("\n");
        writeFileSync(`${process.env.EXPLAIN}/explain-${fn}-${mode.replace(/=.*/, "")}.txt`, text + "\n");
        const seq = [...text.matchAll(/Seq Scan on (\w+)/g)].map((m) => m[1]);
        const exec = text.match(/Execution Time: ([\d.]+) ms/)?.[1];
        console.log(`EXPLAIN ${fn} [${mode}]: execution ${exec} ms; seq scans: ${[...new Set(seq)].join(", ") || "none"}`);
      }
    }
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${passes} passed, ${failures} failed (TZ=${TZ})`);
  if (failures) process.exitCode = 1;
}
await pg.close();

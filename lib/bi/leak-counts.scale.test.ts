/**
 * Phase 2G: the leak counts behind Analytics' "Pipeline & follow-up leaks" -
 * Qualified, no appointment; Visits, no estimate; recoverable / declined
 * estimate value and estimate aging - read through the snapshot against a
 * fake Supabase client: every read paged through readAllPages, no lead id
 * list, definitions unchanged, and a failed or over-limit read reported as
 * unavailable rather than as 0 / $0 / an inflated count - with partialData
 * and the AI input shape left as they were. The same cases run at real
 * volume against TEST in leak-counts.scale.integration.test.ts.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/bi/leak-counts.scale.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const { getBusinessMetricsSnapshot }: typeof import("./metrics") = require(path.join(ROOT, "lib/bi/metrics.ts"));
const { buildAiInsightsInput }: typeof import("./insights") = require(path.join(ROOT, "lib/bi/insights.ts"));
const { MAX_ATTRIBUTION_ROWS }: typeof import("./revenue-attribution") = require(path.join(ROOT, "lib/bi/revenue-attribution.ts"));

type Query = { table: string; calls: string[] };
type Answer = { rows?: unknown[]; error?: boolean; failOnPage?: number };

/** The Phase 2F fake client: every builder call recorded and chainable; paged reads resolve through range(), others when awaited. */
function fakeSupabase(answer: (query: Query) => Answer = () => ({})) {
  const queries: Query[] = [];
  const supabase = {
    from(table: string) {
      const query: Query = { table, calls: [] };
      queries.push(query);
      const resolve = (from?: number, to?: number) => {
        const result = answer(query);
        const page = from === undefined ? 1 : from / 1000 + 1;
        if (result.error || result.failOnPage === page) return Promise.resolve({ data: null, error: { message: "boom" }, count: null });
        const rows = result.rows ?? [];
        return Promise.resolve({ data: from === undefined ? rows : rows.slice(from, to! + 1), error: null, count: rows.length });
      };
      const builder: object = new Proxy(
        {},
        {
          get(_target, prop: string) {
            if (prop === "then") return (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => resolve().then(onFulfilled, onRejected);
            if (prop === "range") return (from: number, to: number) => (query.calls.push(`range ${from} ${to}`), resolve(from, to));
            if (prop === "single" || prop === "maybeSingle") return () => resolve().then((r) => ({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data }));
            return (...args: unknown[]) => (query.calls.push(`${prop} ${args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")}`), builder);
          },
        },
      );
      return builder;
    },
  } as unknown as SupabaseClient;
  return { supabase, queries };
}

const has = (q: Query, prefix: string) => q.calls.some((call) => call.startsWith(prefix));
// The Phase 2G reads, told apart by table and selected columns. Phase 2-8
// (M6, M9): "Qualified, no appointment" and "Visits, no estimate" count
// the organization's stored OPEN opportunity rows of the matching type -
// the same rows Today shows - so the two numbers match Today by construction.
const isOpenOpportunitiesRead = (type: string) => (q: Query) => q.table === "opportunities" && q.calls.includes("select id") && q.calls.includes(`eq type ${type}`) && q.calls.includes("eq status open");
const isQualifiedOpenRead = isOpenOpportunitiesRead("qualified_lead_unbooked");
const isVisitsOpenRead = isOpenOpportunitiesRead("completed_appointment_no_estimate");
const isBookingLeadsRead = (q: Query) => q.table === "leads" && has(q, "select id, status") && !has(q, "eq status qualified");
const isBookedAppointmentsRead = (q: Query) => q.table === "appointments" && has(q, "select lead_id, lead:leads!appointments_lead_id_fkey!inner(id)");
const isEstimateValuesRead = (q: Query) => q.table === "estimates" && has(q, "select status, amount, sent_at, expires_at");
const LEAK_READS = [isQualifiedOpenRead, isVisitsOpenRead, isBookingLeadsRead, isBookedAppointmentsRead, isEstimateValuesRead];
const rows = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}` }));

const NOW = new Date("2026-09-25T12:00:00Z");
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const snapshotWith = (answer: (q: Query) => Answer) => {
  const fake = fakeSupabase(answer);
  return { fake, snapshot: getBusinessMetricsSnapshot(fake.supabase, "org-1", "last30Days", { now: NOW }) };
};
const pagesOf = (queries: Query[], match: (q: Query) => boolean) => queries.filter(match).flatMap((q) => q.calls.filter((c) => c.startsWith("range")));

// ---------------------------------------------------------------------------
// Qualified, no appointment
// ---------------------------------------------------------------------------

// Phase 2-8 (M9): these used to rebuild the condition from leads and appointments (and, before M6, counted a
// cancelled or no-show appointment as booked). Insights now counts Today's own open rows.
test("qualified, no appointment (Phase 2-8): the count of open qualified_lead_unbooked rows, read across pages - exactly Today's items", async () => {
  const { fake, snapshot } = snapshotWith((q) => (isQualifiedOpenRead(q) ? { rows: rows(1200, "opp") } : {}));
  const s = await snapshot;
  assert.equal(s.revenueOpportunity.qualifiedLeadsWithoutAppointment, 1200);
  assert.equal(s.revenueOpportunityUnavailable.qualifiedNoAppointment, false);
  assert.deepEqual(pagesOf(fake.queries, isQualifiedOpenRead), ["range 0 999", "range 1000 1999"]);
  const [read] = fake.queries.filter(isQualifiedOpenRead);
  assert.deepEqual(read.calls.filter((c) => !c.startsWith("range")), ["select id", "eq organization_id org-1", "eq type qualified_lead_unbooked", "eq status open", "order id"]);
});

test("booking rate (AI input): same definition across pages; a failed read is null - never 0% - and partialData is unchanged", async () => {
  const leads = Array.from({ length: 1500 }, (_, i) => ({ id: `lead-${i}`, status: "new" }));
  const booked = Array.from({ length: 600 }, (_, i) => ({ lead_id: `lead-${i * 2}` }));
  const ok = await snapshotWith((q) => (isBookingLeadsRead(q) ? { rows: leads } : isBookedAppointmentsRead(q) ? { rows: booked } : {})).snapshot;
  assert.equal(ok.leadMetrics.leadToBookingRate, 40);
  for (const failing of [isBookingLeadsRead, (q: Query) => isBookedAppointmentsRead(q)]) {
    const s = await snapshotWith((q) => (failing(q) ? { failOnPage: 2, rows: leads } : isBookingLeadsRead(q) ? { rows: leads } : {})).snapshot;
    assert.equal(s.leadMetrics.leadToBookingRate, null);
    assert.equal(buildAiInsightsInput(s).leadMetrics.leadToBookingRate, null);
    assert.equal(s.partialData, false);
  }
});

// ---------------------------------------------------------------------------
// Visits, no estimate
// ---------------------------------------------------------------------------

test("visits, no estimate (Phase 2-8): the count of open completed_appointment_no_estimate rows, read across pages - exactly Today's items", async () => {
  const { fake, snapshot } = snapshotWith((q) => (isVisitsOpenRead(q) ? { rows: rows(1150, "opp") } : {}));
  const s = await snapshot;
  assert.equal(s.revenueOpportunity.completedAppointmentsWithoutEstimate, 1150);
  assert.equal(s.revenueOpportunityUnavailable.visitsNoEstimate, false);
  assert.deepEqual(pagesOf(fake.queries, isVisitsOpenRead), ["range 0 999", "range 1000 1999"]);
  const [read] = fake.queries.filter(isVisitsOpenRead);
  assert.deepEqual(read.calls.filter((c) => !c.startsWith("range")), ["select id", "eq organization_id org-1", "eq type completed_appointment_no_estimate", "eq status open", "order id"]);
});

test("visits / qualified (Phase 2-8): both figures are only a count of Today's open rows - never rebuilt from leads, appointments, estimates or jobs", () => {
  const source = fs.readFileSync(path.join(ROOT, "lib/bi/metrics.ts"), "utf8");
  for (const fn of ["getCompletedAppointmentsWithoutEstimate", "getQualifiedLeadsWithoutAppointment"]) {
    const start = source.indexOf(`async function ${fn}(`);
    const body = source.slice(start, source.indexOf("\n}\n", start));
    assert.match(body, /return countOpenOpportunities\(supabase, organizationId, "(completed_appointment_no_estimate|qualified_lead_unbooked)"\);/, fn);
  }
});

// ---------------------------------------------------------------------------
// Estimate values and aging
// ---------------------------------------------------------------------------

test("estimates: 1,500 sent/expired/declined estimates across pages - exact recoverable and declined value, complete aging and past-expiry", async () => {
  // 600 sent (200 aged 0-7 days, 200 aged 8-30, 200 aged 31+; every third past expiry), 500 expired, 400 declined.
  const rows = [
    ...Array.from({ length: 600 }, (_, i) => ({ status: "sent", amount: 100, sent_at: daysAgo(i < 200 ? 3 : i < 400 ? 15 : 45), expires_at: i % 3 === 0 ? daysAgo(1) : daysAgo(-10) })),
    ...Array.from({ length: 500 }, () => ({ status: "expired", amount: 50, sent_at: daysAgo(60), expires_at: daysAgo(30) })),
    ...Array.from({ length: 400 }, () => ({ status: "declined", amount: 25.5, sent_at: daysAgo(20), expires_at: null })),
  ];
  const { fake, snapshot } = snapshotWith((q) => (isEstimateValuesRead(q) ? { rows } : {}));
  const s = await snapshot;
  assert.deepEqual(pagesOf(fake.queries, isEstimateValuesRead), ["range 0 999", "range 1000 1999"]);
  const { revenueOpportunity: o, estimateAging: aging } = s;
  assert.deepEqual([o.openEstimateValue, o.expiredEstimateValue, o.lostEstimateValue, o.recoverableEstimateValue], [60_000, 25_000, 10_200, 85_000]);
  assert.deepEqual(aging.buckets.map((b) => [b.key, b.count, b.value]), [["0-7", 200, 20_000], ["8-30", 200, 20_000], ["31+", 200, 20_000], ["undated", 0, 0]]);
  assert.deepEqual([aging.pastExpiryCount, aging.pastExpiryValue], [200, 20_000]);
  assert.equal(s.revenueOpportunityUnavailable.estimates, false);
  // The status filter is a fixed three-value list, never an id list.
  assert.ok(fake.queries.filter(isEstimateValuesRead).every((q) => q.calls.includes('in status ["sent","expired","declined"]') && q.calls.includes("order id")));
});

// ---------------------------------------------------------------------------
// Failures: each group unavailable on its own, never 0 / $0 / inflated
// ---------------------------------------------------------------------------

const many = (n: number, make: (i: number) => unknown) => Array.from({ length: n }, (_, i) => make(i));
const FAILURES: { group: "qualifiedNoAppointment" | "visitsNoEstimate" | "estimates"; reads: ((q: Query) => boolean)[] }[] = [
  { group: "qualifiedNoAppointment", reads: [isQualifiedOpenRead] },
  { group: "visitsNoEstimate", reads: [isVisitsOpenRead] },
  { group: "estimates", reads: [isEstimateValuesRead] },
];

test("each read failing on page 2, or reaching the row limit, makes only its own group unavailable - unrelated groups keep their figures; partialData unchanged", async () => {
  const data = (q: Query): Answer =>
    isQualifiedOpenRead(q) ? { rows: rows(1050, "q") }
    : isVisitsOpenRead(q) ? { rows: rows(1020, "v") }
    : isEstimateValuesRead(q) ? { rows: many(1100, () => ({ status: "sent", amount: 10, sent_at: daysAgo(2), expires_at: null })) }
    : {};
  const baseline = await snapshotWith(data).snapshot;
  assert.deepEqual(baseline.revenueOpportunityUnavailable, { qualifiedNoAppointment: false, visitsNoEstimate: false, estimates: false });
  assert.deepEqual([baseline.revenueOpportunity.qualifiedLeadsWithoutAppointment, baseline.revenueOpportunity.completedAppointmentsWithoutEstimate, baseline.revenueOpportunity.recoverableEstimateValue], [1050, 1020, 11_000]);

  for (const { group, reads } of FAILURES) {
    for (const read of reads) {
      for (const failure of [{ failOnPage: 2 }, { rows: many(MAX_ATTRIBUTION_ROWS + 1, () => ({ id: "x", status: "qualified", lead_id: "x", amount: 1 })) }]) {
        const s = await snapshotWith((q) => (read(q) ? { ...data(q), ...failure } : data(q))).snapshot;
        const flags = s.revenueOpportunityUnavailable;
        assert.equal(flags[group], true, `${group} via ${read.name}`);
        for (const other of FAILURES.filter((f) => f.group !== group)) assert.equal(flags[other.group], false, `${other.group} unaffected`);
        assert.equal(s.partialData, false, "leak reads never feed partialData");
        if (group !== "estimates") assert.equal(s.revenueOpportunity.recoverableEstimateValue, 11_000, "unrelated figures stand");
      }
    }
  }
});

test("a failed estimates read is unavailable - zeroed placeholders with empty aging, never presented as $0 data", async () => {
  const s = await snapshotWith((q) => (isEstimateValuesRead(q) ? { error: true } : {})).snapshot;
  assert.equal(s.revenueOpportunityUnavailable.estimates, true);
  assert.deepEqual([s.revenueOpportunity.recoverableEstimateValue, s.estimateAging.pastExpiryCount], [0, 0]);
});

test("no affected read sends a lead id list or a fixed .limit(); the AI input field set and partialData inputs are unchanged", async () => {
  const { fake, snapshot } = snapshotWith((q) =>
    isVisitsOpenRead(q) || isQualifiedOpenRead(q) ? { rows: rows(1, "o") } : isBookingLeadsRead(q) ? { rows: [{ id: "a", status: "qualified" }] } : {},
  );
  const s = await snapshot;
  const leakQueries = fake.queries.filter((q) => LEAK_READS.some((match) => match(q)));
  assert.ok(leakQueries.length >= 5);
  for (const q of leakQueries) {
    assert.ok(!q.calls.some((c) => /^in (lead_id|id|contact_id) /.test(c)), `${q.table}: ${q.calls.join(" / ")}`);
    assert.ok(!q.calls.some((c) => c.startsWith("limit ")), `${q.table} uses paging, not a cap`);
    assert.ok(q.calls.includes("order id") && q.calls.some((c) => c.startsWith("range ")), `${q.table} paged by readAllPages`);
  }
  assert.deepEqual(Object.keys(buildAiInsightsInput(s)).sort(), ["aiMetrics", "appointmentMetrics", "automationMetrics", "billingMetrics", "communicationMetrics", "comparisons", "dataQuality", "estimateMetrics", "followUpMetrics", "jobMetrics", "leadMetrics", "period", "pipelineMetrics"]);
  assert.ok(!("revenueOpportunityUnavailable" in buildAiInsightsInput(s)));
});

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
// The five Phase 2G reads, told apart by table and selected columns.
const isQualifiedLeadsRead = (q: Query) => q.table === "leads" && has(q, "select id, status") && has(q, "eq status qualified");
const isBookingLeadsRead = (q: Query) => q.table === "leads" && has(q, "select id, status") && !has(q, "eq status qualified");
const isBookedAppointmentsRead = (q: Query) => q.table === "appointments" && has(q, "select lead_id, lead:leads!appointments_lead_id_fkey!inner(id)");
const isQualifiedBookedRead = (q: Query) => isBookedAppointmentsRead(q) && has(q, "eq lead.status qualified");
const isVisitsRead = (q: Query) => q.table === "appointments" && q.calls.includes("select lead_id") && has(q, "eq status completed");
const isEstimateLeadsRead = (q: Query) => q.table === "estimates" && q.calls.includes("select lead_id");
const isEstimateValuesRead = (q: Query) => q.table === "estimates" && has(q, "select status, amount, sent_at, expires_at");
const LEAK_READS = [isQualifiedLeadsRead, isBookingLeadsRead, isBookedAppointmentsRead, isVisitsRead, isEstimateLeadsRead, isEstimateValuesRead];

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

test("qualified, no appointment: 1,200 qualified leads and their bookings read across pages - booked leads excluded, unbooked counted", async () => {
  const leads = Array.from({ length: 1200 }, (_, i) => ({ id: `lead-${i}`, status: "qualified" }));
  // Leads 0-1,099 are booked - several of them twice; bookings for 1,000+ sit past the first page.
  const bookings = [...Array.from({ length: 1100 }, (_, i) => ({ lead_id: `lead-${i}` })), ...Array.from({ length: 300 }, (_, i) => ({ lead_id: `lead-${i}` }))];
  const { fake, snapshot } = snapshotWith((q) => (isQualifiedLeadsRead(q) ? { rows: leads } : isQualifiedBookedRead(q) ? { rows: bookings } : {}));
  const s = await snapshot;
  assert.equal(s.revenueOpportunity.qualifiedLeadsWithoutAppointment, 100);
  assert.equal(s.revenueOpportunityUnavailable.qualifiedNoAppointment, false);
  assert.deepEqual(pagesOf(fake.queries, isQualifiedLeadsRead), ["range 0 999", "range 1000 1999"]);
  assert.deepEqual(pagesOf(fake.queries, isQualifiedBookedRead), ["range 0 999", "range 1000 1999"]);
});

test("qualified, no appointment: the booking read is joined to the qualified leads - no lead id list, no appointment-status filter (a cancelled or no-show appointment still counts as booked)", async () => {
  const { fake, snapshot } = snapshotWith((q) => (isQualifiedLeadsRead(q) ? { rows: [{ id: "a", status: "qualified" }, { id: "b", status: "qualified" }] } : isQualifiedBookedRead(q) ? { rows: [{ lead_id: "a" }] } : {}));
  assert.equal((await snapshot).revenueOpportunity.qualifiedLeadsWithoutAppointment, 1);
  const [booked] = fake.queries.filter(isQualifiedBookedRead);
  assert.deepEqual(booked.calls.filter((c) => !c.startsWith("range")), [
    "select lead_id, lead:leads!appointments_lead_id_fkey!inner(id)",
    "eq organization_id org-1",
    "eq lead.organization_id org-1",
    "eq lead.status qualified",
    "order id",
  ]);
});

test("booking rate (AI input): same definition across pages; a failed read is null - never 0% - and partialData is unchanged", async () => {
  const leads = Array.from({ length: 1500 }, (_, i) => ({ id: `lead-${i}`, status: "new" }));
  const booked = Array.from({ length: 600 }, (_, i) => ({ lead_id: `lead-${i * 2}` }));
  const ok = await snapshotWith((q) => (isBookingLeadsRead(q) ? { rows: leads } : isBookedAppointmentsRead(q) && !isQualifiedBookedRead(q) ? { rows: booked } : {})).snapshot;
  assert.equal(ok.leadMetrics.leadToBookingRate, 40);
  for (const failing of [isBookingLeadsRead, (q: Query) => isBookedAppointmentsRead(q) && !isQualifiedBookedRead(q)]) {
    const s = await snapshotWith((q) => (failing(q) ? { failOnPage: 2, rows: leads } : isBookingLeadsRead(q) ? { rows: leads } : {})).snapshot;
    assert.equal(s.leadMetrics.leadToBookingRate, null);
    assert.equal(buildAiInsightsInput(s).leadMetrics.leadToBookingRate, null);
    assert.equal(s.partialData, false);
  }
});

// ---------------------------------------------------------------------------
// Visits, no estimate
// ---------------------------------------------------------------------------

test("visits, no estimate: 450 leads (past the old ~400-id failure), 1,200 visit rows and 1,500 estimate rows - exactly the 150 leads without an estimate, each once", async () => {
  // Every lead has 2-3 completed visits; leads 0-299 have 5 estimates each.
  const visits = Array.from({ length: 1200 }, (_, i) => ({ lead_id: `lead-${i % 450}` }));
  const estimates = Array.from({ length: 1500 }, (_, i) => ({ lead_id: `lead-${i % 300}` }));
  const { fake, snapshot } = snapshotWith((q) => (isVisitsRead(q) ? { rows: visits } : isEstimateLeadsRead(q) ? { rows: estimates } : {}));
  const s = await snapshot;
  assert.equal(s.revenueOpportunity.completedAppointmentsWithoutEstimate, 150);
  assert.equal(s.revenueOpportunityUnavailable.visitsNoEstimate, false);
  assert.deepEqual(pagesOf(fake.queries, isVisitsRead), ["range 0 999", "range 1000 1999"]);
  assert.deepEqual(pagesOf(fake.queries, isEstimateLeadsRead), ["range 0 999", "range 1000 1999"]);
  assert.ok(!fake.queries.filter(isEstimateLeadsRead).some((q) => has(q, "in lead_id")), "no lead id list");
});

test("visits, no estimate: a visit with an estimate is excluded, one without is counted, a lead's several visits count once", async () => {
  const visits = [{ lead_id: "with" }, { lead_id: "without" }, { lead_id: "without" }, { lead_id: "without" }];
  const s = await snapshotWith((q) => (isVisitsRead(q) ? { rows: visits } : isEstimateLeadsRead(q) ? { rows: [{ lead_id: "with" }, { lead_id: "with" }, { lead_id: "unrelated" }] } : {})).snapshot;
  assert.equal(s.revenueOpportunity.completedAppointmentsWithoutEstimate, 1);
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
  { group: "qualifiedNoAppointment", reads: [isQualifiedLeadsRead, isQualifiedBookedRead] },
  { group: "visitsNoEstimate", reads: [isVisitsRead, isEstimateLeadsRead] },
  { group: "estimates", reads: [isEstimateValuesRead] },
];

test("each read failing on page 2, or reaching the row limit, makes only its own group unavailable - unrelated groups keep their figures; partialData unchanged", async () => {
  const data = (q: Query): Answer =>
    isQualifiedLeadsRead(q) ? { rows: many(1100, (i) => ({ id: `q-${i}`, status: "qualified" })) }
    : isQualifiedBookedRead(q) ? { rows: many(1050, (i) => ({ lead_id: `q-${i}` })) }
    : isVisitsRead(q) ? { rows: many(1100, (i) => ({ lead_id: `v-${i}` })) }
    : isEstimateLeadsRead(q) ? { rows: many(1100, (i) => ({ lead_id: `v-${i}` })) }
    : isEstimateValuesRead(q) ? { rows: many(1100, () => ({ status: "sent", amount: 10, sent_at: daysAgo(2), expires_at: null })) }
    : {};
  const baseline = await snapshotWith(data).snapshot;
  assert.deepEqual(baseline.revenueOpportunityUnavailable, { qualifiedNoAppointment: false, visitsNoEstimate: false, estimates: false });
  assert.deepEqual([baseline.revenueOpportunity.qualifiedLeadsWithoutAppointment, baseline.revenueOpportunity.completedAppointmentsWithoutEstimate, baseline.revenueOpportunity.recoverableEstimateValue], [50, 0, 11_000]);

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
    isVisitsRead(q) ? { rows: [{ lead_id: "a" }] } : isQualifiedLeadsRead(q) || isBookingLeadsRead(q) ? { rows: [{ id: "a", status: "qualified" }] } : {},
  );
  const s = await snapshot;
  const leakQueries = fake.queries.filter((q) => LEAK_READS.some((match) => match(q)));
  assert.ok(leakQueries.length >= 6);
  for (const q of leakQueries) {
    assert.ok(!q.calls.some((c) => /^in (lead_id|id|contact_id) /.test(c)), `${q.table}: ${q.calls.join(" / ")}`);
    assert.ok(!q.calls.some((c) => c.startsWith("limit ")), `${q.table} uses paging, not a cap`);
    assert.ok(q.calls.includes("order id") && q.calls.some((c) => c.startsWith("range ")), `${q.table} paged by readAllPages`);
  }
  assert.deepEqual(Object.keys(buildAiInsightsInput(s)).sort(), ["aiMetrics", "appointmentMetrics", "automationMetrics", "billingMetrics", "communicationMetrics", "comparisons", "dataQuality", "estimateMetrics", "followUpMetrics", "jobMetrics", "leadMetrics", "period", "pipelineMetrics"]);
  assert.ok(!("revenueOpportunityUnavailable" in buildAiInsightsInput(s)));
});

/**
 * Phase 3A-2: the Analytics-only and lifecycle reads - getReviewReferralMetrics
 * (review and referral requests), getAppointmentOccurrenceMetrics,
 * getOpportunityOutcomes and getRepeatCustomerSummaryResult - against a fake
 * Supabase client that, like the real API, returns at most 1,000 rows to a
 * request that isn't paged. Every read must be complete at 999, exactly 1,000
 * and 2,500 rows (relevant records placed after row 1,000), in any row order;
 * a failed page or the row limit must be a failure with no partial rows, and
 * a genuinely empty result a real zero. A failed review/referral read is no
 * longer discarded: the snapshot flags it (reviewReferralUnavailable) and
 * Analytics' existing banner shows it; partialData inputs and the AI field
 * set are unchanged.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/bi/analytics-reads.scale.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const { getReviewReferralMetrics }: typeof import("./queries") = require(path.join(ROOT, "lib/bi/queries.ts"));
const { getBusinessMetricsSnapshot, getAppointmentOccurrenceMetrics, getOpportunityOutcomes }: typeof import("./metrics") = require(path.join(ROOT, "lib/bi/metrics.ts"));
const { buildAiInsightsInput }: typeof import("./insights") = require(path.join(ROOT, "lib/bi/insights.ts"));
const { MAX_ATTRIBUTION_ROWS }: typeof import("./revenue-attribution") = require(path.join(ROOT, "lib/bi/revenue-attribution.ts"));
const { getRepeatCustomerSummaryResult }: typeof import("@/lib/customers/lifecycle") = require(path.join(ROOT, "lib/customers/lifecycle.ts"));

type Query = { table: string; calls: string[] };
type Answer = { rows?: unknown[]; error?: boolean; failOnPage?: number };

/** The Phase 2F-3A fake client with the API's cap: a request that isn't paged gets at most 1,000 rows. */
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
        return Promise.resolve({ data: from === undefined ? rows.slice(0, 1000) : rows.slice(from, to! + 1), error: null, count: rows.length });
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

const isReviews = (q: Query) => q.table === "review_requests";
const isReferrals = (q: Query) => q.table === "referral_requests";
const isAppointments = (q: Query) => q.table === "appointments" && q.calls.includes("select status");
const isOutcomes = (q: Query) => q.table === "opportunities" && q.calls.includes("select status, resolution_reason, estimated_value");
const isCompletedJobs = (q: Query) => q.table === "jobs" && q.calls.includes("select contact_id, amount, completed_at");
const pagesOf = (queries: Query[], match: (q: Query) => boolean) => queries.filter(match).flatMap((q) => q.calls.filter((c) => c.startsWith("range")));
const EXPECTED_PAGES: Record<number, string[]> = {
  999: ["range 0 999"],
  1000: ["range 0 999", "range 1000 1999"],
  2500: ["range 0 999", "range 1000 1999", "range 2000 2999"],
};
const count = <T>(rows: T[], match: (row: T) => boolean) => rows.filter(match).length;
const ALL_TIME = { label: "all time", from: null, to: null };
const SIZES = [999, 1000, 2500];

/** Deterministic shuffle (a fixed-seed LCG) - same input, same output, every run. */
function shuffled<T>(rows: T[]): T[] {
  const out = [...rows];
  let seed = 7;
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Row builders: the first 1,000 rows carry one ordinary status; the statuses a
// capped read used to drop appear only past row 1,000.
const requests = (n: number, outcome: "completed" | "converted") =>
  Array.from({ length: n }, (_, i) => (i < 1000 ? { status: "requested", responded_at: null } : { status: ["responded", outcome, "declined", "failed"][i % 4], responded_at: i % 4 === 3 ? null : "2026-09-10T00:00:00Z" }));
const appointments = (n: number) => Array.from({ length: n }, (_, i) => ({ status: i < 1000 ? "scheduled" : ["completed", "no_show", "cancelled"][i % 3] }));
const outcomes = (n: number) =>
  Array.from({ length: n }, (_, i) => (i < 1000 ? { status: "resolved", resolution_reason: "condition_no_longer_true", estimated_value: 100 } : i % 2 === 0 ? { status: "resolved", resolution_reason: "lost", estimated_value: 500 } : { status: "dismissed", resolution_reason: "dismissed", estimated_value: null }));
/**
 * Completed jobs: the first 1,000 belong to one-job customers c0..c999; each
 * row past 1,000 is a second job for one of those customers (or a further job
 * for a new one) - a capped read saw no repeat customers at all. Every
 * completed_at is unique, so "which job came first" never depends on order.
 */
const completedJobs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    contact_id: i < 1000 ? `c${i}` : `c${i % 1500}`,
    amount: i % 7 === 0 ? null : 100 + (i % 5),
    completed_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
  }));

/** The repeat-customer rollup computed directly from all rows - the expected answer at any size. */
function expectedRepeat(rows: ReturnType<typeof completedJobs>) {
  const byContact = new Map<string, typeof rows>();
  for (const row of rows) byContact.set(row.contact_id, [...(byContact.get(row.contact_id) ?? []), row]);
  let repeat = 0;
  let additional = 0;
  let additionalValue = 0;
  for (const list of byContact.values()) {
    if (list.length < 2) continue;
    repeat += 1;
    const later = [...list].sort((a, b) => (a.completed_at < b.completed_at ? -1 : 1)).slice(1);
    additional += later.length;
    additionalValue += later.reduce((sum, job) => sum + (job.amount ?? 0), 0);
  }
  const known = rows.filter((row) => row.amount != null);
  return { customers: byContact.size, repeat, jobs: rows.length, knownValue: known.reduce((sum, row) => sum + row.amount!, 0), additional, additionalValue };
}

// ---------------------------------------------------------------------------
// Each read: 999 / 1,000 / 2,500 rows, any order, paged by id
// ---------------------------------------------------------------------------

test("getReviewReferralMetrics: both reads complete at 999, exactly 1,000 and 2,500 rows (outcomes only past row 1,000), in any order, paged by id", async () => {
  for (const n of SIZES) {
    for (const order of [<T,>(r: T[]) => r, shuffled]) {
      const reviews = order(requests(n, "completed"));
      const referrals = order(requests(n, "converted"));
      const { supabase, queries } = fakeSupabase((q) => (isReviews(q) ? { rows: reviews } : isReferrals(q) ? { rows: referrals } : {}));
      const m = await getReviewReferralMetrics(supabase, "org-1", ALL_TIME);
      assert.equal(m.failed, false, `${n}`);
      assert.deepEqual(pagesOf(queries, isReviews), EXPECTED_PAGES[n], `${n} review pages`);
      assert.deepEqual(pagesOf(queries, isReferrals), EXPECTED_PAGES[n], `${n} referral pages`);
      assert.deepEqual([m.reviewsRequested, m.reviewsResponded, m.reviewsCompleted, m.reviewsDeclined, m.reviewsFailed], [n, ...["responded", "completed", "declined", "failed"].map((s) => count(reviews, (r) => r.status === s))]);
      assert.deepEqual([m.referralsRequested, m.referralsConverted, m.referralsFailed], [n, ...["converted", "failed"].map((s) => count(referrals, (r) => r.status === s))]);
      assert.equal(m.reviewsWithResponse, count(reviews, (r) => r.status !== "failed" && r.responded_at != null));
    }
  }
});

test("getAppointmentOccurrenceMetrics: complete at 999, exactly 1,000 and 2,500 rows (completed/no-show/cancelled only past row 1,000), in any order, paged by id", async () => {
  for (const n of SIZES) {
    for (const rows of [appointments(n), shuffled(appointments(n))]) {
      const { supabase, queries } = fakeSupabase((q) => (isAppointments(q) ? { rows } : {}));
      const { metrics: m, failed } = await getAppointmentOccurrenceMetrics(supabase, "org-1", ALL_TIME);
      assert.equal(failed, false, `${n}`);
      assert.deepEqual(pagesOf(queries, isAppointments), EXPECTED_PAGES[n], `${n} pages`);
      assert.deepEqual([m.totalAppointments, m.scheduledAppointments, m.completedAppointments, m.noShowAppointments, m.cancelledAppointments], [n, ...["scheduled", "completed", "no_show", "cancelled"].map((s) => count(rows, (r) => r.status === s))]);
    }
  }
});

test("getOpportunityOutcomes: complete at 999, exactly 1,000 and 2,500 rows (lost/dismissed only past row 1,000), in any order, paged by id", async () => {
  for (const n of SIZES) {
    for (const rows of [outcomes(n), shuffled(outcomes(n))]) {
      const { supabase, queries } = fakeSupabase((q) => (isOutcomes(q) ? { rows } : {}));
      const { groups, failed } = await getOpportunityOutcomes(supabase, "org-1", ALL_TIME);
      assert.equal(failed, false, `${n}`);
      assert.deepEqual(pagesOf(queries, isOutcomes), EXPECTED_PAGES[n], `${n} pages`);
      const by = Object.fromEntries(groups.map((g) => [g.key, [g.count, g.value]]));
      const lost = rows.filter((r) => r.resolution_reason === "lost");
      assert.deepEqual(by.lost, [lost.length, lost.length * 500]);
      assert.deepEqual(by.dismissed, [count(rows, (r) => r.status === "dismissed"), 0]);
      assert.deepEqual(by.no_longer_applies, [Math.min(n, 1000), Math.min(n, 1000) * 100]);
    }
  }
});

test("getRepeatCustomerSummaryResult: complete at 999, exactly 1,000 and 2,500 rows (every repeat job past row 1,000), in any order, paged by id", async () => {
  for (const n of SIZES) {
    for (const rows of [completedJobs(n), shuffled(completedJobs(n))]) {
      const { supabase, queries } = fakeSupabase((q) => (isCompletedJobs(q) ? { rows } : {}));
      const s = await getRepeatCustomerSummaryResult(supabase, "org-1");
      const e = expectedRepeat(completedJobs(n));
      assert.equal(s.failed, false, `${n}`);
      assert.deepEqual(pagesOf(queries, isCompletedJobs), EXPECTED_PAGES[n], `${n} pages`);
      assert.deepEqual([s.customersWithCompletedJob, s.repeatCustomerCount, s.completedJobCount, s.knownCompletedJobValue, s.additionalCompletedJobCount, s.additionalCompletedJobKnownValue], [e.customers, e.repeat, e.jobs, e.knownValue, e.additional, e.additionalValue]);
      if (n > 1000) assert.ok(s.repeatCustomerCount > 0, "repeat customers only exist past row 1,000");
    }
  }
});

// ---------------------------------------------------------------------------
// Failure vs genuine empty
// ---------------------------------------------------------------------------

type Run = [string, (supabase: SupabaseClient) => Promise<{ failed: boolean; zero: number }>, (q: Query) => boolean, (n: number) => unknown[]];
const RUNS: Run[] = [
  ["review requests", async (s) => { const m = await getReviewReferralMetrics(s, "org-1", ALL_TIME); return { failed: m.failed, zero: m.reviewsRequested + m.reviewsCompleted }; }, isReviews, (n) => requests(n, "completed")],
  ["referral requests", async (s) => { const m = await getReviewReferralMetrics(s, "org-1", ALL_TIME); return { failed: m.failed, zero: m.referralsRequested + m.referralsConverted }; }, isReferrals, (n) => requests(n, "converted")],
  ["appointment occurrence", async (s) => { const { metrics, failed } = await getAppointmentOccurrenceMetrics(s, "org-1", ALL_TIME); return { failed, zero: metrics.totalAppointments }; }, isAppointments, appointments],
  ["opportunity outcomes", async (s) => { const { groups, failed } = await getOpportunityOutcomes(s, "org-1", ALL_TIME); return { failed, zero: groups.reduce((sum, g) => sum + g.count + g.value, 0) }; }, isOutcomes, outcomes],
  ["repeat customers", async (s) => { const r = await getRepeatCustomerSummaryResult(s, "org-1"); return { failed: r.failed, zero: r.completedJobCount + r.customersWithCompletedJob + r.knownCompletedJobValue }; }, isCompletedJobs, completedJobs],
];

test("a page-1 error, a page-2 error or the row limit is failed with no partial rows used; a genuinely empty result is a real zero", async () => {
  for (const [name, run, match, build] of RUNS) {
    for (const failure of [{ error: true, rows: build(2500) }, { failOnPage: 2, rows: build(2500) }, { rows: build(MAX_ATTRIBUTION_ROWS + 1) }]) {
      const result = await run(fakeSupabase((q) => (match(q) ? failure : {})).supabase);
      assert.equal(result.failed, true, name);
      assert.equal(result.zero, 0, `${name}: no partial rows are counted`);
    }
    assert.deepEqual(await run(fakeSupabase().supabase), { failed: false, zero: 0 }, `${name}: genuine empty`);
  }
});

test("review/referral: a failed read is no longer discarded - only that read is zeroed, the other stands, and `failed` is set", async () => {
  const reviews = requests(1500, "completed");
  const referrals = requests(1500, "converted");
  const reviewFails = await getReviewReferralMetrics(fakeSupabase((q) => (isReviews(q) ? { rows: reviews, failOnPage: 2 } : isReferrals(q) ? { rows: referrals } : {})).supabase, "org-1", ALL_TIME);
  assert.deepEqual([reviewFails.failed, reviewFails.reviewsRequested, reviewFails.referralsRequested], [true, 0, 1500]);
  const referralFails = await getReviewReferralMetrics(fakeSupabase((q) => (isReviews(q) ? { rows: reviews } : isReferrals(q) ? { error: true } : {})).supabase, "org-1", ALL_TIME);
  assert.deepEqual([referralFails.failed, referralFails.reviewsRequested, referralFails.referralsRequested], [true, 1500, 0]);
});

// ---------------------------------------------------------------------------
// Disclosure: the snapshot flag and Analytics' existing banner
// ---------------------------------------------------------------------------

const AI_FIELDS = ["aiMetrics", "appointmentMetrics", "automationMetrics", "billingMetrics", "communicationMetrics", "comparisons", "dataQuality", "estimateMetrics", "followUpMetrics", "jobMetrics", "leadMetrics", "period", "pipelineMetrics"];
const snapshotWith = (answer: (q: Query) => Answer) => getBusinessMetricsSnapshot(fakeSupabase(answer).supabase, "org-1", "last30Days", { now: new Date("2026-09-25T12:00:00Z") });

test("snapshot: a failed review or referral read sets reviewReferralUnavailable (page 1, page 2 or row limit); partialData, the metrics shape and the AI field set are unchanged", async () => {
  for (const match of [isReviews, isReferrals]) {
    for (const failure of [{ error: true }, { failOnPage: 2, rows: requests(2500, "completed") }, { rows: requests(MAX_ATTRIBUTION_ROWS + 1, "completed") }]) {
      const s = await snapshotWith((q) => (match(q) ? failure : {}));
      assert.equal(s.reviewReferralUnavailable, true);
      assert.equal(s.partialData, false, "review/referral never feeds partialData");
      assert.ok(!("failed" in s.reviewReferralMetrics), "the metrics shape is unchanged - the flag lives on the snapshot");
      const ai = buildAiInsightsInput(s);
      assert.deepEqual(Object.keys(ai).sort(), AI_FIELDS);
      assert.ok(!("reviewReferralUnavailable" in ai) && !("reviewReferralMetrics" in ai), "the AI never sees review/referral figures");
    }
  }
  const ok = await snapshotWith((q) => (isReviews(q) ? { rows: requests(1500, "completed") } : isReferrals(q) ? { rows: requests(1500, "converted") } : {}));
  assert.deepEqual([ok.reviewReferralUnavailable, ok.reviewReferralMetrics.reviewsRequested, ok.reviewReferralMetrics.referralsRequested], [false, 1500, 1500]);
  const empty = await snapshotWith(() => ({}));
  assert.deepEqual([empty.reviewReferralUnavailable, empty.reviewReferralMetrics.reviewsRequested], [false, 0]);
});

test("Analytics' existing banner includes reviewReferralUnavailable alongside the other read-failure flags", () => {
  const page = fs.readFileSync(path.join(ROOT, "app/(app)/insights/page.tsx"), "utf8");
  assert.match(page, /snapshot\.automationUnavailable \|\| snapshot\.reviewReferralUnavailable \|\| repeatCustomerSummary\.failed \|\| appointmentOccurrence\.failed \|\| opportunityOutcomes\.failed/);
  assert.match(page, /<p>Some information is temporarily unavailable\. Please try again\.<\/p>/);
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

test("guards: the five reads use readAllPages with a stable id order and no capped read; partialData inputs are byte-identical to main", () => {
  const body = (file: string, fn: string) => {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    const start = source.indexOf(`async function ${fn}(`);
    assert.ok(start >= 0, fn);
    return source.slice(start, source.indexOf("\n}\n", start));
  };
  const reads: [string, string, number][] = [
    ["lib/bi/queries.ts", "getReviewReferralMetrics", 2],
    ["lib/bi/metrics.ts", "getAppointmentOccurrenceMetrics", 1],
    ["lib/bi/metrics.ts", "getOpportunityOutcomes", 1],
    ["lib/customers/lifecycle.ts", "getRepeatCustomerSummaryResult", 1],
  ];
  for (const [file, fn, reads_] of reads) {
    const code = body(file, fn);
    assert.equal(code.match(/readAllPages</g)?.length, reads_, fn);
    assert.equal(code.match(/\.order\("id"\)/g)?.length, reads_, fn);
    assert.doesNotMatch(code, /\.limit\(/, fn);
  }
  const partialData = (source: string) => source.slice(source.indexOf("const partialDataSourceCount"), source.indexOf(".length;", source.indexOf("const partialDataSourceCount")));
  const main = execFileSync("git", ["show", "a5b98555bac6334dfd1e401dfc93fffd105e646d:lib/bi/metrics.ts"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(partialData(fs.readFileSync(path.join(ROOT, "lib/bi/metrics.ts"), "utf8")), partialData(main));
});

/**
 * Phase 2E: collected cash by lead source (lib/bi/cash-attribution.ts) - the
 * pure summary, the merge into Revenue by source, reconciliation with the
 * billing ledger's Collected, the query shape and the paged read's failure
 * handling. The real payment → job → lead chain, organization isolation and
 * Denver boundaries are proven against TEST in
 * cash-attribution.integration.test.ts.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/bi/cash-attribution.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CashPaymentRow } from "./cash-attribution";
import type { RevenueAttribution } from "./revenue-attribution";

const require = createRequire(import.meta.url);
const { summarizeCashBySource, withCollected, getCashAttribution }: typeof import("./cash-attribution") = require(path.join(process.cwd(), "lib/bi/cash-attribution.ts"));
const { computeBillingMetrics }: typeof import("./billing") = require(path.join(process.cwd(), "lib/bi/billing.ts"));
const { summarizeRevenueAttribution, MAX_ATTRIBUTION_ROWS }: typeof import("./revenue-attribution") = require(path.join(process.cwd(), "lib/bi/revenue-attribution.ts"));

// September in Denver: Sep 1 00:00 MDT (06:00Z) to Oct 1 00:00 MDT (06:00Z), as resolveDateRange builds it.
const SEP = { label: "custom", from: "2026-09-01T06:00:00.000Z", to: "2026-10-01T06:00:00.000Z" };
const ALL_TIME = { label: "all time", from: null, to: null };
const IN_SEP = "2026-09-15T18:00:00+00:00";

const pay = (amount: number | string, source: string | null | undefined, received_at = IN_SEP): CashPaymentRow => ({
  amount,
  received_at,
  // undefined source = a job with no lead linked.
  job: { lead: source === undefined ? null : { source } },
});
const collected = (cash: ReturnType<typeof summarizeCashBySource>) => Object.fromEntries(cash.collectedByKey);

test("attributes each payment through its job's lead to that lead's source - trimmed, case kept, exactly like Revenue by source", () => {
  const cash = summarizeCashBySource([pay(500, "Google"), pay(250, " Google "), pay(100, "google"), pay(75, "Referral")], SEP);
  assert.deepEqual(collected(cash), { "source:Google": 750, "source:google": 100, "source:Referral": 75 });
  assert.equal(cash.total, 925);
});

test("a lead with a blank or missing source is Unknown source; a job with no lead is No lead linked - nothing dropped", () => {
  const cash = summarizeCashBySource([pay(10, null), pay(20, "   "), pay(30, undefined), { amount: 40, received_at: IN_SEP, job: null }], SEP);
  assert.deepEqual(collected(cash), { unknown: 30, unlinked: 70 });
  assert.equal(cash.total, 100);
});

test("several payments on one job and payments on several jobs of one lead all land on that one source, net of reversals, cent-exact", () => {
  const cash = summarizeCashBySource([pay(0.1, "Yelp"), pay(0.2, "Yelp"), pay("1000.35", "Yelp"), pay(-0.2, "Yelp"), { amount: 99.99, received_at: IN_SEP, job: [{ lead: [{ source: "Yelp" }] }] }], SEP);
  assert.deepEqual(collected(cash), { "source:Yelp": 1100.44 });
  assert.equal(cash.total, 1100.44);
});

test("period: received_at inside the range only - and each boundary instant decided exactly as the billing ledger decides it", () => {
  const rows = [
    pay(1, "A", "2026-09-01T05:59:59+00:00"), // Aug 31, 23:59:59 MDT - before
    pay(2, "A", "2026-09-01T06:00:00+00:00"), // exactly the start (Sep 1, 00:00 MDT), as Postgres returns it - inside
    pay(4, "A", "2026-09-01T06:00:00.5+00:00"),
    pay(8, "A", "2026-09-30T23:30:00+00:00"),
    pay(16, "A", "2026-10-01T05:59:59+00:00"), // Sep 30, 23:59:59 MDT - inside
    pay(32, "A", "2026-10-01T06:00:00+00:00"), // exactly the end (Oct 1, 00:00 MDT) - the next period
    pay(64, "A", "2026-10-01T06:00:01+00:00"), // Oct 1 - after
  ];
  const cash = summarizeCashBySource(rows, SEP);
  const billing = computeBillingMetrics({ invoices: [], payments: rows.map((row) => ({ invoice_id: "i", amount: Number(row.amount), received_at: row.received_at, created_at: row.received_at })), range: SEP, today: "2026-10-15" });
  assert.equal(cash.total, billing.collectedValue);
  assert.equal(cash.total, 2 + 4 + 8 + 16);
  assert.equal(summarizeCashBySource(rows, ALL_TIME).total, 127);
});

test("reconciliation: the per-source amounts always add up to the billing ledger's Collected for the same payments and period", () => {
  const sources = ["Google", "Referral", null, undefined, " Google"];
  let seed = 7;
  const next = () => (seed = (seed * 48271) % 2147483647);
  const rows: CashPaymentRow[] = Array.from({ length: 400 }, () => {
    const day = String(1 + (next() % 30)).padStart(2, "0");
    const cents = (next() % 500000) - 50000;
    return pay((cents === 0 ? 1 : cents) / 100, sources[next() % sources.length], `2026-${next() % 2 ? "09" : "10"}-${day}T${String(next() % 24).padStart(2, "0")}:00:00+00:00`);
  });
  const cash = summarizeCashBySource(rows, SEP);
  const billing = computeBillingMetrics({ invoices: [], payments: rows.map((row) => ({ invoice_id: "i", amount: Number(row.amount), received_at: row.received_at, created_at: row.received_at })), range: SEP, today: "2026-10-15" });
  assert.equal(cash.total, billing.collectedValue);
  const sumOfRows = [...cash.collectedByKey.values()].reduce((sum, value) => sum + Math.round(value * 100), 0) / 100;
  assert.equal(sumOfRows, billing.collectedValue);
});

const attribution = (input: Partial<Parameters<typeof summarizeRevenueAttribution>[0]>): RevenueAttribution =>
  summarizeRevenueAttribution({ leads: [], periodJobs: [], completedJobs: [], cohortJobs: [], ...input });

test("withCollected: adds Collected to every Revenue by source row, keeps its order and figures, and totals to the overall Collected", () => {
  const base = attribution({
    leads: [{ source: "Referral" }, { source: "Google" }, { source: null }],
    periodJobs: [{ status: "scheduled", lead: { source: "Google" } }, { status: "scheduled", lead: null }],
    completedJobs: [{ amount: 900, lead: { source: "Google" } }],
  });
  const table = withCollected(base, summarizeCashBySource([pay(300, "Google"), pay(50, null), pay(25, undefined)], SEP));
  assert.deepEqual(
    table.rows.map((r) => [r.label, r.leads, r.jobs, r.completedJobs, r.completedValue, r.collected]),
    [
      ["Google", 1, 1, 1, 900, 300],
      ["Referral", 1, 0, 0, 0, 0],
      ["Unknown source", 1, 0, 0, 0, 50],
      ["No lead linked", null, 1, 0, 0, 25],
    ],
  );
  assert.deepEqual(table.totals, { ...base.totals, collected: 375 });
  assert.deepEqual(table.rows.map((row) => { const { collected, ...rest } = row; assert.equal(typeof collected, "number"); return rest; }), base.rows, "every existing figure and the row order are unchanged");
});

test("withCollected: a source with payments but no leads or jobs in the period gets its own row, in Revenue by source order", () => {
  const base = attribution({ leads: [{ source: "Google" }] });
  const table = withCollected(base, summarizeCashBySource([pay(80, "Angi"), pay(20, "Zillow"), pay(5, undefined), pay(7, "")], SEP));
  assert.deepEqual(table.rows.map((r) => [r.key, r.label, r.kind, r.leads, r.jobs, r.collected]), [
    ["source:Angi", "Angi", "source", 0, 0, 80],
    ["source:Google", "Google", "source", 1, 0, 0],
    ["source:Zillow", "Zillow", "source", 0, 0, 20],
    ["unknown", "Unknown source", "unknown", 0, 0, 7],
    ["unlinked", "No lead linked", "unlinked", null, 0, 5],
  ]);
  assert.equal(table.totals.collected, 112);
  assert.equal(table.totals.leads, 1);
});

/** A chainable stand-in for the Supabase query builder over `rows`, recording every filter and range. */
function fakeSupabase(rows: unknown[], options: { failOnPage?: number } = {}) {
  const calls: string[] = [];
  const ranges: [number, number][] = [];
  const builder = {
    select: (columns: string) => (calls.push(`select ${columns}`), builder),
    eq: (column: string, value: unknown) => (calls.push(`eq ${column} ${value}`), builder),
    gte: (column: string, value: unknown) => (calls.push(`gte ${column} ${value}`), builder),
    lte: (column: string, value: unknown) => (calls.push(`lte ${column} ${value}`), builder),
    lt: (column: string, value: unknown) => (calls.push(`lt ${column} ${value}`), builder),
    order: (column: string) => (calls.push(`order ${column}`), builder),
    range: (from: number, to: number) => {
      ranges.push([from, to]);
      if (options.failOnPage === ranges.length) return Promise.resolve({ data: null, error: { message: "boom" } });
      return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
    },
  };
  const supabase = { from: (table: string) => (calls.push(`from ${table}`), builder) } as unknown as SupabaseClient;
  return { supabase, calls, ranges };
}

test("getCashAttribution: one org-scoped payments read joined to the job's lead source, [from, to] on received_at, ordered by id", async () => {
  const { supabase, calls } = fakeSupabase([pay(10, "Google")]);
  const result = await getCashAttribution(supabase, "org-1", SEP);
  assert.deepEqual(calls.slice(0, 6), [
    "from customer_payments",
    "select amount, received_at, job:jobs!customer_payments_job_id_fkey(lead:leads!jobs_lead_id_fkey(source))",
    "eq organization_id org-1",
    `gte received_at ${SEP.from}`,
    `lte received_at ${SEP.to}`,
    "order id",
  ]);
  assert.deepEqual([result.failed, result.total], [false, 10]);
  const allTime = fakeSupabase([]);
  await getCashAttribution(allTime.supabase, "org-1", ALL_TIME);
  assert.ok(!allTime.calls.some((call) => call.startsWith("gte") || call.startsWith("lte")), "all time has no date filter");
});

test("getCashAttribution: pages through every row - 2,500 payments across three pages, all counted", async () => {
  const rows = Array.from({ length: 2500 }, (_, i) => pay(1, i % 2 ? "Google" : undefined));
  const { supabase, ranges } = fakeSupabase(rows);
  const result = await getCashAttribution(supabase, "org-1", SEP);
  assert.deepEqual(ranges, [[0, 999], [1000, 1999], [2000, 2999]]);
  assert.deepEqual([result.failed, result.total, result.collectedByKey.get("source:Google"), result.collectedByKey.get("unlinked")], [false, 2500, 1250, 1250]);
});

test("getCashAttribution: past the safety limit it fails with nothing collected - never a partial total", async () => {
  const rows = Array.from({ length: MAX_ATTRIBUTION_ROWS + 1 }, () => pay(1, "Google"));
  const result = await getCashAttribution(fakeSupabase(rows).supabase, "org-1", SEP);
  assert.deepEqual([result.failed, result.total, result.collectedByKey.size], [true, 0, 0]);
});

test("getCashAttribution: a read error on any page fails with nothing collected - never the pages that did arrive", async () => {
  const rows = Array.from({ length: 1500 }, () => pay(1, "Google"));
  const result = await getCashAttribution(fakeSupabase(rows, { failOnPage: 2 }).supabase, "org-1", SEP);
  assert.deepEqual([result.failed, result.total, result.collectedByKey.size], [true, 0, 0]);
});

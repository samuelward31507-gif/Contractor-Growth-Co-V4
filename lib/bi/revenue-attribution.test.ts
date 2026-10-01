/**
 * Phase 2C: revenue attribution by lead source (lib/bi/revenue-attribution.ts)
 * - the pure summary and the pager. The real queries, organization
 * isolation and timezone boundaries are proven against TEST in
 * revenue-attribution.integration.test.ts.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/bi/revenue-attribution.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { summarizeRevenueAttribution, readAllPages, UNKNOWN_SOURCE_LABEL, NO_LEAD_LABEL }: typeof import("./revenue-attribution") = require(path.join(process.cwd(), "lib/bi/revenue-attribution.ts"));

const src = (source: string | null) => ({ source });
const EMPTY = { leads: [], periodJobs: [], completedJobs: [], cohortJobs: [] };
const row = (result: ReturnType<typeof summarizeRevenueAttribution>, label: string) => result.rows.find((r) => r.label === label);

test("groups by lead source as entered (trimmed, case kept) - named sources alphabetically, then Unknown source, then No lead linked", () => {
  const result = summarizeRevenueAttribution({
    ...EMPTY,
    leads: [src("Google"), src(" Google "), src("Referral"), src("Facebook"), src(null), src("   ")],
    periodJobs: [{ status: "scheduled", lead: src("Referral") }, { status: "completed", lead: null }],
  });
  assert.deepEqual(result.rows.map((r) => [r.label, r.leads, r.jobs]), [
    ["Facebook", 1, 0],
    ["Google", 2, 0],
    ["Referral", 1, 1],
    [UNKNOWN_SOURCE_LABEL, 2, 0],
    [NO_LEAD_LABEL, null, 1],
  ]);
});

test("linked vs unlinked jobs: a job with no lead is never dropped - it lands in No lead linked, and a linked lead with no source in Unknown source", () => {
  const result = summarizeRevenueAttribution({
    ...EMPTY,
    completedJobs: [
      { amount: 1000, lead: src("Google") },
      { amount: 400, lead: src(null) },
      { amount: 250, lead: null },
      { amount: "125.50", lead: [{ source: "Google" }] }, // embed as an array, numeric as a string
    ],
  });
  assert.deepEqual([row(result, "Google")?.completedJobs, row(result, "Google")?.completedValue], [2, 1125.5]);
  assert.equal(row(result, UNKNOWN_SOURCE_LABEL)?.completedValue, 400);
  assert.equal(row(result, NO_LEAD_LABEL)?.completedValue, 250);
  assert.equal(result.totals.completedValue, 1775.5, "the buckets add up to every completed job");
  assert.equal(result.totals.completedJobs, 4);
});

test("completed vs not: Jobs excludes cancelled; Completed and value come only from the completed read; a job without an amount counts but adds nothing", () => {
  const result = summarizeRevenueAttribution({
    ...EMPTY,
    periodJobs: [{ status: "scheduled", lead: src("Phone") }, { status: "in_progress", lead: src("Phone") }, { status: "completed", lead: src("Phone") }, { status: "cancelled", lead: src("Phone") }],
    completedJobs: [{ amount: null, lead: src("Phone") }, { amount: 300, lead: src("Phone") }],
  });
  assert.deepEqual([row(result, "Phone")?.jobs, row(result, "Phone")?.completedJobs, row(result, "Phone")?.completedValue], [3, 2, 300]);
});

test("lead → job: the denominator is leads created in the period; a lead with several jobs counts once; cancelled jobs don't convert; value is completed jobs only", () => {
  const result = summarizeRevenueAttribution({
    ...EMPTY,
    leads: [src("A"), src("A"), src("B"), src(null)],
    cohortJobs: [
      { lead_id: "l1", status: "completed", amount: 500 },
      { lead_id: "l1", status: "completed", amount: 200 }, // same lead, second job
      { lead_id: "l2", status: "scheduled", amount: 900 },
      { lead_id: "l3", status: "cancelled", amount: 700 },
    ],
  });
  assert.deepEqual(result.conversion, { leads: 4, leadsWithJob: 2, jobRate: 50, completedJobs: 2, completedValue: 700 });
});

test("empty dataset: no rows, zero totals, and a null rate - never a fabricated 0%", () => {
  const result = summarizeRevenueAttribution(EMPTY);
  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.totals, { leads: 0, jobs: 0, completedJobs: 0, completedValue: 0 });
  assert.deepEqual(result.conversion, { leads: 0, leadsWithJob: 0, jobRate: null, completedJobs: 0, completedValue: 0 });
});

test("large data: thousands of rows across pages are all read and summed; past the ceiling the read reports failed instead of a silent partial", async () => {
  const all = Array.from({ length: 2500 }, (_, i) => ({ amount: 1, lead: src(i % 2 ? "Google" : null) }));
  const pager = (rows: unknown[], ranges: [number, number][]) => () => ({ range: (from: number, to: number) => (ranges.push([from, to]), Promise.resolve({ data: rows.slice(from, to + 1), error: null })) });
  const ranges: [number, number][] = [];
  const read = await readAllPages<(typeof all)[number]>(pager(all, ranges));
  assert.equal(read.rows.length, 2500);
  assert.equal(read.failed, false);
  assert.deepEqual(ranges, [[0, 999], [1000, 1999], [2000, 2999]]);
  const result = summarizeRevenueAttribution({ ...EMPTY, completedJobs: read.rows });
  assert.equal(result.totals.completedValue, 2500);

  const capped = await readAllPages(pager(all, []), 2000);
  assert.equal(capped.failed, true);

  const errored = await readAllPages(() => ({ range: () => Promise.resolve({ data: null, error: { message: "boom" } }) }));
  assert.deepEqual(errored, { rows: [], failed: true });
});

test("queries: a server-side join on jobs.lead_id, paged, scoped to the organization, completed revenue dated by completion - no ID lists, no .in()", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "lib/bi/revenue-attribution.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(source, /\.in\(/);
  assert.equal((source.match(/\.eq\("organization_id", organizationId\)/g) ?? []).length, 4);
  assert.match(source, /\.eq\("status", "completed"\);\s*if \(range\.from\) query = query\.gte\("completed_at", range\.from\);\s*if \(range\.to\) query = query\.lt\("completed_at", range\.to\);/);
  assert.match(source, /\$\{LEAD\}!inner\(created_at\)[\s\S]*query\.gte\("lead\.created_at", range\.from\)/);
  assert.match(source, /const LEAD = "lead:leads!jobs_lead_id_fkey";/);
});

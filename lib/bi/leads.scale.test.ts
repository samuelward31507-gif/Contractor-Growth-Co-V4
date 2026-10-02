/**
 * Phase 2I: the lead reads behind Analytics, Agency and the AI input -
 * getLeadAndPipelineMetrics (period leads and all-time open leads),
 * getSourceCounts (via the snapshot) and getLeadsCreatedPerDay (the leads
 * chart) - against a fake Supabase client that, like the real API, returns
 * at most 1,000 rows to a request that isn't paged. Every read must be
 * complete past 1,000 rows, and a failed page or the row limit must be a
 * failure - never partial figures - with definitions, partialData and the
 * AI input unchanged. The same cases run against TEST in
 * leads.scale.integration.test.ts.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/bi/leads.scale.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const { getLeadAndPipelineMetrics, resolveDateRange }: typeof import("./queries") = require(path.join(ROOT, "lib/bi/queries.ts"));
const { getBusinessMetricsSnapshot }: typeof import("./metrics") = require(path.join(ROOT, "lib/bi/metrics.ts"));
const { getLeadsCreatedPerDay }: typeof import("./series") = require(path.join(ROOT, "lib/bi/series.ts"));
const { buildAiInsightsInput }: typeof import("./insights") = require(path.join(ROOT, "lib/bi/insights.ts"));
const { MAX_ATTRIBUTION_ROWS }: typeof import("./revenue-attribution") = require(path.join(ROOT, "lib/bi/revenue-attribution.ts"));

type Query = { table: string; calls: string[] };
type Answer = { rows?: unknown[]; error?: boolean; failOnPage?: number };

/** The Phase 2F/2G fake client, plus the API's cap: a request that isn't paged gets at most 1,000 rows. */
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

const has = (q: Query, prefix: string) => q.calls.some((call) => call.startsWith(prefix));
const isPeriodLeads = (q: Query) => q.table === "leads" && q.calls.includes("select status, temperature");
const isOpenLeads = (q: Query) => q.table === "leads" && q.calls.includes("select estimated_value");
const isSourceLeads = (q: Query) => q.table === "leads" && q.calls.includes("select source");
const isChartLeads = (q: Query) => q.table === "leads" && q.calls.includes("select created_at");
const pagesOf = (queries: Query[], match: (q: Query) => boolean) => queries.filter(match).flatMap((q) => q.calls.filter((c) => c.startsWith("range")));

const STATUSES = ["new", "contacted", "qualified", "appointment", "estimate", "won", "lost"] as const;
const TEMPERATURES = ["hot", "warm", "cold"] as const;
/** 1,500 leads: statuses and temperatures cycle, so every count is exact by construction. */
const periodLeads = (n = 1500) => Array.from({ length: n }, (_, i) => ({ status: STATUSES[i % 7], temperature: TEMPERATURES[i % 3] }));
const countOf = <T>(rows: T[], match: (row: T) => boolean) => rows.filter(match).length;
const ALL_TIME = { label: "all time", from: null, to: null };

// ---------------------------------------------------------------------------
// A + B. getLeadAndPipelineMetrics
// ---------------------------------------------------------------------------

test("lead and pipeline reads page past 1,000 rows, each under a stable order, with no id list and no cap", async () => {
  const leads = periodLeads();
  const open = Array.from({ length: 1200 }, () => ({ estimated_value: 100 }));
  const { supabase, queries } = fakeSupabase((q) => (isPeriodLeads(q) ? { rows: leads } : isOpenLeads(q) ? { rows: open } : {}));
  const result = await getLeadAndPipelineMetrics(supabase, "org-1", ALL_TIME);
  assert.equal(result.failed, false);
  assert.deepEqual(pagesOf(queries, isPeriodLeads), ["range 0 999", "range 1000 1999"]);
  assert.deepEqual(pagesOf(queries, isOpenLeads), ["range 0 999", "range 1000 1999"]);
  for (const q of queries) {
    assert.ok(q.calls.includes("order id"), `${q.calls.join(" / ")}`);
    assert.ok(!q.calls.some((c) => c.startsWith("limit ")), "no capped read");
    assert.ok(!q.calls.some((c) => /^in (id|lead_id|contact_id) /.test(c)), "no id list");
  }
  // The open-lead read keeps its server-side status filter - the definition is unchanged.
  assert.ok(queries.filter(isOpenLeads).every((q) => q.calls.includes('in status ["new","contacted","qualified","appointment","estimate"]')));
});

test("exact totals across 1,500 period leads and 1,200 open leads: total, every stage, every temperature, open count, value and average", async () => {
  const leads = periodLeads();
  const open = Array.from({ length: 1200 }, (_, i) => ({ estimated_value: i % 4 === 0 ? null : 250 }));
  const { supabase } = fakeSupabase((q) => (isPeriodLeads(q) ? { rows: leads } : isOpenLeads(q) ? { rows: open } : {}));
  const { leads: m, pipeline } = await getLeadAndPipelineMetrics(supabase, "org-1", ALL_TIME);
  assert.equal(m.totalLeads, 1500);
  for (const status of STATUSES) assert.equal(m.byStatus[status], countOf(leads, (l) => l.status === status), status);
  for (const temperature of TEMPERATURES) assert.equal(m.byTemperature[temperature], 500, temperature);
  assert.equal(m.openLeads, 1200);
  assert.equal(pipeline.pipelineValue, 900 * 250, "null estimated values add nothing, as before");
});

test("a page-2 failure or the row limit on either read sets failed, and that read contributes no rows - never partial figures", async () => {
  const leads = periodLeads();
  const open = Array.from({ length: 1200 }, () => ({ estimated_value: 100 }));
  for (const [name, failing] of [["period", isPeriodLeads], ["open", isOpenLeads]] as const) {
    for (const failure of [{ failOnPage: 2 }, { rows: Array.from({ length: MAX_ATTRIBUTION_ROWS + 1 }, () => ({ status: "new", temperature: "hot", estimated_value: 1 })) }]) {
      const { supabase } = fakeSupabase((q) => {
        const base = isPeriodLeads(q) ? { rows: leads } : isOpenLeads(q) ? { rows: open } : {};
        return failing(q) ? { ...base, ...failure } : base;
      });
      const result = await getLeadAndPipelineMetrics(supabase, "org-1", ALL_TIME);
      assert.equal(result.failed, true, name);
      if (name === "period") assert.deepEqual([result.leads.totalLeads, result.leads.openLeads, result.pipeline.pipelineValue], [0, 1200, 120_000], "the other read stands");
      else assert.deepEqual([result.leads.totalLeads, result.leads.openLeads, result.pipeline.pipelineValue], [1500, 0, 0], "the other read stands");
    }
  }
});

// ---------------------------------------------------------------------------
// The snapshot: lost rate, the comparison, source counts, partialData, AI input
// ---------------------------------------------------------------------------

const NOW = new Date("2026-09-25T12:00:00Z");
const CURRENT = resolveDateRange("last30Days", NOW);
const isCurrent = (q: Query) => has(q, `gte created_at ${CURRENT.from}`);
const SOURCES = ["Google", " Google ", "Referral", "", "   ", null, "Yelp"];
const sourceLeads = (n = 1500) => Array.from({ length: n }, (_, i) => ({ source: SOURCES[i % SOURCES.length] }));

async function snapshotWith(answer: (q: Query) => Answer) {
  return getBusinessMetricsSnapshot(fakeSupabase(answer).supabase, "org-1", "last30Days", { now: NOW });
}
const baseAnswer = (q: Query): Answer =>
  isPeriodLeads(q) ? { rows: isCurrent(q) ? periodLeads(1500) : periodLeads(1100) } : isSourceLeads(q) ? { rows: sourceLeads() } : {};

test("snapshot: exact lost rate over 1,500 leads, and the lead-count comparison against a complete 1,100-lead previous period", async () => {
  const s = await snapshotWith(baseAnswer);
  const leads = periodLeads(1500);
  const won = countOf(leads, (l) => l.status === "won");
  const lost = countOf(leads, (l) => l.status === "lost");
  assert.equal(s.leadMetrics.totalLeads, 1500);
  assert.equal(s.leadMetrics.lostRate, (lost / (won + lost)) * 100);
  assert.deepEqual(s.comparisons.leadCount, { current: 1500, previous: 1100, change: 400, percentageChange: (400 / 1100) * 100 });
});

test("snapshot: exact open-lead count, value and average over 1,200 open leads", async () => {
  const open = Array.from({ length: 1200 }, (_, i) => ({ estimated_value: i < 600 ? 1000 : 500 }));
  const s = await snapshotWith((q) => (isOpenLeads(q) ? { rows: open } : baseAnswer(q)));
  assert.deepEqual([s.pipelineMetrics.openOpportunityCount, s.pipelineMetrics.pipelineValue, s.pipelineMetrics.averagePipelineValue], [1200, 900_000, 750]);
});

test("snapshot: exact source counts over 1,500 leads - trimmed, case kept, blank and missing as 'unknown'", async () => {
  const s = await snapshotWith(baseAnswer);
  // 1,500 = 214 full cycles of 7 + 2 extra ("Google", " Google ").
  assert.deepEqual(s.leadMetrics.sourceCounts, { Google: 214 * 2 + 2, Referral: 214, unknown: 214 * 3, Yelp: 214 });
  assert.equal(s.sourceCountsUnavailable, false);
});

test("snapshot: a source read failing on page 2 or at the row limit is unavailable with {} counts - partialData and every other figure unchanged", async () => {
  for (const failure of [{ failOnPage: 2 }, { rows: Array.from({ length: MAX_ATTRIBUTION_ROWS + 1 }, () => ({ source: "Google" })) }]) {
    const s = await snapshotWith((q) => (isSourceLeads(q) ? { ...baseAnswer(q), ...failure } : baseAnswer(q)));
    assert.equal(s.sourceCountsUnavailable, true);
    assert.deepEqual(s.leadMetrics.sourceCounts, {});
    assert.deepEqual(buildAiInsightsInput(s).leadMetrics.sourceCounts, {}, "the AI has no source counts to cite");
    assert.equal(s.partialData, false, "a source failure never feeds partialData");
    assert.equal(s.leadMetrics.totalLeads, 1500);
  }
});

test("snapshot: a lead-read failure still reaches partialData through the existing failed flag (semantics unchanged); the AI input field set is unchanged", async () => {
  const s = await snapshotWith((q) => (isPeriodLeads(q) && isCurrent(q) ? { failOnPage: 2, rows: periodLeads() } : baseAnswer(q)));
  assert.equal(s.partialData, true);
  assert.deepEqual(Object.keys(buildAiInsightsInput(s)).sort(), ["aiMetrics", "appointmentMetrics", "automationMetrics", "billingMetrics", "communicationMetrics", "comparisons", "dataQuality", "estimateMetrics", "followUpMetrics", "jobMetrics", "leadMetrics", "period", "pipelineMetrics"]);
  assert.deepEqual(Object.keys(buildAiInsightsInput(s).leadMetrics).sort(), Object.keys(s.leadMetrics).sort());
  assert.ok(!("sourceCountsUnavailable" in buildAiInsightsInput(s)));
  assert.ok(!("sourceCountsUnavailable" in s.leadMetrics));
});

// ---------------------------------------------------------------------------
// Phase 2I follow-up: the AI is told when lead or source figures are zeroed
// ---------------------------------------------------------------------------

const LEAD_NOTE = "Lead and open-lead counts could not be read for this snapshot";
const SOURCE_NOTE = "Lead sources could not be read for this snapshot";
const AI_FIELDS = ["aiMetrics", "appointmentMetrics", "automationMetrics", "billingMetrics", "communicationMetrics", "comparisons", "dataQuality", "estimateMetrics", "followUpMetrics", "jobMetrics", "leadMetrics", "period", "pipelineMetrics"];
const notesOf = (s: Awaited<ReturnType<typeof snapshotWith>>) => buildAiInsightsInput(s).dataQuality.notes;
const hasNote = (notes: string[], prefix: string) => notes.some((n) => n.startsWith(prefix));

test("AI note: a period-lead or open-lead read failing on page 1, page 2 or at the row limit tells the AI the lead figures are zeroed; partialData and the AI field set unchanged", async () => {
  const reads = [
    ["period", (q: Query) => isPeriodLeads(q) && isCurrent(q), { status: "new", temperature: "warm" }],
    ["open", isOpenLeads, { estimated_value: 100 }],
  ] as const;
  for (const [name, failing, row] of reads) {
    for (const failure of [{ error: true }, { failOnPage: 2 }, { rows: Array.from({ length: MAX_ATTRIBUTION_ROWS + 1 }, () => row) }]) {
      const s = await snapshotWith((q) => (failing(q) ? { rows: name === "period" ? periodLeads() : Array.from({ length: 1200 }, () => row), ...failure } : baseAnswer(q)));
      const notes = notesOf(s);
      assert.ok(hasNote(notes, LEAD_NOTE), name);
      assert.ok(!hasNote(notes, SOURCE_NOTE), `${name}: sources were read`);
      assert.equal(s.partialData, true, "the existing failed flag still feeds partialData");
      assert.deepEqual(Object.keys(buildAiInsightsInput(s)).sort(), AI_FIELDS);
    }
  }
});

test("AI note: a source read failing on page 1, page 2 or at the row limit tells the AI sourceCounts is empty because the read failed; partialData and the AI field set unchanged", async () => {
  for (const failure of [{ error: true }, { failOnPage: 2 }, { rows: Array.from({ length: MAX_ATTRIBUTION_ROWS + 1 }, () => ({ source: "Google" })) }]) {
    const s = await snapshotWith((q) => (isSourceLeads(q) ? { ...baseAnswer(q), ...failure } : baseAnswer(q)));
    const notes = notesOf(s);
    assert.ok(hasNote(notes, SOURCE_NOTE));
    assert.ok(!hasNote(notes, LEAD_NOTE), "the lead reads succeeded");
    assert.deepEqual(s.leadMetrics.sourceCounts, {});
    assert.equal(s.partialData, false, "a source failure never feeds partialData");
    assert.deepEqual(Object.keys(buildAiInsightsInput(s)).sort(), AI_FIELDS);
    assert.ok(!("sourceCountsUnavailable" in buildAiInsightsInput(s)));
  }
});

test("AI note: complete reads and a genuinely empty organization get neither note - an empty organization's sourceCounts is {} and not unavailable", async () => {
  const complete = await snapshotWith(baseAnswer);
  assert.ok(!hasNote(notesOf(complete), LEAD_NOTE) && !hasNote(notesOf(complete), SOURCE_NOTE));

  const empty = await snapshotWith(() => ({}));
  assert.ok(!hasNote(notesOf(empty), LEAD_NOTE) && !hasNote(notesOf(empty), SOURCE_NOTE));
  assert.deepEqual(empty.leadMetrics.sourceCounts, {});
  assert.deepEqual([empty.sourceCountsUnavailable, empty.partialData, empty.leadMetrics.totalLeads, empty.pipelineMetrics.pipelineValue], [false, false, 0, 0]);
});

// ---------------------------------------------------------------------------
// D. getLeadsCreatedPerDay
// ---------------------------------------------------------------------------

const CHART = { from: "2026-09-01T06:00:00.000Z", to: "2026-10-01T06:00:00.000Z" };
/** 1,500 leads across September in Denver: 50 a day, at 18:00Z (noon MDT). */
const chartLeads = () => Array.from({ length: 1500 }, (_, i) => ({ created_at: `2026-09-${String(1 + (i % 30)).padStart(2, "0")}T18:00:00+00:00` }));

test("leads per day: 1,500 leads paged past 1,000 - exact daily buckets that add up to the complete count", async () => {
  const { supabase, queries } = fakeSupabase((q) => (isChartLeads(q) ? { rows: chartLeads() } : {}));
  const series = await getLeadsCreatedPerDay(supabase, "org-1", CHART, "America/Denver");
  assert.equal(series.failed, false);
  assert.deepEqual(pagesOf(queries, isChartLeads), ["range 0 999", "range 1000 1999"]);
  assert.equal(series.data.length, 30);
  assert.ok(series.data.every((day) => day.count === 50));
  assert.equal(series.data.reduce((sum, day) => sum + day.count, 0), 1500);
  assert.ok(queries.every((q) => q.calls.includes("order id") && !q.calls.some((c) => c.startsWith("limit "))));
});

test("leads per day: a page-2 failure or the row limit is a failure with no buckets - never a partial chart", async () => {
  for (const failure of [{ failOnPage: 2 }, { rows: Array.from({ length: MAX_ATTRIBUTION_ROWS + 1 }, () => ({ created_at: "2026-09-10T18:00:00+00:00" })) }]) {
    const series = await getLeadsCreatedPerDay(fakeSupabase((q) => (isChartLeads(q) ? { rows: chartLeads(), ...failure } : {})).supabase, "org-1", CHART, "America/Denver");
    assert.deepEqual(series, { data: [], failed: true });
  }
});

test("leads per day: a genuinely empty range is not a failure - every day is a real zero", async () => {
  const series = await getLeadsCreatedPerDay(fakeSupabase().supabase, "org-1", CHART, "America/Denver");
  assert.equal(series.failed, false);
  assert.equal(series.data.length, 30);
  assert.ok(series.data.every((day) => day.count === 0));
});

// ---------------------------------------------------------------------------
// E. Guards
// ---------------------------------------------------------------------------

test("guards: the affected reads use readAllPages with no capped read; partialData inputs are byte-identical to main; the top-8 source trimming is unchanged", () => {
  const body = (file: string, fn: string) => {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    const start = source.indexOf(`async function ${fn}(`);
    return source.slice(start, source.indexOf("\n}\n", start));
  };
  for (const [file, fn] of [["lib/bi/queries.ts", "getLeadAndPipelineMetrics"], ["lib/bi/metrics.ts", "getSourceCounts"], ["lib/bi/series.ts", "getLeadsCreatedPerDay"]]) {
    const code = body(file, fn);
    assert.match(code, /readAllPages</, fn);
    assert.doesNotMatch(code, /\.limit\(/, fn);
    assert.match(code, /\.order\("id"\)/, fn);
  }
  const partialData = (source: string) => source.slice(source.indexOf("const partialDataSourceCount"), source.indexOf(".length;", source.indexOf("const partialDataSourceCount")));
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  const main = execFileSync("git", ["show", "59ed381c4195e07f0ba42446fd37a6b619a5f309:lib/bi/metrics.ts"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(partialData(fs.readFileSync(path.join(ROOT, "lib/bi/metrics.ts"), "utf8")), partialData(main));
  assert.match(fs.readFileSync(path.join(ROOT, "app/(app)/insights/_components/business-metrics-sections.tsx"), "utf8"), /\.sort\(\(\[, a\], \[, b\]\) => b - a\)\s*\.slice\(0, 8\)/);
});

/**
 * Phase 3A-1: the core snapshot reads - getEstimateMetrics, getJobMetrics,
 * getAppointmentMetrics, getAiMetrics, and (through the snapshot and
 * buildAiMetrics) the accepted-estimate -> job, AI output and AI token reads -
 * against a fake Supabase client that, like the real API, returns at most
 * 1,000 rows to a request that isn't paged. Every read must be complete at
 * 999, exactly 1,000 and 2,500 rows (key statuses placed after row 1,000), in
 * any row order; a failed page or the row limit must be a failure with no
 * partial rows, and a genuinely empty result a real zero. Paging must feed
 * the existing failure flags, so Phase 3C's notes still fire; partialData
 * inputs and the AI field set are unchanged.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/bi/core-reads.scale.test.ts
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
const { getEstimateMetrics, getJobMetrics, getAppointmentMetrics, getAiMetrics }: typeof import("./queries") = require(path.join(ROOT, "lib/bi/queries.ts"));
const { getBusinessMetricsSnapshot, buildAiMetrics }: typeof import("./metrics") = require(path.join(ROOT, "lib/bi/metrics.ts"));
const { buildAiInsightsInput }: typeof import("./insights") = require(path.join(ROOT, "lib/bi/insights.ts"));
const { MAX_ATTRIBUTION_ROWS }: typeof import("./revenue-attribution") = require(path.join(ROOT, "lib/bi/revenue-attribution.ts"));

type Query = { table: string; calls: string[] };
type Answer = { rows?: unknown[]; error?: boolean; failOnPage?: number };

/** The Phase 2F-2K fake client with the API's cap: a request that isn't paged gets at most 1,000 rows. */
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

const selects = (q: Query, table: string, columns: string) => q.table === table && q.calls.includes(`select ${columns}`);
const isEstimates = (q: Query) => selects(q, "estimates", "status, amount");
const isAcceptedEstimateJobs = (q: Query) => q.table === "estimates" && q.calls.some((c) => c.startsWith("select id, jobs!"));
const isJobs = (q: Query) => selects(q, "jobs", "status, amount");
const isAppointments = (q: Query) => selects(q, "appointments", "status");
const isAiInteractions = (q: Query) => selects(q, "ai_interactions", "interaction_type, model");
const isAiOutputs = (q: Query) => selects(q, "ai_interactions", "interaction_type, output");
const isAiTokens = (q: Query) => selects(q, "ai_interactions", "tokens_used");
const pagesOf = (queries: Query[], match: (q: Query) => boolean) => queries.filter(match).flatMap((q) => q.calls.filter((c) => c.startsWith("range")));
const EXPECTED_PAGES: Record<number, string[]> = {
  999: ["range 0 999"],
  1000: ["range 0 999", "range 1000 1999"],
  2500: ["range 0 999", "range 1000 1999", "range 2000 2999"],
};
const count = <T>(rows: T[], match: (row: T) => boolean) => rows.filter(match).length;
const total = (rows: { amount: number | null }[]) => rows.reduce((sum, row) => sum + (row.amount ?? 0), 0);
const ALL_TIME = { label: "all time", from: null, to: null };

/** Deterministic shuffle (a fixed-seed LCG) - same input, same output, every run. */
function shuffled<T>(rows: T[]): T[] {
  const out = [...rows];
  let seed = 42;
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Row builders: the first 1,000 rows carry one ordinary status; every row
// past 1,000 cycles through the statuses a capped read used to drop.
const estimates = (n: number) => Array.from({ length: n }, (_, i) => (i < 1000 ? { status: "sent", amount: 100 } : { status: ["accepted", "declined", "expired"][i % 3], amount: i % 4 === 0 ? null : 250 }));
const jobs = (n: number) => Array.from({ length: n }, (_, i) => (i < 1000 ? { status: "scheduled", amount: 500 } : { status: ["completed", "cancelled", "in_progress"][i % 3], amount: 1000 }));
const appointments = (n: number) => Array.from({ length: n }, (_, i) => ({ status: i < 1000 ? "scheduled" : ["completed", "no_show", "cancelled"][i % 3] }));
const aiInteractions = (n: number) => Array.from({ length: n }, (_, i) => ({ interaction_type: i < 1000 ? "lead_followup" : "customer_reply_response", model: i % 5 === 0 ? null : "claude" }));
const aiOutputs = (n: number) => Array.from({ length: n }, (_, i) => ({ interaction_type: i < 1000 ? "lead_followup" : "customer_reply_response", output: i < 1000 ? { should_send: false } : { should_send: true, needs_human: i % 2 === 0 } }));
const aiTokens = (n: number) => Array.from({ length: n }, (_, i) => ({ tokens_used: i < 1000 ? 10 : 30 }));

// ---------------------------------------------------------------------------
// The four exported query functions: 999 / 1,000 / 2,500 rows, any order
// ---------------------------------------------------------------------------

test("getEstimateMetrics: complete at 999, exactly 1,000 and 2,500 rows (accepted/declined/expired only past row 1,000), in any order, paged by id", async () => {
  for (const n of [999, 1000, 2500]) {
    for (const rows of [estimates(n), shuffled(estimates(n))]) {
      const { supabase, queries } = fakeSupabase((q) => (isEstimates(q) ? { rows } : {}));
      const m = await getEstimateMetrics(supabase, "org-1", ALL_TIME);
      assert.equal(m.failed, false, `${n}`);
      assert.deepEqual(pagesOf(queries, isEstimates), EXPECTED_PAGES[n], `${n} pages`);
      assert.deepEqual([m.totalEstimates, m.sentEstimates, m.acceptedEstimates, m.declinedEstimates, m.expiredEstimates], [n, ...["sent", "accepted", "declined", "expired"].map((s) => count(rows, (r) => r.status === s))]);
      assert.deepEqual([m.totalEstimateValue, m.acceptedEstimateValue], [total(rows), total(rows.filter((r) => r.status === "accepted"))]);
    }
  }
});

test("getJobMetrics: complete at 999, exactly 1,000 and 2,500 rows (completed/cancelled only past row 1,000), in any order, paged by id", async () => {
  for (const n of [999, 1000, 2500]) {
    for (const rows of [jobs(n), shuffled(jobs(n))]) {
      const { supabase, queries } = fakeSupabase((q) => (isJobs(q) ? { rows } : {}));
      const m = await getJobMetrics(supabase, "org-1", ALL_TIME);
      assert.equal(m.failed, false, `${n}`);
      assert.deepEqual(pagesOf(queries, isJobs), EXPECTED_PAGES[n], `${n} pages`);
      assert.deepEqual([m.totalJobs, m.scheduledJobs, m.completedJobs, m.cancelledJobs, m.inProgressJobs], [n, ...["scheduled", "completed", "cancelled", "in_progress"].map((s) => count(rows, (r) => r.status === s))]);
      assert.deepEqual([m.totalContractedJobValue, m.completedContractedJobValue], [total(rows), total(rows.filter((r) => r.status === "completed"))]);
    }
  }
});

test("getAppointmentMetrics: complete at 999, exactly 1,000 and 2,500 rows (completed/no-show/cancelled only past row 1,000), in any order, paged by id", async () => {
  for (const n of [999, 1000, 2500]) {
    for (const rows of [appointments(n), shuffled(appointments(n))]) {
      const { supabase, queries } = fakeSupabase((q) => (isAppointments(q) ? { rows } : {}));
      const m = await getAppointmentMetrics(supabase, "org-1", ALL_TIME);
      assert.equal(m.failed, false, `${n}`);
      assert.deepEqual(pagesOf(queries, isAppointments), EXPECTED_PAGES[n], `${n} pages`);
      assert.deepEqual([m.totalAppointments, m.scheduledAppointments, m.completedAppointments, m.noShowAppointments, m.cancelledAppointments], [n, ...["scheduled", "completed", "no_show", "cancelled"].map((s) => count(rows, (r) => r.status === s))]);
    }
  }
});

test("getAiMetrics: complete at 999, exactly 1,000 and 2,500 rows (customer replies only past row 1,000), in any order, paged by id", async () => {
  for (const n of [999, 1000, 2500]) {
    for (const rows of [aiInteractions(n), shuffled(aiInteractions(n))]) {
      const { supabase, queries } = fakeSupabase((q) => (isAiInteractions(q) ? { rows } : {}));
      const m = await getAiMetrics(supabase, "org-1", ALL_TIME);
      assert.equal(m.failed, false, `${n}`);
      assert.deepEqual(pagesOf(queries, isAiInteractions), EXPECTED_PAGES[n], `${n} pages`);
      assert.equal(m.totalAiInteractions, n);
      assert.equal(m.aiInteractionsByType.customer_reply_response ?? 0, count(rows, (r) => r.interaction_type === "customer_reply_response"));
      assert.equal(m.aiInteractionsByModel.unknown ?? 0, count(rows, (r) => r.model === null));
    }
  }
});

// ---------------------------------------------------------------------------
// The private reads, through buildAiMetrics and the snapshot
// ---------------------------------------------------------------------------

test("AI output and token reads (via buildAiMetrics): complete at 999, exactly 1,000 and 2,500 rows, in any order, paged by id", async () => {
  for (const n of [999, 1000, 2500]) {
    for (const order of [(r: unknown[]) => r, shuffled]) {
      const outputs = order(aiOutputs(n)) as ReturnType<typeof aiOutputs>;
      const tokens = order(aiTokens(n)) as ReturnType<typeof aiTokens>;
      const { supabase, queries } = fakeSupabase((q) => (isAiInteractions(q) ? { rows: aiInteractions(n) } : isAiOutputs(q) ? { rows: outputs } : isAiTokens(q) ? { rows: tokens } : {}));
      const { metrics, failed } = await buildAiMetrics(supabase, "org-1", ALL_TIME);
      assert.equal(failed, false, `${n}`);
      for (const match of [isAiOutputs, isAiTokens]) assert.deepEqual(pagesOf(queries, match), EXPECTED_PAGES[n], `${n} pages`);
      assert.deepEqual([metrics.aiOutboundInteractions, metrics.aiNeedsHumanCount, metrics.customerReplyAiInteractions], [
        count(outputs, (r) => r.output.should_send === true),
        count(outputs, (r) => (r.output as { needs_human?: boolean }).needs_human === true),
        count(outputs, (r) => r.interaction_type === "customer_reply_response"),
      ]);
      const tokenTotal = tokens.reduce((sum, r) => sum + r.tokens_used, 0);
      assert.deepEqual([metrics.totalTokensUsed, metrics.interactionsWithUsageData, metrics.averageTokensPerInteraction], [tokenTotal, n, tokenTotal / n]);
    }
  }
});

test("accepted-estimate -> job read (via the snapshot): 2,500 accepted estimates, the ones with a job only past row 1,000, give the complete Estimate -> job rate", async () => {
  const acceptedRows = Array.from({ length: 2500 }, (_, i) => ({ id: `e${i}`, jobs: i >= 1000 && i % 2 === 0 ? [{ id: `j${i}` }] : [] }));
  const accepted = Array.from({ length: 2500 }, () => ({ status: "accepted", amount: 100 }));
  for (const rows of [acceptedRows, shuffled(acceptedRows)]) {
    const { supabase, queries } = fakeSupabase((q) => (isAcceptedEstimateJobs(q) ? { rows } : isEstimates(q) ? { rows: accepted } : {}));
    const s = await getBusinessMetricsSnapshot(supabase, "org-1", "allTime", { now: new Date("2026-09-25T12:00:00Z") });
    assert.deepEqual(pagesOf(queries, isAcceptedEstimateJobs), EXPECTED_PAGES[2500]);
    assert.equal(s.estimateMetrics.estimateToJobRate, (750 / 2500) * 100);
  }
});

// ---------------------------------------------------------------------------
// Failure vs genuine empty
// ---------------------------------------------------------------------------

const RUNS: [string, (supabase: SupabaseClient) => Promise<{ failed: boolean; zero: number }>, (q: Query) => boolean, (n: number) => unknown[]][] = [
  ["estimates", async (s) => { const m = await getEstimateMetrics(s, "org-1", ALL_TIME); return { failed: m.failed, zero: m.totalEstimates + m.totalEstimateValue }; }, isEstimates, estimates],
  ["jobs", async (s) => { const m = await getJobMetrics(s, "org-1", ALL_TIME); return { failed: m.failed, zero: m.totalJobs + m.totalContractedJobValue }; }, isJobs, jobs],
  ["appointments", async (s) => { const m = await getAppointmentMetrics(s, "org-1", ALL_TIME); return { failed: m.failed, zero: m.totalAppointments }; }, isAppointments, appointments],
  ["AI interactions", async (s) => { const m = await getAiMetrics(s, "org-1", ALL_TIME); return { failed: m.failed, zero: m.totalAiInteractions }; }, isAiInteractions, aiInteractions],
  ["AI outputs", async (s) => { const { metrics, failed } = await buildAiMetrics(s, "org-1", ALL_TIME); return { failed, zero: metrics.aiOutboundInteractions + metrics.customerReplyAiInteractions }; }, isAiOutputs, aiOutputs],
  ["AI tokens", async (s) => { const { metrics, failed } = await buildAiMetrics(s, "org-1", ALL_TIME); return { failed, zero: (metrics.totalTokensUsed ?? 0) + metrics.interactionsWithUsageData }; }, isAiTokens, aiTokens],
];

test("a page-1 error, a page-2 error or the row limit is failed with no partial rows used; a genuinely empty result is a real zero", async () => {
  for (const [name, run, match, build] of RUNS) {
    for (const failure of [{ error: true, rows: build(2500) }, { failOnPage: 2, rows: build(2500) }, { rows: build(MAX_ATTRIBUTION_ROWS + 1) }]) {
      const result = await run(fakeSupabase((q) => (match(q) ? failure : {})).supabase);
      assert.equal(result.failed, true, name);
      assert.equal(result.zero, 0, `${name}: no partial rows are counted`);
    }
    const empty = await run(fakeSupabase().supabase);
    assert.deepEqual(empty, { failed: false, zero: 0 }, `${name}: genuine empty`);
  }
});

// ---------------------------------------------------------------------------
// Phase 3C: paging failures reach the existing disclosure
// ---------------------------------------------------------------------------

const NOTE = {
  estimates: "Estimate counts could not be read for this snapshot",
  jobs: "Job counts could not be read for this snapshot",
  appointments: "Appointment counts could not be read for this snapshot",
  ai: "AI interaction counts could not be read for this snapshot",
};
const AI_FIELDS = ["aiMetrics", "appointmentMetrics", "automationMetrics", "billingMetrics", "communicationMetrics", "comparisons", "dataQuality", "estimateMetrics", "followUpMetrics", "jobMetrics", "leadMetrics", "period", "pipelineMetrics"];

test("Phase 3C: a page-2 failure or the row limit on any paged read gives that family's existing note; the AI field set is unchanged", async () => {
  const families: [(q: Query) => boolean, (n: number) => unknown[], keyof typeof NOTE][] = [
    [isEstimates, estimates, "estimates"],
    [isAcceptedEstimateJobs, (n) => Array.from({ length: n }, (_, i) => ({ id: `e${i}`, jobs: [] })), "estimates"],
    [isJobs, jobs, "jobs"],
    [isAppointments, appointments, "appointments"],
    [isAiInteractions, aiInteractions, "ai"],
    [isAiOutputs, aiOutputs, "ai"],
    [isAiTokens, aiTokens, "ai"],
  ];
  for (const [match, build, family] of families) {
    for (const failure of [{ failOnPage: 2, rows: build(2500) }, { rows: build(MAX_ATTRIBUTION_ROWS + 1) }]) {
      const s = await getBusinessMetricsSnapshot(fakeSupabase((q) => (match(q) ? failure : {})).supabase, "org-1", "last30Days", { now: new Date("2026-09-25T12:00:00Z") });
      const notes = buildAiInsightsInput(s).dataQuality.notes;
      assert.ok(notes.some((n) => n.startsWith(NOTE[family])), family);
      assert.equal(s.partialData, true, `${family}: the existing failed flag still feeds partialData`);
      assert.deepEqual(Object.keys(buildAiInsightsInput(s)).sort(), AI_FIELDS);
    }
  }
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

test("guards: the seven reads use readAllPages with a stable id order and no capped read; partialData inputs are byte-identical to main", () => {
  const body = (file: string, fn: string) => {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    const start = source.indexOf(`async function ${fn}(`);
    assert.ok(start >= 0, fn);
    return source.slice(start, source.indexOf("\n}\n", start));
  };
  const reads: [string, string][] = [
    ["lib/bi/queries.ts", "getEstimateMetrics"],
    ["lib/bi/queries.ts", "getJobMetrics"],
    ["lib/bi/queries.ts", "getAppointmentMetrics"],
    ["lib/bi/queries.ts", "getAiMetrics"],
    ["lib/bi/metrics.ts", "getAcceptedEstimateJobRows"],
    ["lib/bi/metrics.ts", "getAiOutputFields"],
    ["lib/bi/metrics.ts", "getAiUsageTotals"],
  ];
  for (const [file, fn] of reads) {
    const code = body(file, fn);
    assert.match(code, /readAllPages</, fn);
    assert.match(code, /\.order\("id"\)/, fn);
    assert.doesNotMatch(code, /\.limit\(/, fn);
  }
  const partialData = (source: string) => source.slice(source.indexOf("const partialDataSourceCount"), source.indexOf(".length;", source.indexOf("const partialDataSourceCount")));
  const main = execFileSync("git", ["show", "cc25606a8759be4ec896986877d618bb5de92ffd:lib/bi/metrics.ts"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(partialData(fs.readFileSync(path.join(ROOT, "lib/bi/metrics.ts"), "utf8")), partialData(main));
});

/**
 * Trackpr 2.0, Phase 4B (P1 #1 + P1 #2): unit tests for the 5 lib/bi/queries.ts
 * functions touched by this phase, against a hand-built mocked Supabase
 * client - no real database. Mirrors this codebase's own established
 * mocked-client pattern (lib/dashboard/queries.partial-data.test.ts,
 * lib/automation/executions.test.ts).
 *
 * Two things are proven per function:
 *   - `failed` is true only on a real Postgrest error, never on a genuinely
 *     empty `{ data: [], error: null }` response ("no data" and "the read
 *     failed" remain two different things).
 *   - getLeadAndPipelineMetrics specifically: pipeline value and open
 *     opportunity count are computed from an unbounded read, completely
 *     independent of whatever the period-scoped read returns - an open lead
 *     the period read never saw (because it was created outside the
 *     requested range) still counts.
 *
 * The mock is call-order (queue) based per table, not a single fixed value
 * per table like the Dashboard version - getLeadAndPipelineMetrics
 * deliberately issues two separate `leads` reads (the period-scoped one,
 * then the unbounded pipeline one), and a test proving they're independent
 * needs to give each call its own, different data.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/bi/queries.partial-data.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { getLeadAndPipelineMetrics, getEstimateMetrics, getJobMetrics, getAppointmentMetrics, getAiMetrics }: typeof import("./queries") = require("./queries.ts");

type MockResult = { data: unknown; error: { message: string; code?: string } | null };

const ALL_TIME = { label: "All time", from: null, to: null };
const LAST_30_DAYS = { label: "Last 30 days", from: "2026-08-26T00:00:00.000Z", to: "2026-09-25T00:00:00.000Z" };

/**
 * Unlike lib/dashboard/queries.partial-data.test.ts's builder (where every
 * real call chain ends in `.limit()`/`.maybeSingle()` last), lib/bi/queries.ts
 * sometimes calls `.gte()`/`.lt()` AFTER `.limit()` (see
 * getLeadAndPipelineMetrics) - so `.limit()` here stays chainable (returns
 * the builder, never resolves) and the builder itself is made thenable
 * instead, resolving to `result` regardless of which method was called
 * last. This also lets a `{ count: "exact", head: true }` query (never
 * calling `.limit()`/`.maybeSingle()` at all) resolve correctly on a plain
 * `await`.
 */
function makeQueryBuilder(result: MockResult) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    not: () => builder,
    order: () => builder,
    gte: () => builder,
    lt: () => builder,
    limit: () => builder,
    maybeSingle: () => Promise.resolve(result),
    then: (resolve: (value: MockResult) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
  };
  return builder;
}

/** Queues results per table, consumed in call order - see this file's own header comment for why. A table with no queue left, or none configured at all, falls back to a genuinely empty success. */
function makeMockSupabase(queues: Partial<Record<string, MockResult[]>>): SupabaseClient {
  const remaining: Partial<Record<string, MockResult[]>> = Object.fromEntries(Object.entries(queues).map(([table, results]) => [table, [...(results ?? [])]]));
  return {
    from: (table: string) => {
      const queue = remaining[table];
      const result = queue && queue.length > 0 ? queue.shift()! : { data: [], error: null };
      return makeQueryBuilder(result);
    },
  } as unknown as SupabaseClient;
}

// ---------------------------------------------------------------------------
// getLeadAndPipelineMetrics - P1 #1 (current-state pipeline) + P1 #2 (failed)
// ---------------------------------------------------------------------------

test("P1 #1: an open lead created outside the selected date range is still included in pipeline value and open opportunity count", async () => {
  const supabase = makeMockSupabase({
    leads: [
      // 1st call: the period-scoped read (LAST_30_DAYS) - only "new" leads created in range, nothing open/valuable here.
      { data: [{ status: "new", temperature: "warm" }], error: null },
      // 2nd call: the unbounded pipeline read - an open lead that would have been excluded by LAST_30_DAYS's created_at filter, plus one more.
      {
        data: [
          { estimated_value: 12000 },
          { estimated_value: 3000 },
        ],
        error: null,
      },
    ],
  });

  const { leads, pipeline, failed } = await getLeadAndPipelineMetrics(supabase, "org-1", LAST_30_DAYS);

  assert.equal(failed, false);
  assert.equal(pipeline.pipelineValue, 15000, "pipeline value must reflect the unbounded read, not the period-scoped one");
  assert.equal(leads.openLeads, 2, "open opportunity count must reflect the unbounded read, not the period-scoped one");
  // The period-scoped LeadMetrics fields are legitimately period-scoped and must still reflect only what the period read returned.
  assert.equal(leads.totalLeads, 1);
  assert.equal(leads.newLeads, 1);
});

test("P1 #1: legitimately period-scoped lead metrics (newLeads, byStatus, totalLeads) remain scoped to the selected range - unaffected by this fix", async () => {
  const supabase = makeMockSupabase({
    leads: [
      { data: [{ status: "contacted", temperature: "hot" }, { status: "won", temperature: "cold" }], error: null },
      { data: [], error: null }, // unbounded pipeline read: nothing currently open
    ],
  });

  const { leads, pipeline } = await getLeadAndPipelineMetrics(supabase, "org-1", LAST_30_DAYS);

  assert.equal(leads.totalLeads, 2);
  assert.equal(leads.contactedLeads, 1);
  assert.equal(leads.wonLeads, 1);
  assert.equal(leads.hotLeads, 1);
  assert.equal(leads.coldLeads, 1);
  // Pipeline correctly reflects genuine current emptiness, not a fabricated non-zero.
  assert.equal(pipeline.pipelineValue, 0);
  assert.equal(leads.openLeads, 0);
});

test("P1 #1: pipeline is unbounded even when the caller requests allTime - no regression for the one range that was already correct", async () => {
  const supabase = makeMockSupabase({
    leads: [
      { data: [{ status: "qualified", temperature: "hot" }], error: null },
      { data: [{ estimated_value: 5000 }], error: null },
    ],
  });

  const { pipeline } = await getLeadAndPipelineMetrics(supabase, "org-1", ALL_TIME);
  assert.equal(pipeline.pipelineValue, 5000);
});

test("P1 #2: a genuinely empty, successful result on both leads reads never sets failed", async () => {
  const supabase = makeMockSupabase({ leads: [{ data: [], error: null }, { data: [], error: null }] });
  const { failed, pipeline, leads } = await getLeadAndPipelineMetrics(supabase, "org-1", LAST_30_DAYS);
  assert.equal(failed, false);
  assert.equal(pipeline.pipelineValue, 0);
  assert.equal(leads.openLeads, 0);
});

test("P1 #2: a real Postgrest error on the period-scoped read sets failed, without crashing or fabricating pipeline data", async () => {
  const supabase = makeMockSupabase({
    leads: [
      { data: null, error: { message: "connection reset" } },
      { data: [{ estimated_value: 1000 }], error: null },
    ],
  });
  const { failed, pipeline } = await getLeadAndPipelineMetrics(supabase, "org-1", LAST_30_DAYS);
  assert.equal(failed, true);
  assert.equal(pipeline.pipelineValue, 1000, "the OTHER read's real data must still be reflected, not discarded just because its sibling failed");
});

test("P1 #2: a real Postgrest error on the unbounded pipeline read sets failed and never fabricates a pipeline value", async () => {
  const supabase = makeMockSupabase({
    leads: [
      { data: [{ status: "new", temperature: "warm" }], error: null },
      { data: null, error: { message: "timeout" } },
    ],
  });
  const { failed, pipeline, leads } = await getLeadAndPipelineMetrics(supabase, "org-1", LAST_30_DAYS);
  assert.equal(failed, true);
  assert.equal(pipeline.pipelineValue, 0, "never a fabricated non-zero pipeline value on a failed read - falls back to a real, honest zero, disclosed via `failed`");
  assert.equal(leads.openLeads, 0);
});

// ---------------------------------------------------------------------------
// getEstimateMetrics / getJobMetrics / getAppointmentMetrics / getAiMetrics
// ---------------------------------------------------------------------------

test("getEstimateMetrics: genuine emptiness vs. a real error are distinguishable, and null amounts never become $0 in the average", async () => {
  const empty = makeMockSupabase({ estimates: [{ data: [], error: null }] });
  const emptyResult = await getEstimateMetrics(empty, "org-1", LAST_30_DAYS);
  assert.equal(emptyResult.failed, false);
  assert.equal(emptyResult.totalEstimateValue, 0);

  const failing = makeMockSupabase({ estimates: [{ data: null, error: { message: "err" } }] });
  const failingResult = await getEstimateMetrics(failing, "org-1", LAST_30_DAYS);
  assert.equal(failingResult.failed, true);
  assert.equal(failingResult.totalEstimates, 0);

  const withNullAmount = makeMockSupabase({
    estimates: [{ data: [{ status: "sent", amount: 500 }, { status: "sent", amount: null }], error: null }],
  });
  const valid = await getEstimateMetrics(withNullAmount, "org-1", LAST_30_DAYS);
  assert.equal(valid.failed, false);
  assert.equal(valid.averageEstimateValue, 500, "a null amount must be excluded from the average, never coerced to 0");
  assert.equal(valid.sentEstimateValue, 500);
});

test("getJobMetrics: genuine emptiness vs. a real error are distinguishable, and existing valid data produces unchanged metrics", async () => {
  const failing = makeMockSupabase({ jobs: [{ data: null, error: { message: "err" } }] });
  const failingResult = await getJobMetrics(failing, "org-1", LAST_30_DAYS);
  assert.equal(failingResult.failed, true);
  assert.equal(failingResult.totalContractedJobValue, 0);

  const valid = makeMockSupabase({
    jobs: [{ data: [{ status: "completed", amount: 2000 }, { status: "scheduled", amount: null }], error: null }],
  });
  const validResult = await getJobMetrics(valid, "org-1", LAST_30_DAYS);
  assert.equal(validResult.failed, false);
  assert.equal(validResult.completedContractedJobValue, 2000);
  assert.equal(validResult.totalJobs, 2);
  assert.equal(validResult.averageContractedJobValue, 2000, "the null-amount job must be excluded from the average, never coerced to 0");
});

test("getAppointmentMetrics: genuine emptiness vs. a real error are distinguishable", async () => {
  const empty = makeMockSupabase({ appointments: [{ data: [], error: null }] });
  assert.equal((await getAppointmentMetrics(empty, "org-1", LAST_30_DAYS)).failed, false);

  const failing = makeMockSupabase({ appointments: [{ data: null, error: { message: "err" } }] });
  const failingResult = await getAppointmentMetrics(failing, "org-1", LAST_30_DAYS);
  assert.equal(failingResult.failed, true);
  assert.equal(failingResult.totalAppointments, 0);
});

test("getAiMetrics: genuine emptiness vs. a real error are distinguishable", async () => {
  const empty = makeMockSupabase({ ai_interactions: [{ data: [], error: null }] });
  assert.equal((await getAiMetrics(empty, "org-1", LAST_30_DAYS)).failed, false);

  const failing = makeMockSupabase({ ai_interactions: [{ data: null, error: { message: "err" } }] });
  const failingResult = await getAiMetrics(failing, "org-1", LAST_30_DAYS);
  assert.equal(failingResult.failed, true);
  assert.equal(failingResult.totalAiInteractions, 0);
});

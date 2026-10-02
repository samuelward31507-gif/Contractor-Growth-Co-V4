/**
 * Unit tests for loadAiTokenBreakdown's zero-vs-unavailable contract,
 * against a hand-built mocked Supabase client - no real database. Mirrors
 * lib/agency/usage.partial-data.test.ts's exact technique (itself mirroring
 * lib/dashboard/queries.partial-data.test.ts): the mock replaces only the
 * `{ data, error }` response at the wire boundary, never the function's own
 * logic. Scoped to just this one function/table (ai_interactions) rather
 * than the full BusinessMetricsSnapshot fan-out getAgencyCostReadiness also
 * depends on - see cost-readiness.integration.test.ts for the real-DB,
 * real-field verification of the rest of that fan-out.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/agency/cost-readiness.partial-data.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { loadAiTokenBreakdown }: typeof import("./cost-readiness") = require("./cost-readiness.ts");

type MockResult = { data: unknown; error: { message: string } | null };

function makeMockSupabase(result: MockResult): SupabaseClient {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    gte: () => builder,
    lt: () => builder,
    order: () => builder,
    limit: () => Promise.resolve(result),
    // Phase 3A-3a: paged reads (readAllPages) resolve through range().
    range: () => Promise.resolve(result),
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

const NO_RANGE = { from: null, to: null, label: "all time" };

test("1. a genuinely empty, successful result leaves every requested organization at null/null - no interaction reported usage, never a fabricated 0", async () => {
  const supabase = makeMockSupabase({ data: [], error: null });
  const result = await loadAiTokenBreakdown(supabase, ["org-1", "org-2"], NO_RANGE);

  assert.equal(result.failed, false);
  assert.deepEqual(result.byOrganization.get("org-1"), { inputTokens: null, outputTokens: null });
  assert.deepEqual(result.byOrganization.get("org-2"), { inputTokens: null, outputTokens: null });
});

test("2. real rows sum input/output tokens correctly per organization, independently of each other", async () => {
  const supabase = makeMockSupabase({
    data: [
      { organization_id: "org-1", output: { usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } },
      { organization_id: "org-1", output: { usage: { input_tokens: 50, output_tokens: null, total_tokens: null } } },
      { organization_id: "org-2", output: { usage: { input_tokens: null, output_tokens: 30, total_tokens: null } } },
    ],
    error: null,
  });
  const result = await loadAiTokenBreakdown(supabase, ["org-1", "org-2"], NO_RANGE);

  assert.equal(result.failed, false);
  assert.deepEqual(result.byOrganization.get("org-1"), { inputTokens: 150, outputTokens: 20 }, "org-1's outputTokens must come only from the one row that reported it, and inputTokens must sum both rows that reported it");
  assert.deepEqual(result.byOrganization.get("org-2"), { inputTokens: null, outputTokens: 30 });
});

test("3. a real Postgrest error sets failed=true and returns no fabricated per-organization data", async () => {
  const supabase = makeMockSupabase({ data: null, error: { message: "connection reset by peer" } });
  const result = await loadAiTokenBreakdown(supabase, ["org-1"], NO_RANGE);

  assert.equal(result.failed, true);
  assert.equal(result.byOrganization.size, 0);
});

test("4. an empty organization id list short-circuits without querying, and is never itself a failure", async () => {
  const supabase = makeMockSupabase({ data: null, error: { message: "should never be reached" } });
  const result = await loadAiTokenBreakdown(supabase, [], NO_RANGE);

  assert.equal(result.failed, false);
  assert.equal(result.byOrganization.size, 0);
});

test("5. a malformed output value on one row never throws and never corrupts a sibling organization's real totals", async () => {
  const supabase = makeMockSupabase({
    data: [
      { organization_id: "org-1", output: "not an object" },
      { organization_id: "org-2", output: { usage: { input_tokens: 75, output_tokens: 25, total_tokens: 100 } } },
    ],
    error: null,
  });
  const result = await loadAiTokenBreakdown(supabase, ["org-1", "org-2"], NO_RANGE);

  assert.equal(result.failed, false);
  assert.deepEqual(result.byOrganization.get("org-1"), { inputTokens: null, outputTokens: null });
  assert.deepEqual(result.byOrganization.get("org-2"), { inputTokens: 75, outputTokens: 25 });
});

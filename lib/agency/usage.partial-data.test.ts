/**
 * Unit tests for loadMissedCallCounts's zero-vs-unavailable contract,
 * against a hand-built mocked Supabase client - no real database. Mirrors
 * this codebase's own established technique for exactly this problem (see
 * lib/dashboard/queries.partial-data.test.ts and
 * lib/agency/expansion.partial-data.test.ts): the mock replaces only the
 * `{ data, error }` response at the wire boundary, never the function's own
 * logic. Scoped to just this one function/table (automation_events) rather
 * than the full BusinessMetricsSnapshot fan-out getAgencyUsageSummary also
 * depends on - see usage.integration.test.ts for the real-DB, real-field
 * verification of the rest of that fan-out.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/agency/usage.partial-data.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { loadMissedCallCounts }: typeof import("./usage") = require("./usage.ts");

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

test("1. a genuinely empty, successful result is 0 missed calls for every requested organization, never 'failed'", async () => {
  const supabase = makeMockSupabase({ data: [], error: null });
  const result = await loadMissedCallCounts(supabase, ["org-1", "org-2"], NO_RANGE);

  assert.equal(result.failed, false);
  assert.equal(result.byOrganization.size, 0, "no rows means no organization gets an entry - callers must default a missing org to 0, never assume the map is exhaustive");
});

test("2. real rows are counted per organization_id correctly", async () => {
  const supabase = makeMockSupabase({
    data: [{ organization_id: "org-1" }, { organization_id: "org-1" }, { organization_id: "org-2" }],
    error: null,
  });
  const result = await loadMissedCallCounts(supabase, ["org-1", "org-2"], NO_RANGE);

  assert.equal(result.failed, false);
  assert.equal(result.byOrganization.get("org-1"), 2);
  assert.equal(result.byOrganization.get("org-2"), 1);
});

test("3. a real Postgrest error sets failed=true and never fabricates partial counts", async () => {
  const supabase = makeMockSupabase({ data: null, error: { message: "connection reset by peer" } });
  const result = await loadMissedCallCounts(supabase, ["org-1"], NO_RANGE);

  assert.equal(result.failed, true);
  assert.equal(result.byOrganization.size, 0);
});

test("4. an empty organization id list short-circuits without querying, and is never itself a failure", async () => {
  const supabase = makeMockSupabase({ data: null, error: { message: "should never be reached" } });
  const result = await loadMissedCallCounts(supabase, [], NO_RANGE);

  assert.equal(result.failed, false);
  assert.equal(result.byOrganization.size, 0);
});

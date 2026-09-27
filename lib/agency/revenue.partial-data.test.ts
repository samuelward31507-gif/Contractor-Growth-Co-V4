/**
 * Unit tests for loadRevenueEvents's zero-vs-failure contract, against a
 * hand-built mocked Supabase client - no real database. Mirrors
 * lib/agency/cost-readiness.partial-data.test.ts's exact technique (itself
 * mirroring lib/dashboard/queries.partial-data.test.ts): the mock replaces
 * only the `{ data, error }` response at the wire boundary, never the
 * function's own logic.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/agency/revenue.partial-data.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { loadRevenueEvents }: typeof import("./revenue") = require("./revenue.ts");

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
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

const NO_RANGE = { from: null, to: null, label: "all time" };

test("1. a genuinely empty, successful result returns failed=false and an empty row list - never a fabricated row", async () => {
  const supabase = makeMockSupabase({ data: [], error: null });
  const result = await loadRevenueEvents(supabase, ["org-1"], NO_RANGE);

  assert.equal(result.failed, false);
  assert.deepEqual(result.rows, []);
});

test("2. real rows pass through unchanged - this function never transforms provider data on the way out", async () => {
  const rows = [
    { id: "re-1", organization_id: "org-1", event_type: "payment_succeeded", revenue_category: "recurring", amount: 149700, currency: "usd", occurred_at: "2026-09-01T00:00:00Z" },
  ];
  const supabase = makeMockSupabase({ data: rows, error: null });
  const result = await loadRevenueEvents(supabase, ["org-1"], NO_RANGE);

  assert.equal(result.failed, false);
  assert.deepEqual(result.rows, rows);
});

test("3. a real Postgrest error sets failed=true and returns no fabricated rows", async () => {
  const supabase = makeMockSupabase({ data: null, error: { message: "connection reset by peer" } });
  const result = await loadRevenueEvents(supabase, ["org-1"], NO_RANGE);

  assert.equal(result.failed, true);
  assert.deepEqual(result.rows, []);
});

test("4. an empty organization id list short-circuits without querying, and is never itself a failure", async () => {
  const supabase = makeMockSupabase({ data: null, error: { message: "should never be reached" } });
  const result = await loadRevenueEvents(supabase, [], NO_RANGE);

  assert.equal(result.failed, false);
  assert.deepEqual(result.rows, []);
});

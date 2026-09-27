/**
 * Unit tests for lib/agency/costs.ts's loadCostEvents/loadInteractions
 * (AI) and loadSmsCostEvents/loadMessagesForCost (Phase 5D-4, SMS)
 * zero-vs-failure contracts, against a hand-built mocked Supabase client -
 * no real database. Mirrors lib/agency/revenue.partial-data.test.ts exactly.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/agency/costs.partial-data.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { loadCostEvents, loadInteractions, loadSmsCostEvents, loadMessagesForCost }: typeof import("./costs") = require("./costs.ts");

type MockResult = { data: unknown; error: { message: string } | null };

function makeMockSupabase(result: MockResult): SupabaseClient {
  const builder: Record<string, unknown> = {
    select: () => builder,
    in: () => builder,
    gte: () => builder,
    lt: () => builder,
    limit: () => Promise.resolve(result),
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

const NO_RANGE = { from: null, to: null, label: "all time" };

test("1. loadCostEvents: a genuinely empty, successful result returns failed=false and an empty row list", async () => {
  const supabase = makeMockSupabase({ data: [], error: null });
  const result = await loadCostEvents(supabase, ["org-1"], NO_RANGE);
  assert.equal(result.failed, false);
  assert.deepEqual(result.rows, []);
});

test("2. loadCostEvents: a real Postgrest error sets failed=true and returns no fabricated rows", async () => {
  const supabase = makeMockSupabase({ data: null, error: { message: "connection reset" } });
  const result = await loadCostEvents(supabase, ["org-1"], NO_RANGE);
  assert.equal(result.failed, true);
  assert.deepEqual(result.rows, []);
});

test("3. loadCostEvents: an empty organization id list short-circuits without querying, and is never itself a failure", async () => {
  const supabase = makeMockSupabase({ data: null, error: { message: "should never be reached" } });
  const result = await loadCostEvents(supabase, [], NO_RANGE);
  assert.equal(result.failed, false);
  assert.deepEqual(result.rows, []);
});

test("4. loadInteractions: a genuinely empty, successful result returns failed=false and an empty row list", async () => {
  const supabase = makeMockSupabase({ data: [], error: null });
  const result = await loadInteractions(supabase, ["org-1"], NO_RANGE);
  assert.equal(result.failed, false);
  assert.deepEqual(result.rows, []);
});

test("5. loadInteractions: a real Postgrest error sets failed=true and returns no fabricated rows", async () => {
  const supabase = makeMockSupabase({ data: null, error: { message: "timeout" } });
  const result = await loadInteractions(supabase, ["org-1"], NO_RANGE);
  assert.equal(result.failed, true);
  assert.deepEqual(result.rows, []);
});

test("6. loadSmsCostEvents: a genuinely empty, successful result returns failed=false and an empty row list", async () => {
  const supabase = makeMockSupabase({ data: [], error: null });
  const result = await loadSmsCostEvents(supabase, ["org-1"], NO_RANGE);
  assert.equal(result.failed, false);
  assert.deepEqual(result.rows, []);
});

test("7. loadSmsCostEvents: a real Postgrest error sets failed=true and returns no fabricated rows", async () => {
  const supabase = makeMockSupabase({ data: null, error: { message: "connection reset" } });
  const result = await loadSmsCostEvents(supabase, ["org-1"], NO_RANGE);
  assert.equal(result.failed, true);
  assert.deepEqual(result.rows, []);
});

test("8. loadMessagesForCost: a genuinely empty, successful result returns failed=false and an empty row list", async () => {
  const supabase = makeMockSupabase({ data: [], error: null });
  const result = await loadMessagesForCost(supabase, ["org-1"], NO_RANGE);
  assert.equal(result.failed, false);
  assert.deepEqual(result.rows, []);
});

test("9. loadMessagesForCost: a real Postgrest error sets failed=true and returns no fabricated rows", async () => {
  const supabase = makeMockSupabase({ data: null, error: { message: "timeout" } });
  const result = await loadMessagesForCost(supabase, ["org-1"], NO_RANGE);
  assert.equal(result.failed, true);
  assert.deepEqual(result.rows, []);
});

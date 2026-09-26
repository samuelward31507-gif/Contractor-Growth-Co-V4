/**
 * Trackpr 2.0, Phase 4B (P1 #5): unit tests for getOpenOpportunitiesResult,
 * against a hand-built mocked Supabase client - no real database. Mirrors
 * this codebase's own established mocked-client pattern
 * (lib/dashboard/queries.partial-data.test.ts). Dismissal, resolution, and
 * organization scoping are untouched by this phase (same query, same
 * filters) and remain covered by lib/opportunities/sync.integration.test.ts
 * and the detect.*.integration.test.ts files - this file only proves the
 * one new thing: a real query failure is distinguishable from genuine
 * emptiness.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/opportunities/queries.partial-data.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { getOpenOpportunitiesResult, getOpenOpportunities }: typeof import("./queries") = require("./queries.ts");

type MockResult = { data: unknown; error: { message: string; code?: string } | null };

function makeMockSupabase(result: MockResult): SupabaseClient {
  const builder = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    limit: () => Promise.resolve(result),
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

function makeOpportunityRow(id: string) {
  return {
    id,
    type: "qualified_lead_unbooked",
    status: "open",
    source_entity_type: "lead",
    source_entity_id: "lead-1",
    contact_id: "contact-1",
    title: "Test opportunity",
    description: null,
    estimated_value: 2500,
    value_basis: "leads.estimated_value",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    resolved_at: null,
    metadata: {},
  };
}

test("getOpenOpportunitiesResult: a genuinely empty, successful result never sets failed - /opportunities must be able to tell real emptiness from a failed query", async () => {
  const supabase = makeMockSupabase({ data: [], error: null });
  const result = await getOpenOpportunitiesResult(supabase, "org-1");
  assert.equal(result.failed, false);
  assert.deepEqual(result.data, []);
});

test("getOpenOpportunitiesResult: a real Postgrest error sets failed, and never leaks the raw error into the returned shape", async () => {
  const supabase = makeMockSupabase({ data: null, error: { message: "connection reset", code: "57P01" } });
  const result = await getOpenOpportunitiesResult(supabase, "org-1");
  assert.equal(result.failed, true);
  assert.deepEqual(result.data, [], "still a real, empty array for convenience - `failed` is what distinguishes this from genuine emptiness, preventing a false 'You're all caught up.'");
  assert.equal(JSON.stringify(result).includes("57P01"), false);
});

test("getOpenOpportunitiesResult: valid existing data produces identical opportunities to before this change, with null estimatedValue never coerced to 0", async () => {
  const rowWithNullValue = { ...makeOpportunityRow("opp-2"), estimated_value: null, value_basis: null };
  const supabase = makeMockSupabase({ data: [makeOpportunityRow("opp-1"), rowWithNullValue], error: null });

  const result = await getOpenOpportunitiesResult(supabase, "org-1");
  assert.equal(result.failed, false);
  assert.equal(result.data.length, 2);
  assert.equal(result.data[0].estimatedValue, 2500);
  assert.equal(result.data[1].estimatedValue, null, "a genuinely unknown value must stay null, never fabricated as 0");

  // getOpenOpportunities must keep delegating to the exact same read, unchanged for its existing (Dashboard, Contact Detail) callers.
  assert.deepEqual(await getOpenOpportunities(supabase, "org-1"), result.data);
});

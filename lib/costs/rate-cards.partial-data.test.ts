/**
 * Unit tests for loadRateCardCandidates/findApplicableRateCard's
 * zero-vs-failure contract, against a hand-built mocked Supabase client - no
 * real database. Mirrors lib/agency/revenue.partial-data.test.ts's exact
 * technique.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/costs/rate-cards.partial-data.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { loadRateCardCandidates, findApplicableRateCard }: typeof import("./rate-cards") = require("./rate-cards.ts");

type MockResult = { data: unknown; error: { message: string } | null };

/** A stub builder where every chained call (however many .eq()s) returns itself, and awaiting it resolves to the given result - avoids hardcoding an exact chain length. */
function makeThenableMockSupabase(result: MockResult): SupabaseClient {
  const builder: Record<string, unknown> & { then: (resolve: (v: MockResult) => void) => void } = {
    select: () => builder,
    eq: () => builder,
    is: () => builder,
    then: (resolve: (v: MockResult) => void) => resolve(result),
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

test("1. a genuinely empty, successful result returns failed=false and an empty row list", async () => {
  const supabase = makeThenableMockSupabase({ data: [], error: null });
  const result = await loadRateCardCandidates(supabase, { provider: "anthropic", service: "chat_completion", model: "claude-sonnet-5", unit: "input_token" });
  assert.equal(result.failed, false);
  assert.deepEqual(result.rows, []);
});

test("2. real rate card rows are mapped from snake_case to the RateCard shape correctly", async () => {
  const rows = [{ id: "rc-1", provider: "anthropic", service: "chat_completion", model: "claude-sonnet-5", unit: "input_token", unit_price: 0.000003, currency: "usd", effective_from: "2026-01-01T00:00:00Z", effective_to: null }];
  const supabase = makeThenableMockSupabase({ data: rows, error: null });
  const result = await loadRateCardCandidates(supabase, { provider: "anthropic", service: "chat_completion", model: "claude-sonnet-5", unit: "input_token" });
  assert.equal(result.failed, false);
  assert.deepEqual(result.rows, [{ id: "rc-1", provider: "anthropic", service: "chat_completion", model: "claude-sonnet-5", unit: "input_token", unitPrice: 0.000003, currency: "usd", effectiveFrom: "2026-01-01T00:00:00Z", effectiveTo: null }]);
});

test("3. a real Postgrest error sets failed=true and returns no fabricated rows", async () => {
  const supabase = makeThenableMockSupabase({ data: null, error: { message: "connection reset" } });
  const result = await loadRateCardCandidates(supabase, { provider: "anthropic", service: "chat_completion", model: null, unit: "output_token" });
  assert.equal(result.failed, true);
  assert.deepEqual(result.rows, []);
});

test("4. findApplicableRateCard returns null (never throws, never a fabricated rate) when the underlying query fails", async () => {
  const supabase = makeThenableMockSupabase({ data: null, error: { message: "timeout" } });
  const result = await findApplicableRateCard(supabase, { provider: "anthropic", service: "chat_completion", model: "claude-sonnet-5", unit: "input_token", occurredAt: "2026-01-01T00:00:00Z" });
  assert.equal(result, null);
});

test("5. findApplicableRateCard returns null when the query succeeds but no candidate covers occurredAt", async () => {
  const rows = [{ id: "rc-1", provider: "anthropic", service: "chat_completion", model: "claude-sonnet-5", unit: "input_token", unit_price: 0.000003, currency: "usd", effective_from: "2026-06-01T00:00:00Z", effective_to: null }];
  const supabase = makeThenableMockSupabase({ data: rows, error: null });
  const result = await findApplicableRateCard(supabase, { provider: "anthropic", service: "chat_completion", model: "claude-sonnet-5", unit: "input_token", occurredAt: "2026-01-01T00:00:00Z" });
  assert.equal(result, null, "usage before the only rate's effective_from is unpriced, never guessed");
});

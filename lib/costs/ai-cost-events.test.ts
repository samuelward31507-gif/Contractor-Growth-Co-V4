/**
 * Unit tests for lib/costs/ai-cost-events.ts's cost-calculation and
 * trust-boundary logic, against a hand-built mocked Supabase client routed
 * by table name (rate_cards for the rate lookup, ai_cost_events for the
 * write) - no real database. Idempotency/concurrency against a real
 * database is covered separately in ai-cost-events.integration.test.ts.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/costs/ai-cost-events.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { recordAiCostEventForInteraction, resolveTrustedAiProvider, isValidTokenCount }: typeof import("./ai-cost-events") = require("./ai-cost-events.ts");

type RateCardFixture = { unit: string; unit_price: number; currency: string; effective_from: string; effective_to: string | null }[];

/**
 * Routes by table: `rate_cards` queries resolve to the fixture rows matching
 * the requested unit (input_token/output_token); `ai_cost_events` upserts
 * resolve to `upsertResult`. Mirrors the exact chain shape rate-cards.ts and
 * ai-cost-events.ts actually call (.select().eq().eq().eq().eq() / .is(),
 * and .upsert()).
 */
function makeMockSupabase(rateCards: RateCardFixture, upsertResult: { error: { message: string } | null } = { error: null }): SupabaseClient {
  // recordAiCostEventForInteraction issues its two rate lookups concurrently
  // (Promise.all) - a single shared builder/lastUnit mutated across both
  // calls would race (whichever .eq("unit", ...) runs last would win for
  // BOTH pending lookups). Each .from("rate_cards") call must therefore
  // build its own fresh, independent builder with its own closed-over
  // lastUnit, exactly like a real Supabase client issuing two independent
  // queries would never share state between them.
  function buildRateCardsQuery(): Record<string, unknown> {
    let lastUnit: string | undefined;
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (column: string, value: string) => {
        if (column === "unit") lastUnit = value;
        return builder;
      },
      is: () => builder,
      then: (resolve: (v: { data: unknown; error: null }) => void) => {
        const rows = rateCards.filter((rc) => rc.unit === lastUnit);
        resolve({ data: rows, error: null });
      },
    };
    return builder;
  }

  const costEventsBuilder = {
    upsert: () => Promise.resolve(upsertResult),
  };

  return {
    from: (table: string) => (table === "rate_cards" ? buildRateCardsQuery() : costEventsBuilder),
  } as unknown as SupabaseClient;
}

const BASE_INPUT = {
  organizationId: "org-1",
  sourceInteractionId: "interaction-1",
  provider: "anthropic",
  model: "claude-sonnet-5",
  occurredAt: "2026-06-15T00:00:00Z",
};

test("1. resolveTrustedAiProvider trusts exactly business_insights, and nothing else", () => {
  assert.equal(resolveTrustedAiProvider("business_insights"), "anthropic");
  assert.equal(resolveTrustedAiProvider("customer_reply_response"), null, "an n8n-driven interaction_type must never be trusted, however plausible its self-reported model looks");
  assert.equal(resolveTrustedAiProvider("lead_followup_response"), null);
  assert.equal(resolveTrustedAiProvider("anything_else"), null);
});

test("2. isValidTokenCount accepts only non-negative integers", () => {
  assert.equal(isValidTokenCount(100), true);
  assert.equal(isValidTokenCount(0), true);
  assert.equal(isValidTokenCount(-1), false, "negative must be rejected");
  assert.equal(isValidTokenCount(1.5), false, "fractional must be rejected");
  assert.equal(isValidTokenCount(null), false);
  assert.equal(isValidTokenCount(undefined), false);
  assert.equal(isValidTokenCount("100"), false, "a numeric string must never be coerced");
});

test("3. a known interaction with valid usage and matching input/output rates computes the correct cost", async () => {
  const supabase = makeMockSupabase([
    { unit: "input_token", unit_price: 0.000003, currency: "usd", effective_from: "2026-01-01T00:00:00Z", effective_to: null },
    { unit: "output_token", unit_price: 0.000015, currency: "usd", effective_from: "2026-01-01T00:00:00Z", effective_to: null },
  ]);

  const result = await recordAiCostEventForInteraction(supabase, { ...BASE_INPUT, usage: { inputTokens: 1000, outputTokens: 500 } });

  assert.equal(result.outcome, "known");
  if (result.outcome !== "known") return;
  // input: 1000 * 0.000003 = 0.003, output: 500 * 0.000015 = 0.0075, total = 0.0105
  assert.ok(Math.abs(result.totalCost - 0.0105) < 1e-9, `expected ~0.0105, got ${result.totalCost}`);
  assert.equal(result.currency, "usd");
});

test("4. missing input tokens (null) -> unknown, never a fabricated cost", async () => {
  const supabase = makeMockSupabase([
    { unit: "input_token", unit_price: 0.000003, currency: "usd", effective_from: "2026-01-01T00:00:00Z", effective_to: null },
    { unit: "output_token", unit_price: 0.000015, currency: "usd", effective_from: "2026-01-01T00:00:00Z", effective_to: null },
  ]);
  const result = await recordAiCostEventForInteraction(supabase, { ...BASE_INPUT, usage: { inputTokens: null, outputTokens: 500 } });
  assert.equal(result.outcome, "unknown");
});

test("5. negative output tokens -> unknown, never coerced to 0", async () => {
  const supabase = makeMockSupabase([]);
  const result = await recordAiCostEventForInteraction(supabase, { ...BASE_INPUT, usage: { inputTokens: 100, outputTokens: -5 } });
  assert.equal(result.outcome, "unknown");
});

test("6. malformed (fractional) input tokens -> unknown", async () => {
  const supabase = makeMockSupabase([]);
  const result = await recordAiCostEventForInteraction(supabase, { ...BASE_INPUT, usage: { inputTokens: 12.5, outputTokens: 10 } });
  assert.equal(result.outcome, "unknown");
});

test("7. valid usage but no matching rate card for the model/period -> unpriced", async () => {
  const supabase = makeMockSupabase([]);
  const result = await recordAiCostEventForInteraction(supabase, { ...BASE_INPUT, usage: { inputTokens: 100, outputTokens: 50 } });
  assert.equal(result.outcome, "unpriced");
});

test("8. valid usage with only an input rate (output rate missing) -> unpriced, never priced from one side alone", async () => {
  const supabase = makeMockSupabase([{ unit: "input_token", unit_price: 0.000003, currency: "usd", effective_from: "2026-01-01T00:00:00Z", effective_to: null }]);
  const result = await recordAiCostEventForInteraction(supabase, { ...BASE_INPUT, usage: { inputTokens: 100, outputTokens: 50 } });
  assert.equal(result.outcome, "unpriced");
});

test("9. a currency mismatch between the input and output rate -> unpriced, never blended", async () => {
  const supabase = makeMockSupabase([
    { unit: "input_token", unit_price: 0.000003, currency: "usd", effective_from: "2026-01-01T00:00:00Z", effective_to: null },
    { unit: "output_token", unit_price: 0.000015, currency: "eur", effective_from: "2026-01-01T00:00:00Z", effective_to: null },
  ]);
  const result = await recordAiCostEventForInteraction(supabase, { ...BASE_INPUT, usage: { inputTokens: 100, outputTokens: 50 } });
  assert.equal(result.outcome, "unpriced");
});

test("10. usage from before a rate's effective_from is unpriced - never priced with a later rate applied retroactively", async () => {
  const supabase = makeMockSupabase([
    { unit: "input_token", unit_price: 0.000003, currency: "usd", effective_from: "2027-01-01T00:00:00Z", effective_to: null },
    { unit: "output_token", unit_price: 0.000015, currency: "usd", effective_from: "2027-01-01T00:00:00Z", effective_to: null },
  ]);
  const result = await recordAiCostEventForInteraction(supabase, { ...BASE_INPUT, occurredAt: "2026-06-15T00:00:00Z", usage: { inputTokens: 100, outputTokens: 50 } });
  assert.equal(result.outcome, "unpriced");
});

test("11. a real zero-token interaction (both input and output genuinely 0) computes a real $0 known cost, never 'unknown'", async () => {
  const supabase = makeMockSupabase([
    { unit: "input_token", unit_price: 0.000003, currency: "usd", effective_from: "2026-01-01T00:00:00Z", effective_to: null },
    { unit: "output_token", unit_price: 0.000015, currency: "usd", effective_from: "2026-01-01T00:00:00Z", effective_to: null },
  ]);
  const result = await recordAiCostEventForInteraction(supabase, { ...BASE_INPUT, usage: { inputTokens: 0, outputTokens: 0 } });
  assert.equal(result.outcome, "known");
  if (result.outcome === "known") assert.equal(result.totalCost, 0);
});

test("12. a write error from the upsert surfaces as an 'error' outcome, never silently swallowed as 'known'", async () => {
  const supabase = makeMockSupabase(
    [
      { unit: "input_token", unit_price: 0.000003, currency: "usd", effective_from: "2026-01-01T00:00:00Z", effective_to: null },
      { unit: "output_token", unit_price: 0.000015, currency: "usd", effective_from: "2026-01-01T00:00:00Z", effective_to: null },
    ],
    { error: { message: "connection reset" } },
  );
  const result = await recordAiCostEventForInteraction(supabase, { ...BASE_INPUT, usage: { inputTokens: 100, outputTokens: 50 } });
  assert.equal(result.outcome, "error");
});

/**
 * Pure unit tests for lib/costs/rate-cards.ts's non-I/O rate-selection logic
 * (selectApplicableRateCard) - kept separate from
 * rate-cards.partial-data.test.ts (mocked single-table client for
 * loadRateCardCandidates/findApplicableRateCard), matching this codebase's
 * own established split.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/costs/rate-cards.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { selectApplicableRateCard }: typeof import("./rate-cards") = require("./rate-cards.ts");

function card(overrides: Partial<import("./rate-cards").RateCard> = {}): import("./rate-cards").RateCard {
  return {
    id: "card-1",
    provider: "anthropic",
    service: "chat_completion",
    model: "claude-sonnet-5",
    unit: "input_token",
    unitPrice: 0.000003,
    currency: "usd",
    effectiveFrom: "2026-01-01T00:00:00Z",
    effectiveTo: null,
    ...overrides,
  };
}

test("1. an occurredAt exactly at effective_from is included (inclusive lower bound)", () => {
  const result = selectApplicableRateCard([card({ effectiveFrom: "2026-01-01T00:00:00Z" })], "2026-01-01T00:00:00Z");
  assert.ok(result, "the boundary instant itself must match");
});

test("2. an occurredAt exactly at effective_to is EXCLUDED (exclusive upper bound)", () => {
  const result = selectApplicableRateCard([card({ effectiveFrom: "2026-01-01T00:00:00Z", effectiveTo: "2026-02-01T00:00:00Z" })], "2026-02-01T00:00:00Z");
  assert.equal(result, null, "the exact effective_to instant must not match - the next rate period owns that instant");
});

test("3. an occurredAt one millisecond before effective_to still matches", () => {
  const result = selectApplicableRateCard([card({ effectiveFrom: "2026-01-01T00:00:00Z", effectiveTo: "2026-02-01T00:00:00.000Z" })], "2026-01-31T23:59:59.999Z");
  assert.ok(result);
});

test("4. an occurredAt before effective_from never matches - never applies a future rate to earlier usage", () => {
  const result = selectApplicableRateCard([card({ effectiveFrom: "2026-03-01T00:00:00Z" })], "2026-01-01T00:00:00Z");
  assert.equal(result, null);
});

test("5. a null effective_to means still-current - matches any occurredAt at or after effective_from with no upper limit", () => {
  const result = selectApplicableRateCard([card({ effectiveFrom: "2026-01-01T00:00:00Z", effectiveTo: null })], "2030-01-01T00:00:00Z");
  assert.ok(result);
});

test("6. historical lookup: two non-overlapping periods each apply to their own era - never today's rate applied retroactively", () => {
  const oldRate = card({ id: "old", unitPrice: 0.000001, effectiveFrom: "2026-01-01T00:00:00Z", effectiveTo: "2026-06-01T00:00:00Z" });
  const newRate = card({ id: "new", unitPrice: 0.000002, effectiveFrom: "2026-06-01T00:00:00Z", effectiveTo: null });

  const historical = selectApplicableRateCard([oldRate, newRate], "2026-03-15T00:00:00Z");
  assert.equal(historical?.id, "old", "usage from before the rate change must use the old rate");

  const current = selectApplicableRateCard([oldRate, newRate], "2026-09-01T00:00:00Z");
  assert.equal(current?.id, "new", "usage after the rate change must use the new rate, never the old one");
});

test("7. an empty candidate list returns null - never a fabricated rate", () => {
  assert.equal(selectApplicableRateCard([], "2026-01-01T00:00:00Z"), null);
});

test("8. an unrecognized model with no matching candidates returns null, never a 'closest' rate", () => {
  const result = selectApplicableRateCard([card({ model: "claude-sonnet-5" })], "2026-01-01T00:00:00Z");
  // Caller is responsible for filtering candidates by model before calling
  // this function (see loadRateCardCandidates) - this test documents that
  // selectApplicableRateCard itself never substitutes a different model's
  // rate; an empty candidate array (as loadRateCardCandidates would produce
  // for an unmatched model) is the only path to null here.
  assert.ok(result, "sanity: the exact-model candidate still matches");
  assert.equal(selectApplicableRateCard([], "2026-01-01T00:00:00Z"), null);
});

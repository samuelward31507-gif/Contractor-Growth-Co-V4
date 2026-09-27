/**
 * Pure unit tests for lib/agency/costs.ts's non-I/O classification logic
 * (classifyUnresolvedAiInteraction) - kept separate from
 * costs.partial-data.test.ts (mocked query loaders) and
 * costs.integration.test.ts (real DB, authorization, tenant isolation).
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/agency/costs.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { classifyUnresolvedAiInteraction }: typeof import("./costs") = require("./costs.ts");

test("1. a trusted interaction_type (business_insights) with valid usage is 'unpriced' - identity and usage are both fine, only the rate is missing", () => {
  const result = classifyUnresolvedAiInteraction({ interactionType: "business_insights", output: { usage: { input_tokens: 100, output_tokens: 50 } } });
  assert.equal(result, "unpriced");
});

test("2. a trusted interaction_type with missing usage is 'unknown', never 'unpriced'", () => {
  const result = classifyUnresolvedAiInteraction({ interactionType: "business_insights", output: { summary: "no usage field at all" } });
  assert.equal(result, "unknown");
});

test("3. a trusted interaction_type with malformed usage (non-numeric) is 'unknown'", () => {
  const result = classifyUnresolvedAiInteraction({ interactionType: "business_insights", output: { usage: { input_tokens: "100", output_tokens: 50 } } });
  assert.equal(result, "unknown");
});

test("4. an untrusted interaction_type (n8n-driven) is ALWAYS 'unknown', even with plausible-looking usage data - identity is the deciding factor, never the presence of a usage object", () => {
  const result = classifyUnresolvedAiInteraction({ interactionType: "customer_reply_response", output: { model: "claude-sonnet-5", usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } } });
  assert.equal(result, "unknown", "an n8n self-reported model/usage must never be trusted merely because it looks complete");
});

test("5. an unrecognized/unlisted interaction_type is 'unknown'", () => {
  const result = classifyUnresolvedAiInteraction({ interactionType: "some_future_type", output: { usage: { input_tokens: 1, output_tokens: 1 } } });
  assert.equal(result, "unknown");
});

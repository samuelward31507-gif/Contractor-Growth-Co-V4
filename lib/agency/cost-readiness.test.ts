/**
 * Pure unit tests for lib/agency/cost-readiness.ts's non-I/O extraction
 * logic (extractAiTokenUsage) - kept separate from
 * cost-readiness.integration.test.ts (real DB, authorization, real field
 * mapping) and cost-readiness.partial-data.test.ts (mocked single-table
 * client for loadAiTokenBreakdown), matching this codebase's own established
 * split (see lib/agency/usage.test.ts for the identical pattern).
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/agency/cost-readiness.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { extractAiTokenUsage }: typeof import("./cost-readiness") = require("./cost-readiness.ts");

test("1. a real, complete usage object extracts both input and output tokens", () => {
  const result = extractAiTokenUsage({ usage: { input_tokens: 120, output_tokens: 45, total_tokens: 165 } });
  assert.deepEqual(result, { inputTokens: 120, outputTokens: 45 });
});

test("2. total_tokens present but input/output absent - both stay null, never inferred from total", () => {
  const result = extractAiTokenUsage({ usage: { total_tokens: 165 } });
  assert.deepEqual(result, { inputTokens: null, outputTokens: null }, "input/output must never be derived by splitting or guessing from total_tokens");
});

test("3. a completely missing output value returns null for both fields, never throws", () => {
  assert.deepEqual(extractAiTokenUsage(undefined), { inputTokens: null, outputTokens: null });
  assert.deepEqual(extractAiTokenUsage(null), { inputTokens: null, outputTokens: null });
});

test("4. output present but usage key missing entirely returns null for both fields", () => {
  const result = extractAiTokenUsage({ model: "claude-sonnet-5", should_send: true });
  assert.deepEqual(result, { inputTokens: null, outputTokens: null });
});

test("5. a malformed usage value (not an object) never fabricates a number and never throws", () => {
  assert.deepEqual(extractAiTokenUsage({ usage: "not an object" }), { inputTokens: null, outputTokens: null });
  assert.deepEqual(extractAiTokenUsage({ usage: 12345 }), { inputTokens: null, outputTokens: null });
  assert.deepEqual(extractAiTokenUsage({ usage: null }), { inputTokens: null, outputTokens: null });
  assert.deepEqual(extractAiTokenUsage("a raw string, not an object at all"), { inputTokens: null, outputTokens: null });
});

test("6. a non-numeric input_tokens/output_tokens value is treated as null, never coerced", () => {
  const result = extractAiTokenUsage({ usage: { input_tokens: "120", output_tokens: null, total_tokens: 120 } });
  assert.deepEqual(result, { inputTokens: null, outputTokens: null }, "a string value must never be treated as a real number");
});

test("7. input_tokens known but output_tokens genuinely null - each field is independent, never linked", () => {
  const result = extractAiTokenUsage({ usage: { input_tokens: 300, output_tokens: null, total_tokens: null } });
  assert.deepEqual(result, { inputTokens: 300, outputTokens: null });
});

test("8. a real zero token value is preserved as 0, not treated as missing", () => {
  const result = extractAiTokenUsage({ usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } });
  assert.deepEqual(result, { inputTokens: 0, outputTokens: 0 }, "a genuine reported 0 must stay 0, not be treated the same as null/unavailable");
});

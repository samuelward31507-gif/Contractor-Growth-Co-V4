/**
 * Pure unit tests for lib/bi/insights.ts's Phase 5D-2 telemetry-extraction
 * fix (extractUsageFromMessage) - the exact transformation the audit found
 * missing (a real Anthropic response's usage was received and discarded).
 * No network call, no Supabase - a bare object shaped like the one field of
 * Anthropic.Message this function reads.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/bi/insights.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { extractUsageFromMessage }: typeof import("./insights") = require("./insights.ts");

test("1. a real, complete usage object extracts both input and output tokens, and derives a real total", () => {
  const result = extractUsageFromMessage({ usage: { input_tokens: 1200, output_tokens: 340 } } as never);
  assert.deepEqual(result, { inputTokens: 1200, outputTokens: 340, totalTokens: 1540 });
});

test("2. a genuine zero-token usage is preserved as 0, not treated as missing", () => {
  const result = extractUsageFromMessage({ usage: { input_tokens: 0, output_tokens: 0 } } as never);
  assert.deepEqual(result, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
});

test("3. a completely missing usage field returns null for all three fields, never throws", () => {
  const result = extractUsageFromMessage({ usage: undefined } as never);
  assert.deepEqual(result, { inputTokens: null, outputTokens: null, totalTokens: null });
});

test("4. a null usage field returns null for all three fields", () => {
  const result = extractUsageFromMessage({ usage: null } as never);
  assert.deepEqual(result, { inputTokens: null, outputTokens: null, totalTokens: null });
});

test("5. a non-numeric input_tokens value is treated as null, never coerced", () => {
  const result = extractUsageFromMessage({ usage: { input_tokens: "1200", output_tokens: 340 } } as never);
  assert.deepEqual(result, { inputTokens: null, outputTokens: 340, totalTokens: null }, "totalTokens must never be derived when one side is invalid");
});

test("6. a negative output_tokens value is treated as null, never coerced or summed", () => {
  const result = extractUsageFromMessage({ usage: { input_tokens: 100, output_tokens: -5 } } as never);
  assert.deepEqual(result, { inputTokens: 100, outputTokens: null, totalTokens: null });
});

test("7. a fractional token count is treated as null - real token counts are always integers", () => {
  const result = extractUsageFromMessage({ usage: { input_tokens: 12.5, output_tokens: 10 } } as never);
  assert.deepEqual(result, { inputTokens: null, outputTokens: 10, totalTokens: null });
});

test("8. input known but output missing - each field is independent, totalTokens stays null", () => {
  const result = extractUsageFromMessage({ usage: { input_tokens: 500 } } as never);
  assert.deepEqual(result, { inputTokens: 500, outputTokens: null, totalTokens: null });
});

/**
 * Unit tests for parseJobEditInput (lib/jobs/edit-input.ts) - the validation
 * behind updateJob. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/jobs/edit-input.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJobEditInput, MAX_JOB_AMOUNT } from "./edit-input";

test("accepts a title, a dollars-and-cents amount, and notes", () => {
  const result = parseJobEditInput({ title: "  Roof replacement  ", amount: "24000.50", notes: "  Customer prefers mornings " });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.input, { title: "Roof replacement", amount: 24000.5, notes: "Customer prefers mornings" });
});

test("a blank amount clears the value to null rather than 0", () => {
  const result = parseJobEditInput({ title: "Gutters", amount: "", notes: "" });
  assert.deepEqual(result.input, { title: "Gutters", amount: null, notes: null });
});

test("accepts a zero amount explicitly typed as 0", () => {
  const result = parseJobEditInput({ title: "Warranty visit", amount: "0", notes: null });
  assert.deepEqual(result.input, { title: "Warranty visit", amount: 0, notes: null });
});

test("rejects a missing title", () => {
  assert.equal(parseJobEditInput({ title: "   ", amount: "10", notes: "" }).error, "Enter a title for this job.");
  assert.equal(parseJobEditInput({ title: undefined, amount: "10", notes: "" }).error, "Enter a title for this job.");
});

test("rejects non-numeric, negative, sub-cent, and absurd amounts", () => {
  assert.equal(parseJobEditInput({ title: "Job", amount: "twelve", notes: "" }).error, "Enter a valid amount.");
  assert.equal(parseJobEditInput({ title: "Job", amount: "-5", notes: "" }).error, "Amount cannot be negative.");
  assert.equal(parseJobEditInput({ title: "Job", amount: "Infinity", notes: "" }).error, "Enter a valid amount.");
  assert.equal(parseJobEditInput({ title: "Job", amount: "12.345", notes: "" }).error, "Enter the amount in dollars and cents (no more than two decimal places).");
  assert.equal(parseJobEditInput({ title: "Job", amount: String(MAX_JOB_AMOUNT + 1), notes: "" }).error, "Enter a realistic amount.");
});

test("never touches fields outside title/amount/notes", () => {
  const result = parseJobEditInput({ title: "Job", amount: "100", notes: "n" });
  assert.deepEqual(Object.keys(result.input ?? {}).sort(), ["amount", "notes", "title"]);
});

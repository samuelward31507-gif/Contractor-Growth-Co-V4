/**
 * Unit tests for Pass 4 P1-F: summarizeOpenLeadValue/formatOpenLeadValueDisplay -
 * pure, no I/O. Run with:
 *
 *   node --test lib/contacts/open-lead-value.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { summarizeOpenLeadValue, formatOpenLeadValueDisplay }: typeof import("./open-lead-value") = require("./open-lead-value.ts");

const formatCurrency = (value: number) => `$${value.toLocaleString("en-US")}`;

test("a lead with a NULL estimated_value is counted as unknown, never coerced to 0 in the sum", () => {
  const summary = summarizeOpenLeadValue([
    { status: "qualified", estimated_value: null },
    { status: "qualified", estimated_value: 500 },
  ]);
  assert.equal(summary.knownValue, 500, "the null-value lead must be excluded from the sum, never treated as 0");
  assert.equal(summary.unknownValueCount, 1);
});

test("won/lost leads are excluded entirely - never counted as open, known or unknown", () => {
  const summary = summarizeOpenLeadValue([
    { status: "won", estimated_value: 10000 },
    { status: "lost", estimated_value: null },
    { status: "qualified", estimated_value: 200 },
  ]);
  assert.equal(summary.knownValue, 200, "won's $10,000 must never be counted as an open opportunity value");
  assert.equal(summary.unknownValueCount, 0, "lost's null value must never be counted as an unknown OPEN value - it isn't open at all");
});

test("known values sum correctly across multiple open leads", () => {
  const summary = summarizeOpenLeadValue([
    { status: "new", estimated_value: 300 },
    { status: "contacted", estimated_value: 450 },
  ]);
  assert.equal(summary.knownValue, 750);
  assert.equal(summary.unknownValueCount, 0);
});

test("formatOpenLeadValueDisplay: when every open lead has an unknown value, displays 'Unknown', never a fabricated $0", () => {
  const summary = summarizeOpenLeadValue([{ status: "qualified", estimated_value: null }]);
  const display = formatOpenLeadValueDisplay(summary, 1, formatCurrency);
  assert.equal(display, "Unknown");
});

test("formatOpenLeadValueDisplay: a real $0 known value is only possible with zero open leads - displays the real formatted amount, not 'Unknown'", () => {
  const summary = summarizeOpenLeadValue([]);
  const display = formatOpenLeadValueDisplay(summary, 0, formatCurrency);
  assert.equal(display, formatCurrency(0), "no open leads at all is a real, calculable $0 - not an unknown-value situation");
});

test("formatOpenLeadValueDisplay: a real known non-zero value displays the actual formatted amount", () => {
  const summary = summarizeOpenLeadValue([{ status: "qualified", estimated_value: 1500 }]);
  const display = formatOpenLeadValueDisplay(summary, 1, formatCurrency);
  assert.equal(display, formatCurrency(1500));
});

test("formatOpenLeadValueDisplay: a mix of known and unknown open leads displays the real known sum, never 'Unknown' (some value IS known)", () => {
  const summary = summarizeOpenLeadValue([
    { status: "qualified", estimated_value: 800 },
    { status: "qualified", estimated_value: null },
  ]);
  const display = formatOpenLeadValueDisplay(summary, 2, formatCurrency);
  assert.equal(display, formatCurrency(800), "a real, partial known value must be shown, not hidden behind 'Unknown' just because one lead's value is missing");
});

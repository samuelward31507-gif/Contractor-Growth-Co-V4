/**
 * Unit tests for computeNurtureOccurrence() - the pure decision behind
 * which lost-lead nurture touch (if any) is due, given elapsed time since
 * a lead went lost (Automation Configuration V3). This file transitively
 * imports several "@/"-aliased modules, so it needs the same resolution
 * bridge as retry.test.ts - see lib/automation/test-loader.mjs. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/lead-nurture.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { computeNurtureOccurrence }: typeof import("./lead-nurture") = require("./lead-nurture.ts");

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CONFIG = { touch_1_days: 3, touch_2_days: 14 };
const CUSTOM_CONFIG = { touch_1_days: 5, touch_2_days: 20 };

test("before the first configured threshold, no touch is due", () => {
  assert.equal(computeNurtureOccurrence(2 * DAY_MS, DEFAULT_CONFIG), null);
});

test("exactly at the first configured threshold, touch 1 is due", () => {
  assert.equal(computeNurtureOccurrence(3 * DAY_MS, DEFAULT_CONFIG), 1);
});

test("after the first configured threshold (but before the second), touch 1 is due", () => {
  assert.equal(computeNurtureOccurrence(10 * DAY_MS, DEFAULT_CONFIG), 1);
});

test("before the second configured threshold, touch 1 remains due (not yet touch 2)", () => {
  assert.equal(computeNurtureOccurrence(13 * DAY_MS, DEFAULT_CONFIG), 1);
});

test("exactly at the second configured threshold, touch 2 is due", () => {
  assert.equal(computeNurtureOccurrence(14 * DAY_MS, DEFAULT_CONFIG), 2);
});

test("after the second configured threshold, touch 2 is due - even though touch 1 also elapsed, only the more current touchpoint fires", () => {
  assert.equal(computeNurtureOccurrence(30 * DAY_MS, DEFAULT_CONFIG), 2);
});

test("defaults (3/14 days) reproduce the exact pre-configuration behavior", () => {
  assert.equal(computeNurtureOccurrence(2 * DAY_MS, DEFAULT_CONFIG), null, "2 days: not yet due");
  assert.equal(computeNurtureOccurrence(3 * DAY_MS, DEFAULT_CONFIG), 1, "3 days: touch 1 due");
  assert.equal(computeNurtureOccurrence(13 * DAY_MS, DEFAULT_CONFIG), 1, "13 days: still touch 1");
  assert.equal(computeNurtureOccurrence(14 * DAY_MS, DEFAULT_CONFIG), 2, "14 days: touch 2 due");
});

test("a custom configured cadence (5/20 days) resolves differently than the default at the same elapsed time - proving the configured value, not a hardcoded constant, drives occurrence", () => {
  assert.equal(computeNurtureOccurrence(4 * DAY_MS, DEFAULT_CONFIG), 1, "4 days under default (3/14): touch 1 due");
  assert.equal(computeNurtureOccurrence(4 * DAY_MS, CUSTOM_CONFIG), null, "4 days under custom (5/20): not yet due");
});

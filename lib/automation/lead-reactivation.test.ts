/**
 * Unit tests for computeReactivationOccurrence() - the pure decision
 * behind which lead-reactivation touch (if any) is due, given elapsed time
 * since the lead's last inbound message (Automation Configuration V4).
 * This file transitively imports several "@/"-aliased modules, so it
 * needs the same resolution bridge as retry.test.ts - see
 * lib/automation/test-loader.mjs. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/lead-reactivation.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { computeReactivationOccurrence }: typeof import("./lead-reactivation") = require("./lead-reactivation.ts");

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CONFIG = { touch_1_days: 7, touch_2_days: 21 };
const CUSTOM_CONFIG = { touch_1_days: 10, touch_2_days: 30 };

test("before the first configured threshold, no touch is due", () => {
  assert.equal(computeReactivationOccurrence(6 * DAY_MS, DEFAULT_CONFIG), null);
});

test("exactly at the first configured threshold, touch 1 is due", () => {
  assert.equal(computeReactivationOccurrence(7 * DAY_MS, DEFAULT_CONFIG), 1);
});

test("after the first configured threshold (but before the second), touch 1 is due", () => {
  assert.equal(computeReactivationOccurrence(15 * DAY_MS, DEFAULT_CONFIG), 1);
});

test("before the second configured threshold, touch 1 remains due (not yet touch 2)", () => {
  assert.equal(computeReactivationOccurrence(20 * DAY_MS, DEFAULT_CONFIG), 1);
});

test("exactly at the second configured threshold, touch 2 is due", () => {
  assert.equal(computeReactivationOccurrence(21 * DAY_MS, DEFAULT_CONFIG), 2);
});

test("after the second configured threshold, touch 2 is due - even though touch 1 also elapsed, only the more current touchpoint fires", () => {
  assert.equal(computeReactivationOccurrence(45 * DAY_MS, DEFAULT_CONFIG), 2);
});

test("default configuration (7/21 days) reproduces the exact pre-configuration behavior", () => {
  assert.equal(computeReactivationOccurrence(6 * DAY_MS, DEFAULT_CONFIG), null, "6 days: not yet due");
  assert.equal(computeReactivationOccurrence(7 * DAY_MS, DEFAULT_CONFIG), 1, "7 days: touch 1 due");
  assert.equal(computeReactivationOccurrence(20 * DAY_MS, DEFAULT_CONFIG), 1, "20 days: still touch 1");
  assert.equal(computeReactivationOccurrence(21 * DAY_MS, DEFAULT_CONFIG), 2, "21 days: touch 2 due");
});

test("a custom configured cadence (10/30 days) changes the timing correctly - proving the configured value, not a hardcoded constant, drives occurrence", () => {
  assert.equal(computeReactivationOccurrence(8 * DAY_MS, DEFAULT_CONFIG), 1, "8 days under default (7/21): touch 1 due");
  assert.equal(computeReactivationOccurrence(8 * DAY_MS, CUSTOM_CONFIG), null, "8 days under custom (10/30): not yet due");
  assert.equal(computeReactivationOccurrence(30 * DAY_MS, CUSTOM_CONFIG), 2, "30 days under custom: touch 2 due");
});

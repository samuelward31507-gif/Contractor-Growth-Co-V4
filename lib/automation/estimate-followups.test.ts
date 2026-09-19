/**
 * Unit tests for computeFollowupOccurrence() - the pure decision behind
 * which follow-up (if any) is due, given elapsed hours since an estimate
 * was sent (Automation Configuration V1). This file transitively imports
 * several "@/"-aliased modules, so it needs the same resolution bridge as
 * retry.test.ts - see lib/automation/test-loader.mjs. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/estimate-followups.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { computeFollowupOccurrence }: typeof import("./estimate-followups") = require("./estimate-followups.ts");

const DEFAULT_CONFIG = { followup_1_hours: 24, followup_2_hours: 72 };
const CUSTOM_CONFIG = { followup_1_hours: 48, followup_2_hours: 96 };

test("Config 10: before the first configured threshold, no follow-up is due", () => {
  assert.equal(computeFollowupOccurrence(10, CUSTOM_CONFIG), null);
});

test("Config 10b: at/after the first configured threshold (but before the second), occurrence 1 is due", () => {
  assert.equal(computeFollowupOccurrence(48, CUSTOM_CONFIG), 1);
  assert.equal(computeFollowupOccurrence(90, CUSTOM_CONFIG), 1);
});

test("Config 10c: at/after the second configured threshold, occurrence 2 is due - even though 48h has also elapsed, only the more current touchpoint fires", () => {
  assert.equal(computeFollowupOccurrence(96, CUSTOM_CONFIG), 2);
  assert.equal(computeFollowupOccurrence(500, CUSTOM_CONFIG), 2);
});

test("Config 10d: the same elapsed time (30h) resolves differently depending on which organization's config is used - occurrence 1 under the default (24h) config, but not yet due under a custom (48h) config - proving occurrence is driven by the configured values, not a hardcoded constant", () => {
  assert.equal(computeFollowupOccurrence(30, DEFAULT_CONFIG), 1);
  assert.equal(computeFollowupOccurrence(30, CUSTOM_CONFIG), null);
});

test("Config 11: defaults reproduce the exact pre-configuration 24h/72h behavior", () => {
  assert.equal(computeFollowupOccurrence(23, DEFAULT_CONFIG), null);
  assert.equal(computeFollowupOccurrence(24, DEFAULT_CONFIG), 1);
  assert.equal(computeFollowupOccurrence(71, DEFAULT_CONFIG), 1);
  assert.equal(computeFollowupOccurrence(72, DEFAULT_CONFIG), 2);
});

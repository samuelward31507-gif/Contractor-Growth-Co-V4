/**
 * Pass 5A: unit tests for computeScheduledAutomationLivenessState
 * (lib/automation-health/scheduled-automation-liveness.ts) - pure, no
 * Supabase round trip needed. Mirrors scheduler-liveness.test.ts's own
 * established shape for isHealthCheckStale.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation-health/scheduled-automation-liveness.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  computeScheduledAutomationLivenessState,
  SCHEDULED_AUTOMATION_STALE_THRESHOLD_MS,
  SCHEDULED_AUTOMATION_IDS,
}: typeof import("./scheduled-automation-liveness") = require("./scheduled-automation-liveness.ts");

const NOW = Date.parse("2026-09-25T12:00:00.000Z");

test("never observed running at all: unverified, never 'stale' - no evidence must never read as a false alarm", () => {
  assert.equal(computeScheduledAutomationLivenessState(null, NOW), "unverified");
});

test("a run within the grace window: healthy", () => {
  const recentIso = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
  assert.equal(computeScheduledAutomationLivenessState(recentIso, NOW), "healthy");
});

test("a run right at the threshold boundary: not yet stale (strictly greater-than, not >=)", () => {
  const boundaryIso = new Date(NOW - SCHEDULED_AUTOMATION_STALE_THRESHOLD_MS).toISOString();
  assert.equal(computeScheduledAutomationLivenessState(boundaryIso, NOW), "healthy");
});

test("a run one millisecond past the threshold: stale", () => {
  const pastIso = new Date(NOW - SCHEDULED_AUTOMATION_STALE_THRESHOLD_MS - 1).toISOString();
  assert.equal(computeScheduledAutomationLivenessState(pastIso, NOW), "stale");
});

test("a run well past the threshold (the schedule has clearly stopped): stale", () => {
  const veryOldIso = new Date(NOW - 5 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(computeScheduledAutomationLivenessState(veryOldIso, NOW), "stale");
});

test("the tracked automation id list is exactly the 5 real cron-dependent routes, not derived from catalog kind", () => {
  assert.deepEqual(
    [...SCHEDULED_AUTOMATION_IDS].sort(),
    ["appointment-reminders", "customer-reactivation", "estimate-followup", "lead-reactivation", "lost-lead-nurture"].sort(),
  );
});

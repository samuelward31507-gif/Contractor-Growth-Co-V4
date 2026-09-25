/**
 * SCHED-01 (pre-launch lead-leak audit): unit tests for isHealthCheckStale
 * (lib/automation-health/health.ts) - pure, no Supabase round trip needed.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation-health/scheduler-liveness.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { isHealthCheckStale, HEALTH_CHECK_STALE_THRESHOLD_MS }: typeof import("./health") = require("./health.ts");

const NOW = Date.parse("2026-09-25T12:00:00.000Z");

test("no health check has ever run: stale (never ran is at least as concerning as ran-a-while-ago)", () => {
  assert.equal(isHealthCheckStale(null, NOW), true);
});

test("a health check within the threshold: not stale", () => {
  const recentIso = new Date(NOW - 10 * 60 * 1000).toISOString();
  assert.equal(isHealthCheckStale(recentIso, NOW), false);
});

test("a health check right at the threshold boundary: not yet stale (strictly greater-than, not >=)", () => {
  const boundaryIso = new Date(NOW - HEALTH_CHECK_STALE_THRESHOLD_MS).toISOString();
  assert.equal(isHealthCheckStale(boundaryIso, NOW), false);
});

test("a health check one millisecond past the threshold: stale", () => {
  const pastIso = new Date(NOW - HEALTH_CHECK_STALE_THRESHOLD_MS - 1).toISOString();
  assert.equal(isHealthCheckStale(pastIso, NOW), true);
});

test("a health check well past the threshold (scheduler has clearly stopped): stale", () => {
  const veryOldIso = new Date(NOW - 3 * 60 * 60 * 1000).toISOString();
  assert.equal(isHealthCheckStale(veryOldIso, NOW), true);
});

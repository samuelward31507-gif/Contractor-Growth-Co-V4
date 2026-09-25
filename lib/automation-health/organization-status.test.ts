/**
 * Pass 5A: pure unit tests for organizationStatus()'s precedence rule
 * (lib/automation-health/health.ts) - no Supabase round trip needed.
 * Deliberately does NOT rely on real, time-accumulating
 * automation_schedule_runs data (see the integration test file's own note
 * on why that would be flaky against real production traffic) - every
 * input here is a plain, deterministic object.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation-health/organization-status.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { organizationStatus }: typeof import("./health") = require("./health.ts");

const HEALTHY_BASE = { paymentStatus: "active" as const, automationPaused: false, criticalCount: 0, activeCount: 0, staleScheduledAutomationCount: 0 };

test("a fully healthy organization is 'healthy'", () => {
  assert.equal(organizationStatus(HEALTHY_BASE), "healthy");
});

test("a critical incident alone makes it 'unhealthy'", () => {
  assert.equal(organizationStatus({ ...HEALTHY_BASE, criticalCount: 1 }), "unhealthy");
});

test("a non-critical active incident alone makes it 'degraded', not 'unhealthy'", () => {
  assert.equal(organizationStatus({ ...HEALTHY_BASE, activeCount: 1 }), "degraded");
});

test("a stale scheduled automation alone makes it 'degraded', not 'unhealthy' - an unproven signal, never treated as confirmed critical failure", () => {
  assert.equal(organizationStatus({ ...HEALTHY_BASE, staleScheduledAutomationCount: 1 }), "degraded");
});

test("payment_status !== 'active' makes it 'payment_blocked', even with zero incidents", () => {
  for (const paymentStatus of ["payment_required", "suspended", "cancelled"] as const) {
    assert.equal(organizationStatus({ ...HEALTHY_BASE, paymentStatus }), "payment_blocked");
  }
});

test("automation_paused makes it 'paused', even with zero incidents", () => {
  assert.equal(organizationStatus({ ...HEALTHY_BASE, automationPaused: true }), "paused");
});

test("payment_blocked takes precedence over paused", () => {
  assert.equal(organizationStatus({ ...HEALTHY_BASE, paymentStatus: "suspended", automationPaused: true }), "payment_blocked");
});

test("payment_blocked takes precedence over a critical incident - a payment block is never masked by, or downgraded to, an incident-derived status", () => {
  assert.equal(organizationStatus({ ...HEALTHY_BASE, paymentStatus: "cancelled", criticalCount: 5 }), "payment_blocked");
});

test("paused takes precedence over a critical incident", () => {
  assert.equal(organizationStatus({ ...HEALTHY_BASE, automationPaused: true, criticalCount: 5 }), "paused");
});

test("unhealthy (critical) takes precedence over merely degraded conditions", () => {
  assert.equal(organizationStatus({ ...HEALTHY_BASE, criticalCount: 1, activeCount: 3, staleScheduledAutomationCount: 2 }), "unhealthy");
});

/**
 * Unit tests for summarizeOpportunities() - pure, no I/O. Pass 3 (Revenue
 * Intelligence Foundation), Part 12.
 *
 * Run with:
 *   node --test lib/opportunities/queries.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { summarizeOpportunities }: typeof import("./queries") = require("./queries.ts");

function makeOpportunity(overrides: Partial<import("./queries").Opportunity> = {}): import("./queries").Opportunity {
  return {
    id: overrides.id ?? "00000000-0000-0000-0000-000000000000",
    type: overrides.type ?? "qualified_lead_unbooked",
    status: overrides.status ?? "open",
    sourceEntityType: overrides.sourceEntityType ?? "lead",
    sourceEntityId: overrides.sourceEntityId ?? "lead-1",
    contactId: overrides.contactId ?? null,
    title: overrides.title ?? "Test opportunity",
    description: overrides.description ?? null,
    estimatedValue: overrides.estimatedValue ?? null,
    valueBasis: overrides.valueBasis ?? null,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    resolvedAt: overrides.resolvedAt ?? null,
    metadata: overrides.metadata ?? {},
  };
}

test("empty list: a real zeroed summary, never null and never a fabricated non-zero", () => {
  const summary = summarizeOpportunities([]);
  assert.equal(summary.count, 0);
  assert.equal(summary.knownEstimatedValue, 0);
  assert.equal(summary.unknownValueCount, 0);
  assert.deepEqual(summary.byType, {
    qualified_lead_unbooked: 0,
    stale_estimate: 0,
    completed_appointment_no_estimate: 0,
    dormant_customer: 0,
    no_show: 0,
  });
});

test("a null estimatedValue is counted as unknown, never coerced to 0 in the sum", () => {
  const summary = summarizeOpportunities([
    makeOpportunity({ id: "1", type: "dormant_customer", estimatedValue: null }),
    makeOpportunity({ id: "2", type: "stale_estimate", estimatedValue: 500 }),
  ]);
  assert.equal(summary.count, 2);
  assert.equal(summary.knownEstimatedValue, 500, "the null-value opportunity must be excluded from the sum, never treated as 0");
  assert.equal(summary.unknownValueCount, 1);
});

test("known values sum correctly across multiple opportunities of the same type", () => {
  const summary = summarizeOpportunities([
    makeOpportunity({ id: "1", type: "stale_estimate", estimatedValue: 300 }),
    makeOpportunity({ id: "2", type: "stale_estimate", estimatedValue: 450 }),
  ]);
  assert.equal(summary.knownEstimatedValue, 750);
  assert.equal(summary.unknownValueCount, 0);
  assert.equal(summary.byType.stale_estimate, 2);
});

test("byType counts every opportunity exactly once, under its own real type - never double-counted or miscategorized", () => {
  const summary = summarizeOpportunities([
    makeOpportunity({ id: "1", type: "qualified_lead_unbooked" }),
    makeOpportunity({ id: "2", type: "qualified_lead_unbooked" }),
    makeOpportunity({ id: "3", type: "no_show" }),
    makeOpportunity({ id: "4", type: "completed_appointment_no_estimate" }),
  ]);
  assert.equal(summary.count, 4);
  assert.equal(summary.byType.qualified_lead_unbooked, 2);
  assert.equal(summary.byType.no_show, 1);
  assert.equal(summary.byType.completed_appointment_no_estimate, 1);
  assert.equal(summary.byType.stale_estimate, 0);
  assert.equal(summary.byType.dormant_customer, 0);
});

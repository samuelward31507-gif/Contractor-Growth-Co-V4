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
const { summarizeOpportunities, OPPORTUNITY_VALUE_CLASS }: typeof import("./queries") = require("./queries.ts");

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
    resolutionReason: overrides.resolutionReason ?? null,
    metadata: overrides.metadata ?? {},
  };
}

test("empty list: a real zeroed summary, never null and never a fabricated non-zero", () => {
  const summary = summarizeOpportunities([]);
  assert.equal(summary.count, 0);
  assert.deepEqual(summary.committed, { value: 0, count: 0, unknownValueCount: 0 });
  assert.deepEqual(summary.potential, { value: 0, count: 0, unknownValueCount: 0 });
  assert.equal(summary.nonMonetaryCount, 0);
  assert.deepEqual(summary.byType, {
    qualified_lead_unbooked: 0,
    stale_estimate: 0,
    completed_appointment_no_estimate: 0,
    dormant_customer: 0,
    no_show: 0,
    completed_job_no_referral_request: 0,
    completed_job_no_review_request: 0,
    cancelled_appointment_no_rebooking: 0,
    uncontacted_lead: 0,
    accepted_estimate_no_job: 0,
    active_lead_signal: 0,
    pending_estimate: 0,
    completed_job_not_invoiced: 0,
    invoice_overdue: 0,
  });
});

test("a null estimatedValue is counted as unknown, never coerced to 0 in the sum", () => {
  const summary = summarizeOpportunities([
    makeOpportunity({ id: "1", type: "qualified_lead_unbooked", estimatedValue: null }),
    makeOpportunity({ id: "2", type: "stale_estimate", estimatedValue: 500 }),
  ]);
  assert.equal(summary.count, 2);
  assert.deepEqual(summary.potential, { value: 500, count: 2, unknownValueCount: 1 }, "the null-value opportunity must be excluded from the sum, never treated as 0");
});

test("known values sum correctly across multiple opportunities of the same type", () => {
  const summary = summarizeOpportunities([
    makeOpportunity({ id: "1", type: "stale_estimate", estimatedValue: 300 }),
    makeOpportunity({ id: "2", type: "stale_estimate", estimatedValue: 450 }),
  ]);
  assert.deepEqual(summary.potential, { value: 750, count: 2, unknownValueCount: 0 });
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

test("Pass 4 P1-D: completed_job_no_referral_request counts correctly and supports a 'job' source entity type", () => {
  const opportunity = makeOpportunity({ id: "1", type: "completed_job_no_referral_request", sourceEntityType: "job", sourceEntityId: "job-1", estimatedValue: null });
  const summary = summarizeOpportunities([opportunity]);
  assert.equal(summary.byType.completed_job_no_referral_request, 1);
  // Phase 2-13: referral is non-monetary - it never carries a value and is never counted as missing one.
  assert.equal(summary.nonMonetaryCount, 1);
  assert.equal(summary.committed.unknownValueCount + summary.potential.unknownValueCount, 0);
});

// ---------------------------------------------------------------------------
// Phase 2-13 (§7): value classes
// ---------------------------------------------------------------------------

test("value classes: committed is money owed or agreed (overdue invoice, uninvoiced completed job, accepted estimate); potential is money not yet agreed (sent or expired estimates, leads); everything else is non-monetary", () => {
  assert.deepEqual(OPPORTUNITY_VALUE_CLASS, {
    invoice_overdue: "committed",
    completed_job_not_invoiced: "committed",
    accepted_estimate_no_job: "committed",
    pending_estimate: "potential",
    stale_estimate: "potential",
    uncontacted_lead: "potential",
    qualified_lead_unbooked: "potential",
    active_lead_signal: "potential",
    completed_job_no_review_request: "non_monetary",
    completed_job_no_referral_request: "non_monetary",
    no_show: "non_monetary",
    cancelled_appointment_no_rebooking: "non_monetary",
    dormant_customer: "non_monetary",
    completed_appointment_no_estimate: "non_monetary",
  });
});

test("value classes: committed and potential money are totalled separately - never one combined figure", () => {
  const summary = summarizeOpportunities([
    makeOpportunity({ id: "1", type: "invoice_overdue", contactId: "c-1", estimatedValue: 400 }),
    makeOpportunity({ id: "2", type: "accepted_estimate_no_job", contactId: "c-2", estimatedValue: 600 }),
    makeOpportunity({ id: "3", type: "pending_estimate", contactId: "c-3", estimatedValue: 2000 }),
    makeOpportunity({ id: "4", type: "qualified_lead_unbooked", contactId: "c-4", estimatedValue: 300 }),
  ]);
  assert.deepEqual(summary.committed, { value: 1000, count: 2, unknownValueCount: 0 });
  assert.deepEqual(summary.potential, { value: 2300, count: 2, unknownValueCount: 0 });
  assert.equal(Object.keys(summary).includes("knownEstimatedValue"), false, "no combined total exists");
});

test("value classes: a non-monetary opportunity is never counted as missing a value, and a stray value on one never reaches a money total", () => {
  const summary = summarizeOpportunities([
    makeOpportunity({ id: "1", type: "completed_job_no_review_request", estimatedValue: null }),
    makeOpportunity({ id: "2", type: "no_show", estimatedValue: null }),
    makeOpportunity({ id: "3", type: "dormant_customer", estimatedValue: 900 }),
    makeOpportunity({ id: "4", type: "completed_appointment_no_estimate", estimatedValue: null }),
  ]);
  assert.equal(summary.nonMonetaryCount, 4);
  assert.deepEqual([summary.committed, summary.potential], [{ value: 0, count: 0, unknownValueCount: 0 }, { value: 0, count: 0, unknownValueCount: 0 }]);
});

test("value classes (§7 no double counting): one customer's most advanced record supplies the value - invoice over job over estimate over lead - while every item still counts", () => {
  const summary = summarizeOpportunities([
    makeOpportunity({ id: "1", type: "invoice_overdue", contactId: "c-1", estimatedValue: 500 }),
    makeOpportunity({ id: "2", type: "completed_job_not_invoiced", contactId: "c-1", estimatedValue: 500 }),
    makeOpportunity({ id: "3", type: "stale_estimate", contactId: "c-1", estimatedValue: 500 }),
    makeOpportunity({ id: "4", type: "qualified_lead_unbooked", contactId: "c-1", estimatedValue: 500 }),
    makeOpportunity({ id: "5", type: "pending_estimate", contactId: "c-2", estimatedValue: 800 }),
    makeOpportunity({ id: "6", type: "uncontacted_lead", contactId: "c-2", estimatedValue: 300 }),
  ]);
  assert.deepEqual(summary.committed, { value: 500, count: 2, unknownValueCount: 0 }, "the invoice supplies c-1's value; the job behind it does not add again");
  assert.deepEqual(summary.potential, { value: 800, count: 4, unknownValueCount: 0 }, "c-1's estimate and lead are superseded by the invoice; c-2's estimate supersedes their lead");
  assert.equal(summary.count, 6);
});

test("value classes: two estimates for one customer are both counted (same stage, different records); a null-value advanced record does not hide a valued earlier one", () => {
  const summary = summarizeOpportunities([
    makeOpportunity({ id: "1", type: "pending_estimate", contactId: "c-1", estimatedValue: 1000 }),
    makeOpportunity({ id: "2", type: "stale_estimate", contactId: "c-1", estimatedValue: 700 }),
    makeOpportunity({ id: "3", type: "completed_job_not_invoiced", contactId: "c-2", estimatedValue: null }),
    makeOpportunity({ id: "4", type: "stale_estimate", contactId: "c-2", estimatedValue: 450 }),
  ]);
  assert.deepEqual(summary.potential, { value: 2150, count: 3, unknownValueCount: 0 });
  assert.deepEqual(summary.committed, { value: 0, count: 1, unknownValueCount: 1 });
});

test("value classes: an opportunity with no contact is always counted - it cannot be matched to another record", () => {
  const summary = summarizeOpportunities([
    makeOpportunity({ id: "1", type: "invoice_overdue", contactId: null, estimatedValue: 250 }),
    makeOpportunity({ id: "2", type: "stale_estimate", contactId: null, estimatedValue: 750 }),
  ]);
  assert.deepEqual([summary.committed.value, summary.potential.value], [250, 750]);
});

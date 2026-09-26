/**
 * Pure unit tests for lib/agency/expansion.ts's non-I/O logic - the
 * recommended-service mapping, the deterministic confidence classification,
 * and the summary aggregation - kept separate from
 * expansion.integration.test.ts (real DB, authorization) and
 * expansion.partial-data.test.ts (mocked Supabase client), matching this
 * codebase's own established split (see lib/opportunities/queries.ts's
 * summarizeOpportunities, tested the same way elsewhere).
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/agency/expansion.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  OPPORTUNITY_TYPE_TO_SERVICE,
  CONTEXTUAL_VALUE_TYPES,
  classifyExpansionConfidence,
  summarizeAgencyExpansion,
}: typeof import("./expansion") = require("./expansion.ts");

const ALL_TYPES = [
  "qualified_lead_unbooked",
  "stale_estimate",
  "completed_appointment_no_estimate",
  "dormant_customer",
  "no_show",
  "completed_job_no_referral_request",
  "completed_job_no_review_request",
  "cancelled_appointment_no_rebooking",
  "uncontacted_lead",
  "accepted_estimate_no_job",
] as const;

test("1. every one of the Opportunity Engine's 10 types has an explicit recommended-service mapping - no type falls through to an invented default", () => {
  for (const type of ALL_TYPES) {
    assert.equal(typeof OPPORTUNITY_TYPE_TO_SERVICE[type], "string");
    assert.ok(OPPORTUNITY_TYPE_TO_SERVICE[type].length > 0);
  }
});

test("2. the mapping matches the task's explicit table exactly", () => {
  assert.equal(OPPORTUNITY_TYPE_TO_SERVICE.stale_estimate, "Estimate Recovery");
  assert.equal(OPPORTUNITY_TYPE_TO_SERVICE.accepted_estimate_no_job, "Estimate Recovery");
  assert.equal(OPPORTUNITY_TYPE_TO_SERVICE.qualified_lead_unbooked, "Lead Response / Booking Assist");
  assert.equal(OPPORTUNITY_TYPE_TO_SERVICE.uncontacted_lead, "Lead Response / Booking Assist");
  assert.equal(OPPORTUNITY_TYPE_TO_SERVICE.dormant_customer, "Customer Reactivation");
  assert.equal(OPPORTUNITY_TYPE_TO_SERVICE.completed_job_no_review_request, "Review Growth");
  assert.equal(OPPORTUNITY_TYPE_TO_SERVICE.completed_job_no_referral_request, "Referral Program");
  assert.equal(OPPORTUNITY_TYPE_TO_SERVICE.no_show, "Scheduling Optimization");
  assert.equal(OPPORTUNITY_TYPE_TO_SERVICE.cancelled_appointment_no_rebooking, "Scheduling Optimization");
  assert.equal(OPPORTUNITY_TYPE_TO_SERVICE.completed_appointment_no_estimate, "Estimate Follow-Through");
});

test("3. none of the disallowed speculative services (missed_call_recovery, ai_receptionist, marketing_expansion, website_conversion) appear anywhere in the mapping", () => {
  const services = Object.values(OPPORTUNITY_TYPE_TO_SERVICE);
  for (const disallowed of ["missed_call_recovery", "ai_receptionist", "marketing_expansion", "website_conversion", "Missed Call Recovery", "AI Receptionist"]) {
    assert.equal(services.includes(disallowed), false, `"${disallowed}" must never appear - no data source exists to justify it`);
  }
});

test("4. confidence is 'high' for a monetary type with a known value, 'medium' for a monetary type with an unknown value", () => {
  assert.equal(classifyExpansionConfidence("stale_estimate", 5000), "high");
  assert.equal(classifyExpansionConfidence("stale_estimate", null), "medium");
  assert.equal(classifyExpansionConfidence("dormant_customer", null), "medium");
  assert.equal(classifyExpansionConfidence("qualified_lead_unbooked", 1200), "high");
});

test("5. confidence is 'informational' for every contextual-value type, regardless of whether a value happens to be attached", () => {
  for (const type of CONTEXTUAL_VALUE_TYPES) {
    assert.equal(classifyExpansionConfidence(type, null), "informational");
  }
  // completed_job_no_review_request is the one contextual type that can carry
  // a non-null value (the completed job's own amount, as size-of-job
  // context) - confidence must stay "informational", never promoted to
  // "high" just because a number happens to be present.
  assert.equal(classifyExpansionConfidence("completed_job_no_review_request", 8000), "informational");
});

function opportunity(overrides: Partial<Parameters<typeof summarizeAgencyExpansion>[0][number]> = {}) {
  return {
    opportunityId: "opp-1",
    organizationId: "org-1",
    organizationName: "Org One",
    type: "stale_estimate" as const,
    title: "Test",
    description: "Test",
    estimatedValue: null,
    valueBasis: null,
    affectedCount: 1 as const,
    recommendedService: "Estimate Recovery",
    confidence: "medium" as const,
    isContextualValue: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    actionHref: "/agency/organizations/org-1",
    actionLabel: "View client",
    ...overrides,
  };
}

test("6. knownOpportunityValue sums only non-contextual opportunities with a non-null value - never coerces a null to 0", () => {
  const summary = summarizeAgencyExpansion([
    opportunity({ estimatedValue: 5000 }),
    opportunity({ opportunityId: "opp-2", estimatedValue: null }),
    opportunity({ opportunityId: "opp-3", estimatedValue: 3000 }),
  ]);

  assert.equal(summary.knownOpportunityValue, 8000, "must be exactly the sum of the two known values, never including the null one as 0");
  assert.equal(summary.unknownValueOpportunityCount, 1);
  assert.equal(summary.openOpportunityCount, 3);
});

test("7. a contextual-value opportunity's estimatedValue (even when non-null) is excluded from knownOpportunityValue and from unknownValueOpportunityCount, counted only in contextualOpportunityCount", () => {
  const summary = summarizeAgencyExpansion([
    opportunity({ estimatedValue: 5000 }),
    opportunity({
      opportunityId: "opp-2",
      type: "completed_job_no_review_request",
      isContextualValue: true,
      estimatedValue: 9000, // the completed job's own amount, context only
      recommendedService: "Review Growth",
    }),
    opportunity({
      opportunityId: "opp-3",
      type: "completed_appointment_no_estimate",
      isContextualValue: true,
      estimatedValue: null,
      recommendedService: "Estimate Follow-Through",
    }),
  ]);

  assert.equal(summary.knownOpportunityValue, 5000, "the $9,000 job-context value must never be folded into known opportunity value");
  assert.equal(summary.unknownValueOpportunityCount, 0, "the two contextual items must not inflate the unknown-value count either");
  assert.equal(summary.contextualOpportunityCount, 2);
  assert.equal(summary.openOpportunityCount, 3);
});

test("8. organizationsWithOpportunities counts distinct organizations, not opportunity rows", () => {
  const summary = summarizeAgencyExpansion([
    opportunity({ organizationId: "org-1" }),
    opportunity({ opportunityId: "opp-2", organizationId: "org-1" }),
    opportunity({ opportunityId: "opp-3", organizationId: "org-2" }),
  ]);

  assert.equal(summary.organizationsWithOpportunities, 2);
  assert.equal(summary.openOpportunityCount, 3);
});

test("9. an empty list summarizes to all-zero, never throwing and never fabricating a value", () => {
  const summary = summarizeAgencyExpansion([]);
  assert.deepEqual(summary, {
    organizationsWithOpportunities: 0,
    openOpportunityCount: 0,
    knownOpportunityValue: 0,
    unknownValueOpportunityCount: 0,
    contextualOpportunityCount: 0,
  });
});

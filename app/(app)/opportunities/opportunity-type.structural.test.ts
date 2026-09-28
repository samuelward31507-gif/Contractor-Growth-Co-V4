/**
 * Phase 1B-5: the presentation maps for opportunity types stay exhaustive
 * and the two invoice types land on real routes. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test "app/(app)/opportunities/opportunity-type.structural.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { OPPORTUNITY_TYPE_ORDER, OPPORTUNITY_TYPE_LABEL, OPPORTUNITY_TYPE_ICON, OPPORTUNITY_TYPE_TONE, OPPORTUNITY_ACTION_LABEL, opportunityActionHref }: typeof import("./_components/opportunity-type") = require("./_components/opportunity-type.ts");
const { TIER_BY_TYPE }: typeof import("@/lib/opportunities/intelligence") = require("../../../lib/opportunities/intelligence.ts");

type Opportunity = import("@/lib/opportunities/queries").Opportunity;

function makeOpportunity(overrides: Partial<Opportunity>): Opportunity {
  return {
    id: "opp-1",
    type: "invoice_overdue",
    status: "open",
    sourceEntityType: "job",
    sourceEntityId: "job-1",
    contactId: "contact-1",
    title: "Ann Lee",
    description: null,
    estimatedValue: null,
    valueBasis: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    resolvedAt: null,
    resolutionReason: null,
    metadata: {},
    ...overrides,
  };
}

test("every opportunity type the intelligence layer knows has an order position, a label, an icon, a tone and an action label", () => {
  const types = Object.keys(TIER_BY_TYPE);
  assert.equal(types.length, 14);
  for (const type of types) {
    assert.ok(OPPORTUNITY_TYPE_ORDER.includes(type as never), `${type} in order`);
    assert.ok(OPPORTUNITY_TYPE_LABEL[type as keyof typeof OPPORTUNITY_TYPE_LABEL], `${type} label`);
    assert.ok(OPPORTUNITY_TYPE_ICON[type as keyof typeof OPPORTUNITY_TYPE_ICON], `${type} icon`);
    assert.ok(OPPORTUNITY_TYPE_TONE[type as keyof typeof OPPORTUNITY_TYPE_TONE], `${type} tone`);
    assert.ok(OPPORTUNITY_ACTION_LABEL[type as keyof typeof OPPORTUNITY_ACTION_LABEL], `${type} action label`);
  }
  assert.equal(new Set(OPPORTUNITY_TYPE_ORDER).size, OPPORTUNITY_TYPE_ORDER.length, "no duplicates in the display order");
});

test("the two invoice types land on the job page (create invoice) and the invoice page (collect payment), with a real fallback when metadata is missing", () => {
  assert.equal(opportunityActionHref(makeOpportunity({ type: "completed_job_not_invoiced", sourceEntityId: "job-9" })), "/jobs/job-9");
  assert.equal(opportunityActionHref(makeOpportunity({ type: "invoice_overdue", sourceEntityId: "job-9", metadata: { invoice_id: "inv-3" } })), "/invoices/inv-3");
  assert.equal(opportunityActionHref(makeOpportunity({ type: "invoice_overdue", sourceEntityId: "job-9", metadata: {} })), "/money?browse=invoices&status=overdue");
  assert.equal(OPPORTUNITY_ACTION_LABEL.completed_job_not_invoiced, "Create invoice");
  assert.equal(OPPORTUNITY_ACTION_LABEL.invoice_overdue, "View invoice");
  assert.equal(OPPORTUNITY_TYPE_TONE.invoice_overdue, "danger");
  assert.ok(OPPORTUNITY_TYPE_ORDER.indexOf("invoice_overdue") < OPPORTUNITY_TYPE_ORDER.indexOf("qualified_lead_unbooked"), "committed revenue at risk sorts ahead of active pursuit, matching TIER_ORDER");
});

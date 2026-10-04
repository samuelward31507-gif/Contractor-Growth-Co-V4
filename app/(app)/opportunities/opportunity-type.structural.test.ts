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
const { OPPORTUNITY_TYPE_ORDER, OPPORTUNITY_TYPE_LABEL, OPPORTUNITY_TYPE_ICON, OPPORTUNITY_TYPE_TONE, OPPORTUNITY_ACTION_LABEL, opportunityActionHref, groupTotalLabel }: typeof import("./_components/opportunity-type") = require("./_components/opportunity-type.ts");
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

// ---------------------------------------------------------------------------
// Phase 2-13 (§7): By type shows one total per value class, never a combined one
// ---------------------------------------------------------------------------

test("By type group header: a committed or potential group shows its class total and count; a non-monetary group shows its count only", () => {
  assert.equal(groupTotalLabel("invoice_overdue", [makeOpportunity({ id: "a", estimatedValue: 450 }), makeOpportunity({ id: "b", contactId: "contact-2", estimatedValue: 550 })]), "$1,000 committed · 2");
  assert.equal(groupTotalLabel("stale_estimate", [makeOpportunity({ id: "a", type: "stale_estimate", estimatedValue: 1200 }), makeOpportunity({ id: "b", type: "stale_estimate", estimatedValue: null })]), "$1,200 potential · 2", "an unknown value is not counted as $0 - it is simply not in the sum");
  assert.equal(groupTotalLabel("qualified_lead_unbooked", [makeOpportunity({ id: "a", type: "qualified_lead_unbooked", estimatedValue: null })]), "1", "no value entered anywhere in the group: never a '$0 potential' total");
  assert.equal(groupTotalLabel("completed_job_no_referral_request", [makeOpportunity({ id: "a", type: "completed_job_no_referral_request" })]), "1");
  assert.equal(groupTotalLabel("dormant_customer", [makeOpportunity({ id: "a", type: "dormant_customer", estimatedValue: 900 })]), "1", "a stray value on a non-monetary type is never shown as money");
});

test("By type summary line and rows: separate committed and potential totals; a non-monetary row never says 'Unknown value'; item values render unchanged", () => {
  const fs: typeof import("node:fs") = require("node:fs");
  const list = fs.readFileSync(require("node:path").join(process.cwd(), "app/(app)/opportunities/_components/opportunities-list.tsx"), "utf8");
  assert.match(list, /summary\.committed\.count > 0 \? `\$\{formatCurrency\(summary\.committed\.value\)\} committed · ` : ""/);
  assert.match(list, /summary\.potential\.count > 0 \? `\$\{formatCurrency\(summary\.potential\.value\)\} potential · ` : ""/);
  assert.doesNotMatch(list, /summary\.committed\.value \+ summary\.potential\.value|knownEstimatedValue/, "never one combined total");
  assert.match(list, /OPPORTUNITY_VALUE_CLASS\[opportunity\.type\] === "non_monetary" \? null : \(/);
  assert.match(list, /\{formatCurrency\(opportunity\.estimatedValue\)\}/, "each item's own value is shown as before");
  assert.match(list, /\{groupTotalLabel\(type, items\)\}/);
});

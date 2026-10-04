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
const { summarizeOpportunities, sameDealSupersededIds, OPPORTUNITY_VALUE_CLASS }: typeof import("./queries") = require("./queries.ts");

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

test("value classes: an opportunity with no contact is always counted - it cannot be matched to another record", () => {
  const summary = summarizeOpportunities([
    makeOpportunity({ id: "1", type: "invoice_overdue", contactId: null, estimatedValue: 250 }),
    makeOpportunity({ id: "2", type: "stale_estimate", contactId: null, estimatedValue: 750 }),
  ]);
  assert.deepEqual([summary.committed.value, summary.potential.value], [250, 750]);
});

// ---------------------------------------------------------------------------
// Phase 2-13 correction: deal-level attribution, never customer-level.
// Same deal -> deduplicate. Same customer, different deal -> count separately.
// ---------------------------------------------------------------------------

const lead = (id: string, contactId: string, type: "uncontacted_lead" | "qualified_lead_unbooked" | "active_lead_signal", value: number | null) =>
  makeOpportunity({ id, type, sourceEntityType: "lead", sourceEntityId: id, contactId, estimatedValue: value });
const estimate = (id: string, contactId: string, value: number | null, leadId: string | null = null, type: "pending_estimate" | "stale_estimate" = "pending_estimate") =>
  makeOpportunity({ id, type, sourceEntityType: "estimate", sourceEntityId: id, contactId, estimatedValue: value, metadata: type === "pending_estimate" ? { estimate_id: id, lead_id: leadId } : {} });
const committedRecord = (id: string, contactId: string, type: "invoice_overdue" | "completed_job_not_invoiced" | "accepted_estimate_no_job", value: number) =>
  makeOpportunity({ id, type, sourceEntityType: type === "accepted_estimate_no_job" ? "estimate" : "job", sourceEntityId: `src-${id}`, contactId, estimatedValue: value });
const job = (id: string, contactId: string, type: "completed_job_no_review_request" | "completed_job_no_referral_request") => makeOpportunity({ id, type, sourceEntityType: "job", sourceEntityId: `job-${id}`, contactId });

/**
 * The exact shape of the TEST QA organization that exposed the customer-level
 * bug on the preview: Casey Reed has overdue invoices AND three unrelated sent
 * estimates; Avery Stone has an accepted estimate, an uninvoiced job AND seven
 * unrelated uncontacted leads; Blake Morgan has one overdue invoice; plus five
 * review and five referral asks. Customer-level dedup reported $8,700
 * committed and $0 potential.
 */
function qaOrganization() {
  return [
    committedRecord("casey-inv-4", "casey", "invoice_overdue", 3000),
    committedRecord("casey-inv-3", "casey", "invoice_overdue", 2000),
    committedRecord("blake-inv-1", "blake", "invoice_overdue", 2200),
    committedRecord("avery-accepted", "avery", "accepted_estimate_no_job", 2500),
    committedRecord("avery-job", "avery", "completed_job_not_invoiced", 1500),
    estimate("casey-est-2d", "casey", 1100, "casey-lead-a"),
    estimate("casey-est-15d", "casey", 2200, "casey-lead-b"),
    estimate("casey-est-40d", "casey", 3300, null),
    ...[500, 1000, 1000, 1000, 500, 500, 500].map((value, i) => lead(`avery-lead-${i}`, "avery", "uncontacted_lead", value)),
    ...["c1", "c2", "c3", "b1", "a1"].map((id) => job(`review-${id}`, id.startsWith("c") ? "casey" : id.startsWith("b") ? "blake" : "avery", "completed_job_no_review_request")),
    ...["c1", "c2", "c3", "b1", "a1"].map((id) => job(`referral-${id}`, id.startsWith("c") ? "casey" : id.startsWith("b") ? "blake" : "avery", "completed_job_no_referral_request")),
  ];
}

test("regression (preview QA): the QA organization totals $11,200 committed and $11,600 potential across 25 opportunities - never $8,700 / $0", () => {
  const summary = summarizeOpportunities(qaOrganization());
  assert.equal(summary.count, 25);
  assert.deepEqual(summary.committed, { value: 11200, count: 5, unknownValueCount: 0 });
  assert.deepEqual(summary.potential, { value: 11600, count: 10, unknownValueCount: 0 });
  assert.equal(summary.nonMonetaryCount, 10);
});

test("1. one customer with several independent potential deals - every one counts", () => {
  const summary = summarizeOpportunities([estimate("e1", "c-1", 1000), estimate("e2", "c-1", 2000), lead("l1", "c-1", "qualified_lead_unbooked", 700), lead("l2", "c-1", "uncontacted_lead", 300)]);
  assert.deepEqual(summary.potential, { value: 4000, count: 4, unknownValueCount: 0 });
});

test("2. one customer with an independent committed deal and separate potential deals - both classes count in full", () => {
  const summary = summarizeOpportunities([committedRecord("i1", "c-1", "invoice_overdue", 900), estimate("e1", "c-1", 1200), lead("l1", "c-1", "uncontacted_lead", 400)]);
  assert.deepEqual([summary.committed.value, summary.potential.value], [900, 1600]);
});

test("3. a lead with its own (valued) pending estimate is one deal - the estimate supplies the value, the lead does not add again", () => {
  const records = [lead("l1", "c-1", "qualified_lead_unbooked", 800), estimate("e1", "c-1", 1500, "l1")];
  const summary = summarizeOpportunities(records);
  assert.deepEqual(summary.potential, { value: 1500, count: 2, unknownValueCount: 0 });
  assert.deepEqual([...sameDealSupersededIds(records)], ["l1"]);
  for (const type of ["uncontacted_lead", "active_lead_signal"] as const) {
    assert.equal(summarizeOpportunities([lead("l1", "c-1", type, 800), estimate("e1", "c-1", 1500, "l1")]).potential.value, 1500, type);
  }
});

test("3b. the same-deal link is explicit only: a pending estimate with no value, or a stale estimate (no lead link), never hides the lead", () => {
  assert.equal(summarizeOpportunities([lead("l1", "c-1", "qualified_lead_unbooked", 800), estimate("e1", "c-1", null, "l1")]).potential.value, 800);
  assert.equal(summarizeOpportunities([lead("l1", "c-1", "qualified_lead_unbooked", 800), estimate("s1", "c-1", 1500, null, "stale_estimate")]).potential.value, 2300);
});

test("4. a lead whose customer has a completely separate estimate - both count", () => {
  const summary = summarizeOpportunities([lead("l1", "c-1", "uncontacted_lead", 600), estimate("e1", "c-1", 2000, "another-lead"), estimate("e2", "c-1", 900, null)]);
  assert.equal(summary.potential.value, 3500);
});

test("5. a customer with an invoice plus an unrelated estimate - both count", () => {
  const summary = summarizeOpportunities([committedRecord("i1", "c-1", "invoice_overdue", 3000), estimate("e1", "c-1", 1100)]);
  assert.deepEqual([summary.committed.value, summary.potential.value], [3000, 1100]);
});

test("6. a customer with a job plus an unrelated estimate - both count", () => {
  const summary = summarizeOpportunities([committedRecord("j1", "c-1", "completed_job_not_invoiced", 1500), estimate("e1", "c-1", 2200), committedRecord("a1", "c-1", "accepted_estimate_no_job", 2500)]);
  assert.deepEqual([summary.committed.value, summary.potential.value], [4000, 2200], "separate jobs and accepted estimates are separate revenue");
});

test("7. contact identity is never a dedup key - the same records with or without contacts total the same", () => {
  const withContacts = summarizeOpportunities(qaOrganization());
  const withoutContacts = summarizeOpportunities(qaOrganization().map((o) => ({ ...o, contactId: null })));
  assert.deepEqual([withContacts.committed, withContacts.potential], [withoutContacts.committed, withoutContacts.potential]);
});

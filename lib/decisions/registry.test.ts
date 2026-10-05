/**
 * Phase 2-2: the single next-action registry - frozen parity. Every string,
 * link and default action below is the literal pre-2-2 value (from
 * opportunity-type.ts, lib/today/copy.ts, intelligence.ts and Today's own
 * mapping at commit 2cab730). The registry moved them; these tests fail if
 * any of them changes.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/decisions/registry.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const registry: typeof import("./registry") = require(path.join(ROOT, "lib/decisions/registry.ts"));
const reasonCodes: typeof import("./reason-codes") = require(path.join(ROOT, "lib/decisions/reason-codes.ts"));
const opportunityType: typeof import("@/app/(app)/opportunities/_components/opportunity-type") = require(path.join(ROOT, "app/(app)/opportunities/_components/opportunity-type.ts"));
const copy: typeof import("@/lib/today/copy") = require(path.join(ROOT, "lib/today/copy.ts"));

type Opportunity = import("@/lib/opportunities/queries").Opportunity;
type OpportunityType = import("@/lib/opportunities/queries").OpportunityType;

const opp = (type: OpportunityType, overrides: Partial<Opportunity> = {}): Opportunity => ({
  id: "opp-1", type, status: "open", sourceEntityType: "lead", sourceEntityId: "src-1", contactId: "contact-1", title: "Ann Lee", description: null,
  estimatedValue: null, valueBasis: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", resolvedAt: null, resolutionReason: null, metadata: {},
  ...overrides,
});

test("the 22 approved reason codes, and the exact stored type / kind each one maps from", () => {
  assert.deepEqual(reasonCodes.REASON_CODE_BY_EXCEPTION_KIND, {
    human_escalation: "human_escalation",
    calendar_disconnected: "calendar_sync_failed",
    // P0 A2
    automation_needs_attention: "automation_needs_attention",
    automation_retrying: "automation_retrying",
  });
  assert.deepEqual(reasonCodes.REASON_CODE_BY_SIGNAL_KIND, {
    awaiting_reply: "customer_awaiting_reply",
    overdue_appointment: "appointment_overdue",
    awaiting_confirmation: "appointment_unconfirmed",
    abandoned_conversation: "conversation_stalled",
  });
  assert.deepEqual(reasonCodes.REASON_CODE_BY_OPPORTUNITY_TYPE, {
    accepted_estimate_no_job: "estimate_accepted_no_job",
    completed_job_not_invoiced: "job_completed_not_invoiced",
    invoice_overdue: "invoice_overdue",
    qualified_lead_unbooked: "qualified_not_booked",
    completed_appointment_no_estimate: "appointment_completed_no_estimate",
    uncontacted_lead: "lead_not_contacted",
    active_lead_signal: "lead_marked_hot_or_high_value",
    pending_estimate: "estimate_awaiting_decision",
    no_show: "appointment_no_show",
    cancelled_appointment_no_rebooking: "appointment_cancelled_not_rebooked",
    stale_estimate: "estimate_expired",
    dormant_customer: "customer_dormant",
    completed_job_no_review_request: "review_request_needed",
    completed_job_no_referral_request: "referral_request_needed",
  });
  const all = [...Object.values(reasonCodes.REASON_CODE_BY_EXCEPTION_KIND), ...Object.values(reasonCodes.REASON_CODE_BY_SIGNAL_KIND), ...Object.values(reasonCodes.REASON_CODE_BY_OPPORTUNITY_TYPE)];
  assert.equal(all.length, 22);
  assert.equal(new Set(all).size, 22, "one reason code per source");
  assert.deepEqual(Object.keys(registry.DECISION_REGISTRY).sort(), [...all].sort(), "the registry covers exactly the 22 codes");
});

test("opportunity problem labels (Today rows and By type headings) are the pre-2-2 strings, re-exported unchanged", () => {
  const expected: Record<OpportunityType, string> = {
    uncontacted_lead: "Never contacted",
    qualified_lead_unbooked: "Qualified, not booked",
    accepted_estimate_no_job: "Accepted, no job yet",
    stale_estimate: "Estimate expired",
    completed_appointment_no_estimate: "Visit completed, no estimate",
    no_show: "Missed appointment",
    cancelled_appointment_no_rebooking: "Cancelled, not rebooked",
    dormant_customer: "Dormant customer",
    completed_job_no_review_request: "Review request needed",
    completed_job_no_referral_request: "Referral request needed",
    active_lead_signal: "Marked hot or high-value",
    pending_estimate: "Estimate sent, awaiting reply",
    completed_job_not_invoiced: "Completed, not invoiced",
    invoice_overdue: "Invoice overdue",
  };
  assert.deepEqual(registry.OPPORTUNITY_TYPE_LABEL, expected);
  assert.equal(opportunityType.OPPORTUNITY_TYPE_LABEL, registry.OPPORTUNITY_TYPE_LABEL, "re-exported, not redeclared");
});

test("opportunity action labels are the pre-2-2 strings, re-exported unchanged", () => {
  const expected: Record<OpportunityType, string> = {
    uncontacted_lead: "View lead",
    qualified_lead_unbooked: "View lead",
    accepted_estimate_no_job: "View estimate",
    stale_estimate: "View estimate",
    completed_appointment_no_estimate: "Create estimate",
    no_show: "View schedule",
    cancelled_appointment_no_rebooking: "View schedule",
    dormant_customer: "View customer",
    completed_job_no_review_request: "View job",
    completed_job_no_referral_request: "View job",
    active_lead_signal: "View lead",
    pending_estimate: "View estimate",
    completed_job_not_invoiced: "Create invoice",
    invoice_overdue: "View invoice",
  };
  assert.deepEqual(registry.OPPORTUNITY_ACTION_LABEL, expected);
  assert.equal(opportunityType.OPPORTUNITY_ACTION_LABEL, registry.OPPORTUNITY_ACTION_LABEL);
});

test("opportunity action links, every type and every fallback, are the pre-2-2 links", () => {
  const href = registry.opportunityActionHref;
  const cases: [Opportunity, string][] = [
    [opp("uncontacted_lead"), "/people/contact-1"],
    [opp("uncontacted_lead", { contactId: null }), "/people"],
    [opp("qualified_lead_unbooked"), "/people/contact-1"],
    [opp("qualified_lead_unbooked", { contactId: null }), "/people"],
    [opp("active_lead_signal"), "/people/contact-1"],
    [opp("active_lead_signal", { contactId: null }), "/people"],
    [opp("accepted_estimate_no_job", { sourceEntityId: "est-7" }), "/estimates/est-7"],
    [opp("stale_estimate", { sourceEntityId: "est-8" }), "/estimates/est-8"],
    [opp("pending_estimate", { metadata: { estimate_id: "est-9" } }), "/estimates/est-9"],
    [opp("pending_estimate", { metadata: {} }), "/estimates"],
    [opp("pending_estimate", { metadata: { estimate_id: 42 } }), "/estimates"],
    [opp("completed_appointment_no_estimate"), "/estimates?new=estimate&contactId=contact-1"],
    [opp("completed_appointment_no_estimate", { contactId: null }), "/estimates"],
    [opp("no_show"), "/schedule?view=list"],
    [opp("cancelled_appointment_no_rebooking"), "/schedule?view=list"],
    [opp("dormant_customer"), "/people/contact-1"],
    [opp("dormant_customer", { contactId: null }), "/people"],
    [opp("completed_job_no_review_request", { sourceEntityId: "job-1" }), "/jobs/job-1"],
    [opp("completed_job_no_referral_request", { sourceEntityId: "job-2" }), "/jobs/job-2"],
    [opp("completed_job_not_invoiced", { sourceEntityId: "job-3" }), "/jobs/job-3"],
    [opp("invoice_overdue", { metadata: { invoice_id: "inv-4" } }), "/invoices/inv-4"],
    [opp("invoice_overdue", { metadata: {} }), "/money?browse=invoices&status=overdue"],
  ];
  for (const [opportunity, expected] of cases) assert.equal(href(opportunity), expected, `${opportunity.type} ${JSON.stringify({ contactId: opportunity.contactId, metadata: opportunity.metadata })}`);
  assert.equal(opportunityType.opportunityActionHref, registry.opportunityActionHref);
});

test("person links: the contact when there is one, Today's opportunity list when there isn't", () => {
  assert.equal(registry.opportunityPersonHref(opp("invoice_overdue")), "/people/contact-1");
  assert.equal(registry.opportunityPersonHref(opp("invoice_overdue", { contactId: null })), "/today?view=by-type#opportunities");
});

test("signal and exception labels and buttons are the pre-2-2 strings, and copy.ts reads them from the registry", () => {
  const rows = Object.fromEntries(Object.entries(registry.DECISION_REGISTRY).filter(([code]) => ["human_escalation", "calendar_sync_failed", "customer_awaiting_reply", "appointment_overdue", "appointment_unconfirmed", "conversation_stalled"].includes(code)).map(([code, entry]) => [code, [entry.problemLabel, entry.actionLabel]]));
  assert.deepEqual(rows, {
    human_escalation: ["Needs a human", "Review"],
    calendar_sync_failed: ["Calendar disconnected", "Review"],
    customer_awaiting_reply: ["Waiting on a reply", "Open conversation"],
    appointment_overdue: ["Appointment overdue", "View"],
    appointment_unconfirmed: ["Visit not confirmed", "View"],
    conversation_stalled: ["Conversation went quiet", "View"],
  });
  for (const kind of ["human_escalation", "calendar_disconnected", "awaiting_reply", "overdue_appointment", "awaiting_confirmation", "abandoned_conversation"] as const) {
    assert.equal(copy.ATTENTION_COPY[kind].label, registry.DECISION_ATTENTION_LABEL[kind], kind);
    assert.equal(copy.ATTENTION_COPY[kind].tone, "urgent", kind);
  }
});

test("default actions - opportunity types and signal kinds - are the pre-2-2 values", () => {
  assert.deepEqual(registry.DEFAULT_ACTION_BY_TYPE, {
    accepted_estimate_no_job: "create_job",
    completed_job_not_invoiced: "create_invoice",
    invoice_overdue: "collect_payment",
    qualified_lead_unbooked: "call",
    completed_appointment_no_estimate: "send_estimate",
    uncontacted_lead: "call",
    active_lead_signal: "call",
    pending_estimate: "monitor",
    no_show: "rebook",
    cancelled_appointment_no_rebooking: "rebook",
    stale_estimate: "follow_up_estimate",
    dormant_customer: "reactivate",
    completed_job_no_review_request: "request_review",
    completed_job_no_referral_request: "request_referral",
  });
  assert.deepEqual(registry.CONVERSATION_SIGNAL_ACTION, { awaiting_reply: "respond", overdue_appointment: "follow_up", awaiting_confirmation: "follow_up", abandoned_conversation: "follow_up" });
  assert.equal(registry.DECISION_REGISTRY.human_escalation.defaultAction, null);
  assert.equal(registry.DECISION_REGISTRY.calendar_sync_failed.defaultAction, null);
});

test("sentence construction: the action phrases, and reason + supporting + counter + phrase joined by single spaces with empties dropped", () => {
  assert.deepEqual(registry.ACTION_SENTENCE, {
    respond: "Reply to their message.",
    book: "Get it booked.",
    rebook: "Reach out to get it rebooked.",
    send_estimate: "Send an estimate.",
    follow_up_estimate: "Follow up on the estimate.",
    create_job: "Create the job.",
    reactivate: "Reach out to reconnect.",
    request_review: "Ask for a review.",
    request_referral: "Ask for a referral.",
    follow_up: "Follow up.",
    create_invoice: "Create the invoice.",
    collect_payment: "Collect the payment.",
  });
  const s = registry.buildActionSentence;
  assert.equal(s("Reason.", ["Support A", "Support B"], ["Flagged 9 days ago - still unresolved."], "follow_up"), "Reason. Support A Support B Flagged 9 days ago - still unresolved. Follow up.");
  for (const silent of ["call", "text", "monitor", "no_action"] as const) assert.equal(s("Reason.", [], [], silent), "Reason.", `${silent} adds no phrase`);
  assert.equal(s("", [], [], "respond"), "Reply to their message.", "an empty reason is dropped, not left as a leading space");
});

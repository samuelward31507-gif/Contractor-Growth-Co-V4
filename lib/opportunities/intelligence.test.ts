/**
 * Canonical Opportunity Intelligence Layer - unit tests for every pure
 * function in lib/opportunities/intelligence.ts (deriveValueState,
 * buildExplanation, resolveActionability, buildPriorityQueue,
 * getConversationSignals, getOperationalExceptions). No I/O - see
 * intelligence.integration.test.ts for the real-database wiring
 * (getPrioritizedOpportunities itself).
 *
 * Run with:
 *   node --test lib/opportunities/intelligence.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  deriveValueState,
  buildExplanation,
  resolveActionability,
  buildPriorityQueue,
  getConversationSignals,
  getOperationalExceptions,
  TIER_BY_TYPE,
  TIER_ORDER,
}: typeof import("./intelligence") = require("./intelligence.ts");

type Opportunity = import("./queries").Opportunity;
type OpportunityType = import("./queries").OpportunityType;
type AttentionItem = import("../dashboard/queries").AttentionItem;

const NOW = new Date("2026-09-27T12:00:00.000Z");

function makeOpportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id: overrides.id ?? "00000000-0000-0000-0000-000000000000",
    type: overrides.type ?? "qualified_lead_unbooked",
    status: overrides.status ?? "open",
    sourceEntityType: overrides.sourceEntityType ?? "lead",
    sourceEntityId: overrides.sourceEntityId ?? "lead-1",
    contactId: overrides.contactId ?? null,
    title: overrides.title ?? "Test Opportunity",
    description: overrides.description ?? "Test description.",
    estimatedValue: overrides.estimatedValue ?? null,
    valueBasis: overrides.valueBasis ?? null,
    createdAt: overrides.createdAt ?? NOW.toISOString(),
    updatedAt: overrides.updatedAt ?? NOW.toISOString(),
    resolvedAt: overrides.resolvedAt ?? null,
    resolutionReason: overrides.resolutionReason ?? null,
    metadata: overrides.metadata ?? {},
  };
}

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// deriveValueState - KNOWN / UNKNOWN / NOT_APPLICABLE
// ---------------------------------------------------------------------------

test("deriveValueState: a type with a real value dimension and a non-null value is KNOWN", () => {
  assert.equal(deriveValueState(makeOpportunity({ type: "qualified_lead_unbooked", estimatedValue: 21500 })), "known");
});

test("deriveValueState: a type with a real value dimension but a null value is UNKNOWN - never coerced", () => {
  assert.equal(deriveValueState(makeOpportunity({ type: "qualified_lead_unbooked", estimatedValue: null })), "unknown");
});

test("deriveValueState: a type with no honest value dimension by design is NOT_APPLICABLE, even if estimatedValue were somehow non-null", () => {
  for (const type of ["completed_appointment_no_estimate", "dormant_customer", "no_show", "cancelled_appointment_no_rebooking"] as OpportunityType[]) {
    assert.equal(deriveValueState(makeOpportunity({ type, estimatedValue: null })), "not_applicable", `${type} must be not_applicable`);
  }
});

// Phase 2-10 (B7): this used to assert that a review request carried the completed job's amount as a value
// dimension. B7 removes that value at detection, and §6 classes review asks as having no dollar value.
test("deriveValueState (Phase 2-10): completed_job_no_review_request has no value dimension - not_applicable, never 'Value not yet entered'", () => {
  assert.equal(deriveValueState(makeOpportunity({ type: "completed_job_no_review_request", estimatedValue: null })), "not_applicable");
  assert.equal(deriveValueState(makeOpportunity({ type: "completed_job_no_review_request", estimatedValue: 9600 })), "not_applicable", "even a stale stored value is never shown");
  assert.equal(deriveValueState(makeOpportunity({ type: "completed_job_no_referral_request", estimatedValue: null })), "unknown", "referral is unchanged by Phase 2-10");
});

// ---------------------------------------------------------------------------
// buildExplanation - primary reason, supporting/counter signals, confidence
// ---------------------------------------------------------------------------

test("buildExplanation: the primary reason is always the opportunity's own real, already-stored description - never invented", () => {
  const explanation = buildExplanation(
    makeOpportunity({ type: "stale_estimate", description: 'Estimate "Roof repair" expired with no customer decision recorded.' }),
    "at_risk",
    "known",
    NOW,
  );
  assert.equal(explanation.primaryReason, 'Estimate "Roof repair" expired with no customer decision recorded.');
});

test("buildExplanation: a manual hot-temperature active_lead_signal gets confidence 'manual_flag', never 'confirmed' - a status someone set is not detected intelligence", () => {
  const explanation = buildExplanation(makeOpportunity({ type: "active_lead_signal", metadata: { temperature: "hot" } }), "active_pursuit", "unknown", NOW);
  assert.equal(explanation.confidence, "manual_flag");
});

test("buildExplanation: a value-driven (not hot) active_lead_signal gets confidence 'estimated', not 'manual_flag' or 'confirmed'", () => {
  const explanation = buildExplanation(makeOpportunity({ type: "active_lead_signal", metadata: { temperature: "warm" }, estimatedValue: 8000 }), "active_pursuit", "known", NOW);
  assert.equal(explanation.confidence, "estimated");
});

test("buildExplanation: an authoritative type (accepted_estimate_no_job) gets confidence 'confirmed'", () => {
  const explanation = buildExplanation(makeOpportunity({ type: "accepted_estimate_no_job" }), "committed_revenue_at_risk", "known", NOW);
  assert.equal(explanation.confidence, "confirmed");
});

test("buildExplanation: unknown value adds an explicit 'Value not yet entered' supporting signal - never silently absent, never implying $0", () => {
  const explanation = buildExplanation(makeOpportunity({ type: "qualified_lead_unbooked", estimatedValue: null }), "active_pursuit", "unknown", NOW);
  assert.ok(explanation.supportingSignals.includes("Value not yet entered"));
});

test("buildExplanation: known value never adds the 'Value not yet entered' signal", () => {
  const explanation = buildExplanation(makeOpportunity({ type: "qualified_lead_unbooked", estimatedValue: 5000 }), "active_pursuit", "known", NOW);
  assert.ok(!explanation.supportingSignals.includes("Value not yet entered"));
});

test("buildExplanation: 'marked hot 3 weeks ago; no activity since' - a stale active_lead_signal (created well past its tier's threshold) gets a counter-signal naming the staleness", () => {
  const explanation = buildExplanation(makeOpportunity({ type: "active_lead_signal", metadata: { temperature: "hot" }, createdAt: daysAgo(21) }), "active_pursuit", "unknown", NOW);
  assert.equal(explanation.counterSignals.length, 1);
  assert.match(explanation.counterSignals[0], /Flagged 21 days ago - still unresolved\./);
});

test("buildExplanation: a freshly-created opportunity (within its tier's staleness threshold) gets no counter-signal - competing evidence must be MATERIAL, not manufactured for every item", () => {
  const explanation = buildExplanation(makeOpportunity({ type: "active_lead_signal", createdAt: daysAgo(1) }), "active_pursuit", "unknown", NOW);
  assert.equal(explanation.counterSignals.length, 0);
});

test("buildExplanation: a repeat-customer dormant_customer opportunity gets a real, historical supporting signal from CustomerLifecycle - never a fabricated future value", () => {
  const explanation = buildExplanation(makeOpportunity({ type: "dormant_customer" }), "recoverable", "not_applicable", NOW, {
    isRepeatCustomer: true,
    totalCompletedJobs: 3,
    averageKnownCompletedJobValue: 650,
  });
  assert.ok(explanation.supportingSignals.includes("Repeat customer - 3 completed jobs, averaging $650 per job."));
});

test("buildExplanation: a one-time (non-repeat) customer's dormant_customer opportunity gets no repeat-customer signal - the enrichment only fires when it's genuinely true", () => {
  const explanation = buildExplanation(makeOpportunity({ type: "dormant_customer" }), "recoverable", "not_applicable", NOW, {
    isRepeatCustomer: false,
    totalCompletedJobs: 1,
    averageKnownCompletedJobValue: 400,
  });
  assert.equal(explanation.supportingSignals.length, 0);
});

test("buildExplanation: CustomerLifecycle enrichment is scoped to dormant_customer only - a qualified_lead_unbooked opportunity ignores a passed-in lifecycle context entirely", () => {
  const explanation = buildExplanation(makeOpportunity({ type: "qualified_lead_unbooked", estimatedValue: 5000 }), "active_pursuit", "known", NOW, {
    isRepeatCustomer: true,
    totalCompletedJobs: 5,
    averageKnownCompletedJobValue: 900,
  });
  assert.ok(!explanation.supportingSignals.some((signal) => signal.includes("Repeat customer")), "lifecycle context must not leak into unrelated opportunity types");
});

test("buildExplanation: tiers with a longer expected horizon (recoverable/growth) use a looser staleness threshold - 10 days old is not yet flagged there, but would be in active_pursuit", () => {
  const recoverable = buildExplanation(makeOpportunity({ type: "dormant_customer", createdAt: daysAgo(10) }), "recoverable", "not_applicable", NOW);
  assert.equal(recoverable.counterSignals.length, 0, "10 days is well within recoverable's 14-day threshold");

  const activePursuit = buildExplanation(makeOpportunity({ type: "qualified_lead_unbooked", createdAt: daysAgo(10) }), "active_pursuit", "unknown", NOW);
  assert.equal(activePursuit.counterSignals.length, 1, "10 days exceeds active_pursuit's 3-day threshold");
});

// ---------------------------------------------------------------------------
// resolveActionability - never a dead button, never bypasses automation state
// ---------------------------------------------------------------------------

test("resolveActionability: a qualified_lead_unbooked (default action CALL) with a valid phone stays CALL", () => {
  const { recommendedAction } = resolveActionability(makeOpportunity({ type: "qualified_lead_unbooked" }), { phone: "+15125550123", smsOptOut: false }, new Map(), false);
  assert.equal(recommendedAction, "call");
});

test("resolveActionability: CALL is downgraded to FOLLOW_UP when no contact exists at all - never a dead button", () => {
  const { recommendedAction } = resolveActionability(makeOpportunity({ type: "qualified_lead_unbooked" }), null, new Map(), false);
  assert.equal(recommendedAction, "follow_up");
});

test("resolveActionability: CALL is downgraded to FOLLOW_UP when the phone on file is not a valid E.164 number", () => {
  const { recommendedAction } = resolveActionability(makeOpportunity({ type: "qualified_lead_unbooked" }), { phone: "555-0123", smsOptOut: false }, new Map(), false);
  assert.equal(recommendedAction, "follow_up");
});

test("resolveActionability: an opted-out contact never blocks CALL - opt-out only affects SMS-based actions, not a phone call", () => {
  const { recommendedAction } = resolveActionability(makeOpportunity({ type: "qualified_lead_unbooked" }), { phone: "+15125550123", smsOptOut: true }, new Map(), false);
  assert.equal(recommendedAction, "call");
});

test("resolveActionability: a type with no corresponding automation (accepted_estimate_no_job) is never automatable, regardless of org eligibility", () => {
  const { automatable } = resolveActionability(makeOpportunity({ type: "accepted_estimate_no_job" }), null, new Map(), true);
  assert.equal(automatable, false);
});

test("resolveActionability: a type WITH a corresponding automation is automatable only when the org is eligible AND the automation is enabled", () => {
  const opportunity = makeOpportunity({ type: "dormant_customer" });
  assert.equal(resolveActionability(opportunity, null, new Map(), false).automatable, false, "org not eligible (paused/unpaid/not live)");
  assert.equal(resolveActionability(opportunity, null, new Map([["customer-reactivation", false]]), true).automatable, false, "automation explicitly disabled");
  assert.equal(resolveActionability(opportunity, null, new Map([["customer-reactivation", true]]), true).automatable, true, "eligible and enabled");
});

test("resolveActionability: a missing entry in the automation-enabled map means enabled (matches getAutomationEnabledMap's own documented default) - never treated as disabled by omission", () => {
  const { automatable } = resolveActionability(makeOpportunity({ type: "no_show" }), null, new Map(), true);
  assert.equal(automatable, true);
});

// ---------------------------------------------------------------------------
// buildPriorityQueue - tier-first ordering, never point-addition
// ---------------------------------------------------------------------------

function prioritized(opportunity: Opportunity, tier: import("./intelligence").PriorityTier) {
  return {
    opportunity,
    tier,
    valueState: deriveValueState(opportunity),
    explanation: { primaryReason: opportunity.description ?? "", supportingSignals: [], counterSignals: [], confidence: "confirmed" as const },
    recommendedAction: "follow_up" as const,
    automatable: false,
    contactPhone: null,
  };
}

test("buildPriorityQueue: a committed_revenue_at_risk opportunity always ranks ahead of an active_pursuit one, regardless of dollar value - tier beats value", () => {
  const lowValueCommitted = prioritized(makeOpportunity({ id: "a", type: "accepted_estimate_no_job", estimatedValue: 100 }), "committed_revenue_at_risk");
  const highValueActivePursuit = prioritized(makeOpportunity({ id: "b", type: "qualified_lead_unbooked", estimatedValue: 50000 }), "active_pursuit");
  const queue = buildPriorityQueue([highValueActivePursuit, lowValueCommitted], []);
  assert.equal(queue[0].key, "opportunity:a", "the $100 committed-revenue-at-risk item must rank first despite the $50,000 active-pursuit item");
});

test("buildPriorityQueue: within the same tier, known value sorts descending", () => {
  const low = prioritized(makeOpportunity({ id: "low", type: "qualified_lead_unbooked", estimatedValue: 5000 }), "active_pursuit");
  const high = prioritized(makeOpportunity({ id: "high", type: "qualified_lead_unbooked", estimatedValue: 20000 }), "active_pursuit");
  const queue = buildPriorityQueue([low, high], []);
  assert.deepEqual(queue.map((item) => item.key), ["opportunity:high", "opportunity:low"]);
});

test("buildPriorityQueue: within the same tier, an unknown-value opportunity ranks behind a known-value one, but two unknown-value opportunities tiebreak by age (older/more overdue first)", () => {
  const older = prioritized(makeOpportunity({ id: "older", type: "qualified_lead_unbooked", estimatedValue: null, createdAt: daysAgo(10) }), "active_pursuit");
  const newer = prioritized(makeOpportunity({ id: "newer", type: "qualified_lead_unbooked", estimatedValue: null, createdAt: daysAgo(1) }), "active_pursuit");
  const known = prioritized(makeOpportunity({ id: "known", type: "qualified_lead_unbooked", estimatedValue: 1000, createdAt: daysAgo(1) }), "active_pursuit");
  const queue = buildPriorityQueue([newer, known, older], []);
  assert.deepEqual(queue.map((item) => item.key), ["opportunity:known", "opportunity:older", "opportunity:newer"]);
});

test("buildPriorityQueue: TIER_BY_TYPE covers all 14 opportunity types exhaustively and every value is a real TIER_ORDER member", () => {
  const types = Object.keys(TIER_BY_TYPE) as OpportunityType[];
  assert.equal(types.length, 14);
  for (const type of types) {
    assert.ok(TIER_ORDER.includes(TIER_BY_TYPE[type]), `${type}'s tier must be a real, named tier`);
  }
});

// ---------------------------------------------------------------------------
// getConversationSignals / getOperationalExceptions - extraction only, never
// re-detection; the two sets are mutually exclusive and cover exactly the 6
// non-opportunity-backed AttentionItem kinds this layer is responsible for.
// ---------------------------------------------------------------------------

function makeAttentionItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: overrides.id ?? "item-1",
    kind: overrides.kind ?? "awaiting_reply",
    title: overrides.title ?? "Test Customer",
    detail: overrides.detail ?? "Waiting for a reply 2 hours ago",
    value: overrides.value ?? null,
    href: overrides.href ?? "/conversations/1",
    incidentId: overrides.incidentId,
    incidentStatus: overrides.incidentStatus,
  };
}

test("getConversationSignals: extracts exactly the 4 conversation/appointment-state kinds, never the opportunity-backed or operational ones", () => {
  const items = [
    makeAttentionItem({ kind: "awaiting_reply" }),
    makeAttentionItem({ kind: "abandoned_conversation" }),
    makeAttentionItem({ kind: "overdue_appointment" }),
    makeAttentionItem({ kind: "awaiting_confirmation" }),
    makeAttentionItem({ kind: "human_escalation" }),
    makeAttentionItem({ kind: "hot_lead" }),
    makeAttentionItem({ kind: "no_show" }),
  ];
  const signals = getConversationSignals(items);
  assert.equal(signals.length, 4);
  assert.deepEqual(
    signals.map((signal) => signal.kind).sort(),
    ["abandoned_conversation", "awaiting_confirmation", "awaiting_reply", "overdue_appointment"],
  );
});

test("getConversationSignals: awaiting_reply/overdue_appointment/awaiting_confirmation tier as needs_reply; abandoned_conversation tiers one step down, at_risk", () => {
  const signals = getConversationSignals([
    makeAttentionItem({ kind: "awaiting_reply" }),
    makeAttentionItem({ kind: "overdue_appointment" }),
    makeAttentionItem({ kind: "awaiting_confirmation" }),
    makeAttentionItem({ kind: "abandoned_conversation" }),
  ]);
  const tierByKind = new Map(signals.map((signal) => [signal.kind, signal.tier]));
  assert.equal(tierByKind.get("awaiting_reply"), "needs_reply");
  assert.equal(tierByKind.get("overdue_appointment"), "needs_reply");
  assert.equal(tierByKind.get("awaiting_confirmation"), "needs_reply");
  assert.equal(tierByKind.get("abandoned_conversation"), "at_risk");
});

test("getOperationalExceptions: extracts exactly human_escalation and calendar_disconnected, and only those - never mixed into revenue scoring", () => {
  const items = [
    makeAttentionItem({ kind: "human_escalation", incidentId: "inc-1" }),
    makeAttentionItem({ kind: "calendar_disconnected" }),
    makeAttentionItem({ kind: "awaiting_reply" }),
    makeAttentionItem({ kind: "hot_lead" }),
  ];
  const exceptions = getOperationalExceptions(items);
  assert.equal(exceptions.length, 2);
  assert.deepEqual(
    exceptions.map((exception) => exception.kind).sort(),
    ["calendar_disconnected", "human_escalation"],
  );
});

test("getConversationSignals and getOperationalExceptions never overlap - every AttentionItem kind is claimed by at most one of them", () => {
  const allKinds: AttentionItem["kind"][] = [
    "overdue_appointment",
    "hot_lead",
    "high_value_lead",
    "pending_estimate",
    "calendar_disconnected",
    "human_escalation",
    "awaiting_reply",
    "stale_estimate",
    "dormant_customer",
    "no_show",
    "awaiting_confirmation",
    "abandoned_conversation",
    "accepted_estimate_no_job",
    "uncontacted_lead",
    "cancelled_appointment_no_rebooking",
    "completed_job_no_review_request",
    "completed_job_no_referral_request",
  ];
  const items = allKinds.map((kind) => makeAttentionItem({ kind, id: kind }));
  const signalKinds = new Set(getConversationSignals(items).map((signal) => signal.kind));
  const exceptionKinds = new Set(getOperationalExceptions(items).map((exception) => exception.kind));
  for (const kind of signalKinds) {
    assert.ok(!exceptionKinds.has(kind), `${kind} must not be claimed by both getConversationSignals and getOperationalExceptions`);
  }
});

// ---------------------------------------------------------------------------
// Phase 1B-5: completed_job_not_invoiced / invoice_overdue
// ---------------------------------------------------------------------------

test("Phase 1B-5: both invoice types sit in committed_revenue_at_risk - money for work already done", () => {
  assert.equal(TIER_BY_TYPE.completed_job_not_invoiced, "committed_revenue_at_risk");
  assert.equal(TIER_BY_TYPE.invoice_overdue, "committed_revenue_at_risk");
  for (const type of Object.keys(TIER_BY_TYPE) as OpportunityType[]) {
    assert.ok(TIER_ORDER.includes(TIER_BY_TYPE[type]), `${type} maps to a real tier`);
  }
});

test("Phase 1B-5: value state is known from the stored figure (jobs.amount / invoices.balance_due) and unknown when absent - never not_applicable", () => {
  assert.equal(deriveValueState(makeOpportunity({ type: "completed_job_not_invoiced", sourceEntityType: "job", estimatedValue: 1300.25, valueBasis: "jobs.amount" })), "known");
  assert.equal(deriveValueState(makeOpportunity({ type: "completed_job_not_invoiced", sourceEntityType: "job", estimatedValue: null })), "unknown");
  assert.equal(deriveValueState(makeOpportunity({ type: "invoice_overdue", sourceEntityType: "job", estimatedValue: 450.5, valueBasis: "invoices.balance_due" })), "known");
});

test("Phase 1B-5: recommended actions are create_invoice / collect_payment, never automatable (no catalog automation acts on either), unaffected by phone availability", () => {
  const enabled = new Map<string, boolean>();
  const notInvoiced = resolveActionability(makeOpportunity({ type: "completed_job_not_invoiced", sourceEntityType: "job" }), null, enabled, true);
  assert.deepEqual(notInvoiced, { recommendedAction: "create_invoice", automatable: false });
  const overdue = resolveActionability(makeOpportunity({ type: "invoice_overdue", sourceEntityType: "job" }), { phone: null, smsOptOut: true }, enabled, true);
  assert.deepEqual(overdue, { recommendedAction: "collect_payment", automatable: false });
});

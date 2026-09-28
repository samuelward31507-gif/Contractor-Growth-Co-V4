import type { SupabaseClient } from "@supabase/supabase-js";
import { getOpenOpportunitiesResult, type Opportunity, type OpportunityType } from "./queries";
import { getAutomationEnabledMap } from "@/lib/automation/settings";
import { E164_PATTERN } from "@/lib/automation/sms";
import { getCustomerLifecycle, type CustomerLifecycle } from "@/lib/customers/lifecycle";
import { formatCurrency } from "@/lib/dashboard/format";
import type { AttentionItem } from "@/lib/dashboard/queries";

/**
 * Canonical Opportunity Intelligence Layer.
 *
 * This is the ONE place Today, Opportunities, and Insights read priority,
 * explanation, and recommendation from - see the approved design report
 * ("The Trackpr Opportunity Intelligence Model") for the full rationale.
 * Nothing here invents a signal, a score, or a dollar figure: every input is
 * a real, already-stored fact (the Opportunity row itself, its contact's
 * phone/opt-out state, the organization's own automation eligibility), and
 * every output is either an internal ranking (tier) or a human-readable
 * explanation built entirely from those facts.
 *
 * Deliberately NOT here: a numeric score. Priority is tier-first with
 * deterministic, documented tiebreakers (see comparePriority below) - never
 * point-addition, never exposed to the client as a number.
 */

const MAX_ROWS = 5000;

export type ValueState = "known" | "unknown" | "not_applicable";

/**
 * Six tiers, most time-sensitive first. This is not an arbitrary new
 * ordering - it is the exact priority sequence lib/dashboard/queries.ts's own
 * getDashboardData already used and documented (humanEscalations handled
 * separately as an operational exception; awaitingReply/abandonedConversation/
 * overdueAppointments/awaitingConfirmation ranked immediately after; then
 * accepted_estimate_no_job; then the lead-pursuit group; then the
 * recoverable/at-risk group; then the growth/reputation asks) - restated here
 * as a named, documented model instead of an unlabeled array concatenation
 * order, per the approved design's "derive tiers from actual existing
 * business rules, don't invent arbitrary weights" instruction.
 */
export type PriorityTier = "needs_reply" | "committed_revenue_at_risk" | "active_pursuit" | "at_risk" | "recoverable" | "growth";

export const TIER_ORDER: PriorityTier[] = ["needs_reply", "committed_revenue_at_risk", "active_pursuit", "at_risk", "recoverable", "growth"];

export const TIER_BY_TYPE: Record<OpportunityType, PriorityTier> = {
  accepted_estimate_no_job: "committed_revenue_at_risk",
  qualified_lead_unbooked: "active_pursuit",
  completed_appointment_no_estimate: "active_pursuit",
  uncontacted_lead: "active_pursuit",
  active_lead_signal: "active_pursuit",
  pending_estimate: "active_pursuit",
  no_show: "at_risk",
  cancelled_appointment_no_rebooking: "at_risk",
  stale_estimate: "at_risk",
  dormant_customer: "recoverable",
  completed_job_no_review_request: "growth",
  completed_job_no_referral_request: "growth",
};

/**
 * Opportunity types with NO honest value dimension by design - detect.ts
 * itself always sets estimatedValue/valueBasis to null for these, never
 * because data happens to be missing. Kept as its own explicit set so
 * deriveValueState never confuses "this type has no value dimension" with
 * "this instance's value field is unknown" - the exact KNOWN/UNKNOWN/
 * NOT_APPLICABLE distinction the approved design requires.
 */
const NOT_APPLICABLE_VALUE_TYPES = new Set<OpportunityType>([
  "completed_appointment_no_estimate",
  "dormant_customer",
  "no_show",
  "cancelled_appointment_no_rebooking",
]);

export function deriveValueState(opportunity: Opportunity): ValueState {
  if (NOT_APPLICABLE_VALUE_TYPES.has(opportunity.type)) return "not_applicable";
  return opportunity.estimatedValue != null ? "known" : "unknown";
}

export type RecommendedAction =
  | "call"
  | "text"
  | "respond"
  | "book"
  | "rebook"
  | "send_estimate"
  | "follow_up_estimate"
  | "create_job"
  | "reactivate"
  | "request_review"
  | "request_referral"
  | "follow_up"
  | "monitor"
  | "no_action";

/** The action this opportunity type points at BEFORE any actionability check (§11 of the design) - "call"/"text" are downgraded to "follow_up" at build time when no valid, reachable phone exists. */
const DEFAULT_ACTION_BY_TYPE: Record<OpportunityType, RecommendedAction> = {
  accepted_estimate_no_job: "create_job",
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
};

/**
 * The real, existing automation catalog id (lib/automation/catalog.ts) that
 * could, right now, act on this opportunity type in the background - used
 * only to compute `automatable` below, never to trigger anything itself.
 * Types with no entry have no automation that acts on them today (e.g.
 * cancelled_appointment_no_rebooking, accepted_estimate_no_job - both
 * genuinely manual today), so they are always automatable: false.
 */
const AUTOMATION_ID_BY_TYPE: Partial<Record<OpportunityType, string>> = {
  uncontacted_lead: "instant-lead-followup",
  dormant_customer: "customer-reactivation",
  stale_estimate: "estimate-followup",
  pending_estimate: "estimate-followup",
  no_show: "no-show-detection",
  completed_job_no_review_request: "review-referral-followup",
  completed_job_no_referral_request: "review-referral-followup",
};

export type ExplanationConfidence = "confirmed" | "estimated" | "manual_flag" | "ai_assessed";

export type OpportunityExplanation = {
  primaryReason: string;
  supportingSignals: string[];
  counterSignals: string[];
  confidence: ExplanationConfidence;
};

export type PrioritizedOpportunity = {
  opportunity: Opportunity;
  tier: PriorityTier;
  valueState: ValueState;
  explanation: OpportunityExplanation;
  recommendedAction: RecommendedAction;
  /** True only when a real, currently-enabled, currently-eligible automation could act on this in the background right now - never implies Trackpr WILL act, only that it CAN (§17/§18 of the approved design: never bypass automation_paused/payment/enabled). */
  automatable: boolean;
  contactPhone: string | null;
};

/**
 * Staleness thresholds for the one counter-signal this pass implements
 * without any new query: an opportunity's own `createdAt` is real,
 * already-fetched evidence of how long the underlying condition has gone
 * unaddressed (opportunities only ever close via syncOpportunities' own
 * auto-resolve/dismiss paths - see lib/opportunities/detect.ts - so "still
 * open" genuinely means "still true"). Tighter for the tiers where fast
 * action is expected, looser for the tiers that are inherently
 * longer-horizon by design (recoverable/growth already imply a slow cadence -
 * flagging "still open after 14 days" there would be noise, not signal).
 */
const STALENESS_THRESHOLD_MS_BY_TIER: Record<PriorityTier, number> = {
  needs_reply: 2 * 24 * 60 * 60 * 1000,
  committed_revenue_at_risk: 3 * 24 * 60 * 60 * 1000,
  active_pursuit: 3 * 24 * 60 * 60 * 1000,
  at_risk: 7 * 24 * 60 * 60 * 1000,
  recoverable: 14 * 24 * 60 * 60 * 1000,
  growth: 14 * 24 * 60 * 60 * 1000,
};

function daysSince(iso: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * Finalization pass, CustomerLifecycle evaluation: isRepeatCustomer/
 * totalCompletedJobs/averageKnownCompletedJobValue materially improve the
 * explanation for exactly one opportunity type - dormant_customer - where a
 * customer's past relationship with the business IS the subject of the
 * opportunity. Deliberately NOT wired into the other 11 types: for those,
 * a contact's job history is tangential context, not the reason the
 * opportunity exists, and fetching it for every opportunity's contact would
 * be real added query cost for a speculative benefit - exactly the
 * "add a signal merely because it exists" pattern to avoid. This is real,
 * historical fact (jobs already completed, not a guess about the next one),
 * so it can appear as context without ever setting the opportunity's own
 * value (dormant_customer stays NOT_APPLICABLE - see deriveValueState).
 */
export type LifecycleContext = Pick<CustomerLifecycle, "isRepeatCustomer" | "totalCompletedJobs" | "averageKnownCompletedJobValue"> | null;

/** Exported for direct unit testing (see intelligence.test.ts) - matches this codebase's established "pure logic extracted for testability" convention. */
export function buildExplanation(opportunity: Opportunity, tier: PriorityTier, valueState: ValueState, now: Date, lifecycle: LifecycleContext = null): OpportunityExplanation {
  const supportingSignals: string[] = [];
  const counterSignals: string[] = [];
  let confidence: ExplanationConfidence = "confirmed";

  if (opportunity.type === "active_lead_signal") {
    const temperature = (opportunity.metadata as { temperature?: string }).temperature;
    if (temperature === "hot") {
      confidence = "manual_flag";
      if (valueState === "known") supportingSignals.push("Also a known-value opportunity");
    } else {
      confidence = "estimated";
    }
  }

  if (opportunity.type === "dormant_customer" && lifecycle?.isRepeatCustomer) {
    const jobWord = lifecycle.totalCompletedJobs === 1 ? "job" : "jobs";
    const averageClause = lifecycle.averageKnownCompletedJobValue != null ? `, averaging ${formatCurrency(lifecycle.averageKnownCompletedJobValue)} per job` : "";
    supportingSignals.push(`Repeat customer - ${lifecycle.totalCompletedJobs} completed ${jobWord}${averageClause}.`);
  }

  if (valueState === "unknown") {
    supportingSignals.push("Value not yet entered");
  }

  const age = daysSince(opportunity.createdAt, now);
  if (age * 24 * 60 * 60 * 1000 >= STALENESS_THRESHOLD_MS_BY_TIER[tier]) {
    // The one counter-signal example the approved design named explicitly:
    // "Marked hot 3 weeks ago; no activity since." - generalized here to
    // every type using the same real, already-fetched evidence (age), not
    // fabricated per-type narrative.
    counterSignals.push(`Flagged ${age} day${age === 1 ? "" : "s"} ago - still unresolved.`);
  }

  return {
    primaryReason: opportunity.description ?? "Needs attention.",
    supportingSignals,
    counterSignals,
    confidence,
  };
}

export type ContactContext = { phone: string | null; smsOptOut: boolean } | null;

/** Exported for direct unit testing (see intelligence.test.ts). */
export function resolveActionability(
  opportunity: Opportunity,
  contact: ContactContext,
  automationEnabledMap: Map<string, boolean>,
  orgEligibleForAutomation: boolean,
): { recommendedAction: RecommendedAction; automatable: boolean } {
  let recommendedAction = DEFAULT_ACTION_BY_TYPE[opportunity.type];

  // Actionability check (§11 of the approved design): never emit CALL/TEXT
  // when there is nothing to call/text - downgrade to the always-executable
  // FOLLOW_UP rather than render a dead button.
  const hasValidPhone = Boolean(contact?.phone && E164_PATTERN.test(contact.phone.trim()));
  if ((recommendedAction === "call" || recommendedAction === "text") && !hasValidPhone) {
    recommendedAction = "follow_up";
  }
  if (recommendedAction === "text" && contact?.smsOptOut) {
    recommendedAction = "follow_up";
  }

  const automationId = AUTOMATION_ID_BY_TYPE[opportunity.type];
  const automatable = automationId != null && orgEligibleForAutomation && (automationEnabledMap.get(automationId) ?? true);

  return { recommendedAction, automatable };
}

function comparePriority(a: PrioritizedOpportunity, b: PrioritizedOpportunity): number {
  const tierDiff = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier);
  if (tierDiff !== 0) return tierDiff;

  // Within a tier: known value first (higher first), then older first (more
  // overdue) as the deterministic tiebreak - never a weighted sum of the two.
  const aValue = a.opportunity.estimatedValue ?? -1;
  const bValue = b.opportunity.estimatedValue ?? -1;
  if (aValue !== bValue) return bValue - aValue;

  return new Date(a.opportunity.createdAt).getTime() - new Date(b.opportunity.createdAt).getTime();
}

/**
 * The one canonical prioritization entry point. Fetches the org's real,
 * currently-open Opportunity rows plus the small amount of additional
 * context (contact phone/opt-out, automation eligibility) needed to compute
 * explanation/recommendation/actionability, all in a handful of bounded,
 * parallel, org-scoped queries - no new caching layer, no scheduled
 * recomputation (§16/§21 of the approved design): this is cheap because the
 * candidate set is already small and already the exact same read Today,
 * Opportunities, and Insights would otherwise each fetch independently.
 *
 * Never returns a raw score. Every PrioritizedOpportunity's `tier` is a
 * named category, not a number - the client renders position/wording, never
 * a numeric rank.
 */
export async function getPrioritizedOpportunities(supabase: SupabaseClient, organizationId: string, now: Date = new Date()): Promise<PrioritizedOpportunity[]> {
  const opportunitiesResult = await getOpenOpportunitiesResult(supabase, organizationId);
  const opportunities = opportunitiesResult.data;
  if (opportunities.length === 0) return [];

  const contactIds = [...new Set(opportunities.map((opportunity) => opportunity.contactId).filter((id): id is string => id != null))];
  // Scoped to dormant_customer's own contacts only - see buildExplanation's
  // own comment on why this enrichment is deliberately not fetched for every
  // opportunity's contact. Bounded by however many dormant_customer
  // opportunities exist (typically small), never a full-org scan.
  const dormantCustomerContactIds = [...new Set(opportunities.filter((opportunity) => opportunity.type === "dormant_customer" && opportunity.contactId).map((opportunity) => opportunity.contactId as string))];

  const [contactRowsResult, automationEnabledMap, organizationRowResult, dormantCustomerLifecycles] = await Promise.all([
    contactIds.length > 0
      ? supabase.from("contacts").select("id, phone, sms_opt_out").eq("organization_id", organizationId).in("id", contactIds).limit(MAX_ROWS)
      : Promise.resolve({ data: [] as { id: string; phone: string | null; sms_opt_out: boolean }[] }),
    getAutomationEnabledMap(supabase, organizationId),
    supabase.from("organizations").select("automation_mode, payment_status, automation_paused").eq("id", organizationId).maybeSingle(),
    Promise.all(dormantCustomerContactIds.map(async (contactId) => [contactId, await getCustomerLifecycle(supabase, organizationId, contactId, now)] as const)),
  ]);

  const contactById = new Map(((contactRowsResult.data ?? []) as { id: string; phone: string | null; sms_opt_out: boolean }[]).map((row) => [row.id, { phone: row.phone, smsOptOut: row.sms_opt_out }]));
  const lifecycleByContactId = new Map(dormantCustomerLifecycles);

  // Mirrors lib/opportunities/detect.ts's detectUncontactedLeads' own
  // eligibility check exactly - "could a real automation act on this right
  // now" must fail closed the same way evaluateOutboundGate itself does.
  const organizationRow = organizationRowResult.data;
  const orgEligibleForAutomation = organizationRow != null && organizationRow.automation_mode === "live" && organizationRow.payment_status === "active" && !organizationRow.automation_paused;

  return opportunities
    .map((opportunity): PrioritizedOpportunity => {
      const tier = TIER_BY_TYPE[opportunity.type];
      const valueState = deriveValueState(opportunity);
      const contact = opportunity.contactId ? (contactById.get(opportunity.contactId) ?? null) : null;
      const { recommendedAction, automatable } = resolveActionability(opportunity, contact, automationEnabledMap, orgEligibleForAutomation);
      const lifecycle = opportunity.contactId ? (lifecycleByContactId.get(opportunity.contactId) ?? null) : null;

      return {
        opportunity,
        tier,
        valueState,
        explanation: buildExplanation(opportunity, tier, valueState, now, lifecycle),
        recommendedAction,
        automatable,
        contactPhone: contact?.phone ?? null,
      };
    })
    .sort(comparePriority);
}

// ---------------------------------------------------------------------------
// Conversation/appointment state signals - deliberately NOT persisted
// Opportunity rows (see lib/dashboard/queries.ts's own comment on why
// awaiting_reply/abandoned_conversation/overdue_appointment/
// awaiting_confirmation are inherently short-lived and recomputed fresh on
// every load), but they still need a place in the SAME tiered, explained
// queue Today renders - this wraps the Attention Engine's own already-proven
// detection for exactly these 4 kinds (never re-detected here) into the same
// shape as a PrioritizedOpportunity, so Today never runs two competing
// ranking systems.
// ---------------------------------------------------------------------------

const CONVERSATION_SIGNAL_KINDS = new Set<AttentionItem["kind"]>(["awaiting_reply", "abandoned_conversation", "overdue_appointment", "awaiting_confirmation"]);

export type PriorityConversationSignal = {
  kind: AttentionItem["kind"];
  title: string;
  href: string;
  tier: PriorityTier;
  explanation: OpportunityExplanation;
  recommendedAction: RecommendedAction;
};

const CONVERSATION_SIGNAL_TIER: Partial<Record<AttentionItem["kind"], PriorityTier>> = {
  awaiting_reply: "needs_reply",
  overdue_appointment: "needs_reply",
  awaiting_confirmation: "needs_reply",
  // A quiet conversation Trackpr itself last spoke into is a real risk
  // signal (the same one lib/dashboard/queries.ts's own abandonedConversations
  // comment describes), not a "someone is waiting on you right now" signal -
  // tiered accordingly, one step down from the other three.
  abandoned_conversation: "at_risk",
};

const CONVERSATION_SIGNAL_ACTION: Partial<Record<AttentionItem["kind"], RecommendedAction>> = {
  awaiting_reply: "respond",
  overdue_appointment: "follow_up",
  awaiting_confirmation: "follow_up",
  abandoned_conversation: "follow_up",
};

/**
 * Extracts only the 4 conversation/appointment-state kinds from an
 * already-fetched DashboardData.attentionItems - never re-detects them, never
 * touches the other 13 kinds (the 11 now-superseded by real Opportunity
 * types, and the 2 pure operational exceptions handled by
 * getOperationalExceptions below). Takes attentionItems as a parameter
 * (rather than fetching getDashboardData itself) so a caller that already
 * has it (Today) never pays for a second, duplicate read.
 */
export function getConversationSignals(attentionItems: AttentionItem[]): PriorityConversationSignal[] {
  return attentionItems
    .filter((item) => CONVERSATION_SIGNAL_KINDS.has(item.kind))
    .map((item) => ({
      kind: item.kind,
      title: item.title,
      href: item.href,
      tier: CONVERSATION_SIGNAL_TIER[item.kind]!,
      explanation: { primaryReason: item.detail, supportingSignals: [], counterSignals: [], confidence: "confirmed" as const },
      recommendedAction: CONVERSATION_SIGNAL_ACTION[item.kind]!,
    }));
}

// ---------------------------------------------------------------------------
// Operational exceptions - pure safety/system issues, explicitly OUTSIDE
// revenue scoring (§8/§13 of the approved design). "The AI needs a human" and
// "your calendar broke" have no revenue framing; they stay a separate,
// simple, always-visible queue, never tiered/scored alongside opportunities.
// ---------------------------------------------------------------------------

const OPERATIONAL_EXCEPTION_KINDS = new Set<AttentionItem["kind"]>(["human_escalation", "calendar_disconnected"]);

export type OperationalException = { kind: AttentionItem["kind"]; title: string; detail: string; href: string; incidentId?: string; incidentStatus?: AttentionItem["incidentStatus"] };

/** Same extraction pattern as getConversationSignals - never re-detects, just picks the 2 pure operational kinds out of an already-fetched attentionItems array. */
export function getOperationalExceptions(attentionItems: AttentionItem[]): OperationalException[] {
  return attentionItems
    .filter((item) => OPERATIONAL_EXCEPTION_KINDS.has(item.kind))
    .map((item) => ({ kind: item.kind, title: item.title, detail: item.detail, href: item.href, incidentId: item.incidentId, incidentStatus: item.incidentStatus }));
}

// ---------------------------------------------------------------------------
// The single merged, rendered queue - opportunities + conversation signals,
// one ordering, one set of rules. Operational exceptions are NOT included
// here (they render separately, always first, unscored - see this file's own
// header comment and getOperationalExceptions above).
// ---------------------------------------------------------------------------

export type PriorityItem = { key: string; tier: PriorityTier } & ({ kind: "opportunity"; data: PrioritizedOpportunity } | { kind: "signal"; data: PriorityConversationSignal });

function tierIndex(tier: PriorityTier): number {
  return TIER_ORDER.indexOf(tier);
}

export function buildPriorityQueue(prioritizedOpportunities: PrioritizedOpportunity[], conversationSignals: PriorityConversationSignal[]): PriorityItem[] {
  const opportunityItems: PriorityItem[] = prioritizedOpportunities.map((data) => ({ key: `opportunity:${data.opportunity.id}`, tier: data.tier, kind: "opportunity", data }));
  // Conversation signals carry no structured timestamp to tiebreak against a
  // known dollar value (see PriorityConversationSignal's own comment
  // trail) - within a tier they are placed ahead of opportunities without a
  // known value, reflecting that a live conversation moment is generally
  // more time-critical than a static, valueless opportunity, but behind any
  // opportunity with a known dollar value in the same tier.
  const signalItems: PriorityItem[] = conversationSignals.map((data, index) => ({ key: `signal:${data.kind}:${index}`, tier: data.tier, kind: "signal", data }));

  return [...opportunityItems, ...signalItems].sort((a, b) => {
    const tierDiff = tierIndex(a.tier) - tierIndex(b.tier);
    if (tierDiff !== 0) return tierDiff;
    const aValue = a.kind === "opportunity" ? (a.data.opportunity.estimatedValue ?? -1) : -0.5;
    const bValue = b.kind === "opportunity" ? (b.data.opportunity.estimatedValue ?? -1) : -0.5;
    if (aValue !== bValue) return bValue - aValue;
    if (a.kind === "opportunity" && b.kind === "opportunity") {
      return new Date(a.data.opportunity.createdAt).getTime() - new Date(b.data.opportunity.createdAt).getTime();
    }
    return 0;
  });
}

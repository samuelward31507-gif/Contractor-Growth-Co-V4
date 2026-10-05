import type { Opportunity, OpportunityType } from "@/lib/opportunities/queries";
import type { RecommendedAction } from "@/lib/opportunities/intelligence";
import { REASON_CODE_BY_EXCEPTION_KIND, REASON_CODE_BY_OPPORTUNITY_TYPE, REASON_CODE_BY_SIGNAL_KIND, type ConversationSignalKind, type OperationalExceptionKind, type ReasonCode } from "./reason-codes";

/**
 * Phase 2-2: the single next-action registry - the one place every decision
 * string lives: the problem label, the action button's label, the default
 * recommended action, the action's link, and the action sentence. Today
 * renders from it, and the older modules (opportunity-type.ts, copy.ts,
 * intelligence.ts) re-export what they still need from here, so a row's
 * label, sentence and button can never come from two different tables.
 *
 * Wording and links are exactly the pre-2-2 values - this file moved them,
 * it did not change them.
 */
export type RegistryEntry = {
  /** The problem label on a Today row (and the By type group heading for an opportunity). */
  problemLabel: string;
  /** The action button's label. */
  actionLabel: string;
  /** The recommended action before resolveActionability's fallbacks; null for operational exceptions, which have no recommended action. */
  defaultAction: RecommendedAction | null;
};

export const DECISION_REGISTRY: Record<ReasonCode, RegistryEntry> = {
  human_escalation: { problemLabel: "Needs a human", actionLabel: "Review", defaultAction: null },
  calendar_sync_failed: { problemLabel: "Calendar disconnected", actionLabel: "Review", defaultAction: null },
  automation_needs_attention: { problemLabel: "Automation needs you", actionLabel: "Review", defaultAction: null },
  automation_retrying: { problemLabel: "Trackpr is retrying", actionLabel: "View", defaultAction: null },

  // A conversation waiting on the contractor opens that conversation -
  // labeled for what the page does (it has no compose box).
  customer_awaiting_reply: { problemLabel: "Waiting on a reply", actionLabel: "Open conversation", defaultAction: "respond" },
  appointment_overdue: { problemLabel: "Appointment overdue", actionLabel: "View", defaultAction: "follow_up" },
  appointment_unconfirmed: { problemLabel: "Visit not confirmed", actionLabel: "View", defaultAction: "follow_up" },
  conversation_stalled: { problemLabel: "Conversation went quiet", actionLabel: "View", defaultAction: "follow_up" },

  estimate_accepted_no_job: { problemLabel: "Accepted, no job yet", actionLabel: "View estimate", defaultAction: "create_job" },
  job_completed_not_invoiced: { problemLabel: "Completed, not invoiced", actionLabel: "Create invoice", defaultAction: "create_invoice" },
  invoice_overdue: { problemLabel: "Invoice overdue", actionLabel: "View invoice", defaultAction: "collect_payment" },
  qualified_not_booked: { problemLabel: "Qualified, not booked", actionLabel: "View lead", defaultAction: "call" },
  appointment_completed_no_estimate: { problemLabel: "Visit completed, no estimate", actionLabel: "Create estimate", defaultAction: "send_estimate" },
  lead_not_contacted: { problemLabel: "Never contacted", actionLabel: "View lead", defaultAction: "call" },
  lead_marked_hot_or_high_value: { problemLabel: "Marked hot or high-value", actionLabel: "View lead", defaultAction: "call" },
  estimate_awaiting_decision: { problemLabel: "Estimate sent, awaiting reply", actionLabel: "View estimate", defaultAction: "monitor" },
  appointment_no_show: { problemLabel: "Missed appointment", actionLabel: "View schedule", defaultAction: "rebook" },
  appointment_cancelled_not_rebooked: { problemLabel: "Cancelled, not rebooked", actionLabel: "View schedule", defaultAction: "rebook" },
  estimate_expired: { problemLabel: "Estimate expired", actionLabel: "View estimate", defaultAction: "follow_up_estimate" },
  customer_dormant: { problemLabel: "Dormant customer", actionLabel: "View customer", defaultAction: "reactivate" },
  review_request_needed: { problemLabel: "Review request needed", actionLabel: "View job", defaultAction: "request_review" },
  referral_request_needed: { problemLabel: "Referral request needed", actionLabel: "View job", defaultAction: "request_referral" },
};

/**
 * The one action target per type - reuses exactly the same canonical
 * destinations Phase 3C/3D/3E already established (People, Schedule's list
 * view, Estimates), or, for the job/estimate-sourced types, the real
 * existing detail route via the opportunity's own sourceEntityId - the exact
 * same deep-link Dashboard's own attention items already use for the two
 * job-sourced types (lib/dashboard/queries.ts). Never a new route, never a
 * fabricated relationship - every href below is either a canonical
 * destination this redesign already shipped, or data the Opportunity Engine
 * already provides on the opportunity itself.
 *
 * Final Major Product Build (nav-restructure follow-up): accepted_estimate_
 * no_job/stale_estimate/pending_estimate used to all point at the generic
 * /money browse view - a real destination, but a dead end relative to the
 * specific record the opportunity is actually about, and stale now that
 * Estimates is its own nav destination rather than Money. These three now
 * deep-link straight to the real estimate record (sourceEntityId for the
 * first two; pending_estimate's own sourceEntityId is deliberately the
 * LEAD's id - see detectPendingEstimates's own comment in
 * lib/opportunities/detect.ts - so its real estimate id is read from
 * metadata.estimate_id, which that same detector always sets).
 * completed_appointment_no_estimate's own action is labeled "Create
 * estimate" (OPPORTUNITY_ACTION_LABEL below) but used to land on a page with
 * no create affordance for this specific customer - it now opens the real
 * create-estimate dialog on /estimates pre-filled with this contact (see
 * AddEstimateButton's own contactId query-param support), so the label is
 * no longer aspirational.
 */
export function opportunityActionHref(opportunity: Opportunity): string {
  switch (opportunity.type) {
    case "uncontacted_lead":
    case "qualified_lead_unbooked":
    case "active_lead_signal":
      return opportunity.contactId ? `/people/${opportunity.contactId}` : "/people";
    case "accepted_estimate_no_job":
    case "stale_estimate":
      return `/estimates/${opportunity.sourceEntityId}`;
    case "pending_estimate": {
      const estimateId = opportunity.metadata.estimate_id;
      return typeof estimateId === "string" ? `/estimates/${estimateId}` : "/estimates";
    }
    case "completed_appointment_no_estimate":
      return opportunity.contactId ? `/estimates?new=estimate&contactId=${opportunity.contactId}` : "/estimates";
    case "no_show":
    case "cancelled_appointment_no_rebooking":
      return "/schedule?view=list";
    case "dormant_customer":
      return opportunity.contactId ? `/people/${opportunity.contactId}` : "/people";
    case "completed_job_no_review_request":
    case "completed_job_no_referral_request":
    // Phase 1B-5: the job page owns the Create-invoice affordance.
    case "completed_job_not_invoiced":
      return `/jobs/${opportunity.sourceEntityId}`;
    case "invoice_overdue": {
      // Sourced from the job (the stable dedup key); the invoice id travels
      // in metadata exactly like pending_estimate's estimate id.
      const invoiceId = opportunity.metadata.invoice_id;
      return typeof invoiceId === "string" ? `/invoices/${invoiceId}` : "/money?browse=invoices&status=overdue";
    }
  }
}

/** Where a row's person name links for an opportunity: the person, or Today's opportunity list when there is no contact. */
export function opportunityPersonHref(opportunity: Opportunity): string {
  return opportunity.contactId ? `/people/${opportunity.contactId}` : "/today?view=by-type#opportunities";
}

/**
 * Short imperative phrase appended to the explanation sentence for actions
 * with no dedicated button on the row. "call"/"text" are deliberately
 * omitted - QueueRow already renders a real "Call" button whenever a valid
 * phone is present, and repeating "Give them a call" in the sentence next to
 * that button would be redundant. "monitor"/"no_action" are also omitted -
 * there is nothing to instruct.
 */
export const ACTION_SENTENCE: Partial<Record<RecommendedAction, string>> = {
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
};

/** The row sentence: the primary reason, its supporting and counter signals, then the action phrase - joined by single spaces, empty parts dropped. */
export function buildActionSentence(primaryReason: string, supportingSignals: string[], counterSignals: string[], recommendedAction: RecommendedAction): string {
  const actionPhrase = ACTION_SENTENCE[recommendedAction];
  return [primaryReason, ...supportingSignals, ...counterSignals, actionPhrase].filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Views keyed by the stored types and kinds, for the modules that re-export
// them (opportunity-type.ts, copy.ts, intelligence.ts). Derived from the
// registry above, never declared a second time.
// ---------------------------------------------------------------------------

const opportunityTypes = Object.keys(REASON_CODE_BY_OPPORTUNITY_TYPE) as OpportunityType[];
const byOpportunityType = <T>(pick: (entry: RegistryEntry) => T) =>
  Object.fromEntries(opportunityTypes.map((type) => [type, pick(DECISION_REGISTRY[REASON_CODE_BY_OPPORTUNITY_TYPE[type]])])) as Record<OpportunityType, T>;

export const OPPORTUNITY_TYPE_LABEL: Record<OpportunityType, string> = byOpportunityType((entry) => entry.problemLabel);
export const OPPORTUNITY_ACTION_LABEL: Record<OpportunityType, string> = byOpportunityType((entry) => entry.actionLabel);
export const DEFAULT_ACTION_BY_TYPE: Record<OpportunityType, RecommendedAction> = byOpportunityType((entry) => entry.defaultAction as RecommendedAction);

export const CONVERSATION_SIGNAL_ACTION: Record<ConversationSignalKind, RecommendedAction> = Object.fromEntries(
  (Object.keys(REASON_CODE_BY_SIGNAL_KIND) as ConversationSignalKind[]).map((kind) => [kind, DECISION_REGISTRY[REASON_CODE_BY_SIGNAL_KIND[kind]].defaultAction as RecommendedAction]),
) as Record<ConversationSignalKind, RecommendedAction>;

/** The problem labels for the AttentionItem kinds Today renders (operational exceptions and conversation signals). */
export const DECISION_ATTENTION_LABEL: Record<OperationalExceptionKind | ConversationSignalKind, string> = {
  human_escalation: DECISION_REGISTRY[REASON_CODE_BY_EXCEPTION_KIND.human_escalation].problemLabel,
  calendar_disconnected: DECISION_REGISTRY[REASON_CODE_BY_EXCEPTION_KIND.calendar_disconnected].problemLabel,
  automation_needs_attention: DECISION_REGISTRY[REASON_CODE_BY_EXCEPTION_KIND.automation_needs_attention].problemLabel,
  automation_retrying: DECISION_REGISTRY[REASON_CODE_BY_EXCEPTION_KIND.automation_retrying].problemLabel,
  awaiting_reply: DECISION_REGISTRY[REASON_CODE_BY_SIGNAL_KIND.awaiting_reply].problemLabel,
  overdue_appointment: DECISION_REGISTRY[REASON_CODE_BY_SIGNAL_KIND.overdue_appointment].problemLabel,
  awaiting_confirmation: DECISION_REGISTRY[REASON_CODE_BY_SIGNAL_KIND.awaiting_confirmation].problemLabel,
  abandoned_conversation: DECISION_REGISTRY[REASON_CODE_BY_SIGNAL_KIND.abandoned_conversation].problemLabel,
};

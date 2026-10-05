import type { OpportunityType } from "@/lib/opportunities/queries";
import type { AttentionItem } from "@/lib/dashboard/queries";

/**
 * Phase 2-2: the decision layer's own vocabulary - one reason code per
 * condition Today renders. Decision-layer names only: stored opportunity
 * types and AttentionItem kinds are never renamed, they map onto these.
 */
export type ReasonCode =
  // Operational exceptions (always first, untiered).
  | "human_escalation"
  | "calendar_sync_failed"
  | "automation_needs_attention"
  | "automation_retrying"
  // Live conversation / appointment signals.
  | "customer_awaiting_reply"
  | "appointment_overdue"
  | "appointment_unconfirmed"
  | "conversation_stalled"
  // Persisted opportunities.
  | "estimate_accepted_no_job"
  | "job_completed_not_invoiced"
  | "invoice_overdue"
  | "qualified_not_booked"
  | "appointment_completed_no_estimate"
  | "lead_not_contacted"
  | "lead_marked_hot_or_high_value"
  | "estimate_awaiting_decision"
  | "appointment_no_show"
  | "appointment_cancelled_not_rebooked"
  | "estimate_expired"
  | "customer_dormant"
  | "review_request_needed"
  | "referral_request_needed";

export type OperationalExceptionKind = Extract<AttentionItem["kind"], "human_escalation" | "calendar_disconnected" | "automation_needs_attention" | "automation_retrying">;
export type ConversationSignalKind = Extract<AttentionItem["kind"], "awaiting_reply" | "overdue_appointment" | "awaiting_confirmation" | "abandoned_conversation">;

export const REASON_CODE_BY_EXCEPTION_KIND: Record<OperationalExceptionKind, ReasonCode> = {
  human_escalation: "human_escalation",
  calendar_disconnected: "calendar_sync_failed",
  automation_needs_attention: "automation_needs_attention",
  automation_retrying: "automation_retrying",
};

export const REASON_CODE_BY_SIGNAL_KIND: Record<ConversationSignalKind, ReasonCode> = {
  awaiting_reply: "customer_awaiting_reply",
  overdue_appointment: "appointment_overdue",
  awaiting_confirmation: "appointment_unconfirmed",
  abandoned_conversation: "conversation_stalled",
};

export const REASON_CODE_BY_OPPORTUNITY_TYPE: Record<OpportunityType, ReasonCode> = {
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
};

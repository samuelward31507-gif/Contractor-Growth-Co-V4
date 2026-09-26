import type { LeadStatus, LeadTemperature } from "@/lib/leads/queries";
import type { EstimateStatus } from "@/lib/estimates/queries";
import type { JobStatus } from "@/lib/jobs/queries";
import type { AppointmentStatus } from "@/lib/appointments/queries";
import type { ConversationChannel, MessageStatus } from "@/lib/conversations/queries";

/**
 * Phase 5.1 - canonical BI metric types. These are the ONLY shapes the
 * dashboard (Phase 5.4) and future AI insights (Phase 5.3) should ever read
 * business metrics from - no page or feature should recompute any of these
 * numbers itself. See lib/bi/queries.ts for the single implementation.
 *
 * Naming discipline (per the Phase 5.1 audit): this codebase has no payment
 * infrastructure. Nothing here is ever called "revenue" - `estimated_value`,
 * `estimates.amount`, and `jobs.amount` are all quoted/contracted figures,
 * never confirmed collected money. Field names spell this out explicitly
 * (`pipelineValue`, `estimateValue`, `contractedJobValue`, ...) specifically
 * so a future caller cannot accidentally treat one of these as revenue.
 */

// ---------------------------------------------------------------------------
// Date range
// ---------------------------------------------------------------------------

export type DateRangePreset = "today" | "last7Days" | "last30Days" | "currentMonth" | "previousMonth" | "allTime";

/** Both bounds are ISO timestamps. `from` is inclusive, `to` is exclusive - a
 * half-open interval, so adjacent ranges (e.g. this month / last month)
 * never double-count a row that lands exactly on the boundary. */
export type CustomDateRange = { from: string | null; to: string | null };

export type DateRangeInput = DateRangePreset | CustomDateRange;

export type ResolvedDateRange = {
  /** Human label for display/debugging - not used for any query logic. */
  label: string;
  /** Inclusive lower bound, or null for unbounded ("all time"). */
  from: string | null;
  /** Exclusive upper bound, or null for unbounded (through "now"). */
  to: string | null;
};

// ---------------------------------------------------------------------------
// Metric definitions (documentation structure - see section 14 of the
// Phase 5.1 spec). This intentionally does NOT try to enumerate every single
// count field (e.g. every individual lead status) - that would duplicate the
// JSDoc already on each query function and drift out of sync with it. It
// documents the metrics whose reliability or terminology most needs to be
// explicit for a future caller (especially a future AI prompt) to not get
// wrong - the value/financial metrics and the follow-up/attribution metrics.
// ---------------------------------------------------------------------------

export type MetricReliability = "reliable" | "assumption_based";
export type MetricTemporality = "current_state" | "date_range";

export type MetricDefinition = {
  metric: string;
  sourceTable: string;
  sourceColumn: string | null;
  filter: string;
  /** Column used when a date range is applied. Null for a pure current-state metric. */
  timestampUsed: string | null;
  temporality: MetricTemporality;
  reliability: MetricReliability;
  notes?: string;
};

// ---------------------------------------------------------------------------
// Lead metrics
// ---------------------------------------------------------------------------

export type LeadMetrics = {
  totalLeads: number;
  byStatus: Record<LeadStatus, number>;
  newLeads: number;
  contactedLeads: number;
  qualifiedLeads: number;
  appointmentStageLeads: number;
  estimateStageLeads: number;
  wonLeads: number;
  lostLeads: number;
  byTemperature: Record<LeadTemperature, number>;
  hotLeads: number;
  warmLeads: number;
  coldLeads: number;
  /** Leads whose status is one of the non-terminal ("open") statuses - see OPEN_LEAD_STATUSES in lib/leads/queries.ts. */
  openLeads: number;
};

// ---------------------------------------------------------------------------
// Pipeline metrics
// ---------------------------------------------------------------------------

export type PipelineMetrics = {
  /**
   * SUM(leads.estimated_value) across leads whose status is one of
   * `pipelineStatuses`. This is a manually-entered estimate on the lead
   * itself, not derived from any real estimate/job record - explicitly NOT
   * revenue, and not even an estimate total (see EstimateMetrics for that).
   */
  pipelineValue: number;
  /** The exact lead statuses included in pipelineValue, for transparency. */
  pipelineStatuses: LeadStatus[];
};

// ---------------------------------------------------------------------------
// Estimate metrics
// ---------------------------------------------------------------------------

export type EstimateMetrics = {
  totalEstimates: number;
  byStatus: Record<EstimateStatus, number>;
  draftEstimates: number;
  sentEstimates: number;
  acceptedEstimates: number;
  declinedEstimates: number;
  cancelledEstimates: number;
  expiredEstimates: number;
  /** SUM(estimates.amount) across all estimates - a quoted total, not revenue. */
  totalEstimateValue: number;
  /** SUM(estimates.amount) where status = 'sent'. */
  sentEstimateValue: number;
  /** SUM(estimates.amount) where status = 'accepted' - still a quoted/contracted figure, not confirmed collected money. */
  acceptedEstimateValue: number;
  /** AVG(estimates.amount) across all estimates with a non-null amount. */
  averageEstimateValue: number;
};

// ---------------------------------------------------------------------------
// Job metrics
// ---------------------------------------------------------------------------

export type JobMetrics = {
  totalJobs: number;
  byStatus: Record<JobStatus, number>;
  scheduledJobs: number;
  inProgressJobs: number;
  completedJobs: number;
  cancelledJobs: number;
  /** SUM(jobs.amount) across all jobs - the quoted/contracted job value, never "revenue collected" (no payment infrastructure exists). */
  totalContractedJobValue: number;
  /** SUM(jobs.amount) where status = 'completed' - still a contracted figure, not a payment record. */
  completedContractedJobValue: number;
  /** AVG(jobs.amount) across all jobs with a non-null amount. */
  averageContractedJobValue: number;
};

// ---------------------------------------------------------------------------
// Appointment metrics
// ---------------------------------------------------------------------------

export type AppointmentMetrics = {
  totalAppointments: number;
  byStatus: Record<AppointmentStatus, number>;
  scheduledAppointments: number;
  confirmedAppointments: number;
  completedAppointments: number;
  cancelledAppointments: number;
  noShowAppointments: number;
};

// ---------------------------------------------------------------------------
// Communication metrics
// ---------------------------------------------------------------------------

export type CommunicationMetrics = {
  totalInboundMessages: number;
  totalOutboundMessages: number;
  aiOutboundMessages: number;
  userOutboundMessages: number;
  systemOutboundMessages: number;
  openConversations: number;
  closedConversations: number;
  byChannel: Record<ConversationChannel, number>;
  smsConversations: number;
  webConversations: number;
  emailConversations: number;
  voiceConversations: number;
  byMessageStatus: Record<MessageStatus, number>;
  deliveredMessages: number;
  failedMessages: number;
  undeliveredMessages: number;
  queuedMessages: number;
};

// ---------------------------------------------------------------------------
// Automation metrics
// ---------------------------------------------------------------------------

export type AutomationMetrics = {
  totalAutomationEvents: number;
  completedAutomationEvents: number;
  failedAutomationEvents: number;
  pendingAutomationEvents: number;
  processingAutomationEvents: number;
  /** Keyed by automation_events.event_type (e.g. "lead.created", "estimate.sent") - free text, not an enum. */
  automationEventsByType: Record<string, number>;
  totalWorkflowExecutions: number;
  completedWorkflows: number;
  failedWorkflows: number;
  runningWorkflows: number;
  cancelledWorkflows: number;
  /** Keyed by workflow_executions.workflow_name - free text, not an enum. */
  workflowExecutionsByName: Record<string, number>;
};

// ---------------------------------------------------------------------------
// AI metrics
// ---------------------------------------------------------------------------

export type AiMetrics = {
  totalAiInteractions: number;
  /** Keyed by ai_interactions.interaction_type. */
  aiInteractionsByType: Record<string, number>;
  /** Keyed by ai_interactions.model. A null/missing model is grouped under "unknown". */
  aiInteractionsByModel: Record<string, number>;
};

// ---------------------------------------------------------------------------
// Follow-up / automation-activity metrics
//
// These are activity counts only - "an automated touch was sent" - never a
// claim that the touch caused any subsequent outcome. See the Phase 5.1
// audit (section 8): attributing a later status change or revenue to one of
// these events would be a causal claim this data cannot support.
// ---------------------------------------------------------------------------

export type FollowUpMetrics = {
  /** automation_events where event_type = 'lead.lost_nurture'. */
  leadLostNurtureEvents: number;
  /** automation_events where event_type = 'lead.reactivation'. */
  leadReactivationEvents: number;
  /** automation_events where event_type = 'estimate.followup'. */
  estimateFollowupEvents: number;
  /** automation_events where event_type = 'job.post_followup'. */
  postJobFollowupEvents: number;
  /** automation_events where entity_type = 'appointment' (covers appointment.created, appointment.no_show, appointment.reminder, and the appointment lifecycle events). */
  appointmentAutomationEvents: number;
};

// ---------------------------------------------------------------------------
// Review & Referral metrics (Review & Referral Tracking V1)
//
// Every count here is a real, tracked event (a review_requests/
// referral_requests row and its actual status), never inferred - see
// lib/reviews-referrals/tracking.ts for exactly what can and cannot move a
// row to each status. The two rate fields follow this file's own
// null-on-undefined-denominator discipline: with zero requests, the rate is
// `null` (no data), never a fabricated 0%. "Completed"/"converted" here mean
// exactly what the product's status model means - a human (the contractor)
// explicitly confirmed it, never an SMS-sent or AI-inferred proxy for it.
// -----------------------------------------------------------------------
export type ReviewReferralMetrics = {
  reviewsRequested: number;
  reviewsResponded: number;
  reviewsCompleted: number;
  reviewsDeclined: number;
  reviewsFailed: number;
  /** reviewsResponded / reviewsRequested, or null if reviewsRequested is 0. */
  reviewResponseRate: number | null;
  /** reviewsCompleted / reviewsRequested, or null if reviewsRequested is 0. */
  reviewCompletionRate: number | null;
  referralsRequested: number;
  referralsResponded: number;
  referralsConverted: number;
  referralsDeclined: number;
  referralsFailed: number;
  /** referralsResponded / referralsRequested, or null if referralsRequested is 0. */
  referralResponseRate: number | null;
  /** referralsConverted / referralsRequested, or null if referralsRequested is 0. */
  referralConversionRate: number | null;
};

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export type BusinessIntelligenceSnapshot = {
  organizationId: string;
  dateRange: ResolvedDateRange;
  leads: LeadMetrics;
  pipeline: PipelineMetrics;
  estimates: EstimateMetrics;
  jobs: JobMetrics;
  appointments: AppointmentMetrics;
  communication: CommunicationMetrics;
  automation: AutomationMetrics;
  ai: AiMetrics;
  followUp: FollowUpMetrics;
  reviewReferral: ReviewReferralMetrics;
  /** Wall-clock time this snapshot was computed - not a business timestamp. */
  generatedAt: string;
};

// =============================================================================
// Phase 5.2 - Business Intelligence Metrics Layer
//
// Everything below is additive to Phase 5.1 (which is frozen - nothing above
// this line was changed). Phase 5.2 turns Phase 5.1's raw counts/sums into a
// contractor-focused metrics contract: adds rate calculations (with
// null-on-undefined-denominator semantics, never a divide-by-zero or a
// fabricated 0%/100%), period-over-period comparisons, and a small
// dataQuality block. See lib/bi/metrics.ts for the implementation - it
// consumes Phase 5.1's query functions and does not duplicate their queries.
// =============================================================================

/**
 * A rate/percentage is `null`, never 0 or a fabricated number, whenever its
 * denominator is 0 - there is no such thing as a 0% or 100% rate over zero
 * observations, and returning either would misrepresent "no data yet" as a
 * real measured outcome.
 */
export type Rate = number | null;

/**
 * Period-over-period comparison for a single count metric. `previous` (and
 * therefore `change`/`percentageChange`) is `null` whenever the current
 * period has no defined previous period of the same length - this happens
 * exactly when the current range is open-ended (e.g. "all time", or a custom
 * range missing a bound). `percentageChange` is additionally `null` whenever
 * `previous` is 0, per the explicit "never divide by zero" requirement - a
 * change from 0 has no defined percentage.
 */
export type PeriodComparison = {
  current: number;
  previous: number | null;
  change: number | null;
  percentageChange: number | null;
};

export type BusinessMetricsComparisons = {
  leadCount: PeriodComparison;
  estimateCount: PeriodComparison;
  jobCount: PeriodComparison;
  /**
   * Pass 5C, Batch 3B: distinct leads with at least one recorded
   * lead.stage_changed transition into 'qualified' in the current vs.
   * previous period - a pure activity count over automation_events.created_at,
   * the same comparison semantics as leadCount/estimateCount/jobCount above
   * (null `previous`/`percentageChange` under the identical open-ended-range
   * and zero-previous rules). Never a rate, never a claim about coverage -
   * see LeadStageTimingMetrics for the (deliberately not compared) timing
   * figures this count is distinct from.
   */
  leadsTransitionedToQualified: PeriodComparison;
  /** Same shape as leadsTransitionedToQualified, for the 'won' transition. */
  leadsTransitionedToWon: PeriodComparison;
  /**
   * Distinct leads (created in the current vs. previous period) with at
   * least one real successful outbound message recorded at or after their
   * own creation - the same population LeadResponseTimeMetrics.leadsContacted
   * counts for a single period. A pure count comparison, never the
   * contactRate percentage itself (no existing precedent in this file
   * compares a rate across periods - see this field's own Batch 3B audit).
   */
  leadsContacted: PeriodComparison;
};

export type BiLeadMetrics = {
  totalLeads: number;
  newLeads: number;
  contactedLeads: number;
  qualifiedLeads: number;
  appointmentStageLeads: number;
  estimateStageLeads: number;
  wonLeads: number;
  lostLeads: number;
  hotLeads: number;
  warmLeads: number;
  coldLeads: number;
  /**
   * lostLeads / (wonLeads + lostLeads) - the fraction of leads that reached
   * a terminal outcome and were lost. `null` when neither has happened yet
   * (denominator 0). This is a current-state ratio over the two terminal
   * statuses, not a time-based conversion rate - Phase 5.1 confirmed no
   * stage-transition history exists to compute a true historical rate.
   */
  lostRate: Rate;
  /**
   * Counted by `leads.source`, exactly as stored (nullable/free text -> a
   * null source is grouped under "unknown"). Exposed for transparency only -
   * per the Phase 5.1 audit, `leads.source` is not standardized in this
   * database, so this layer never ranks, labels, or compares sources by
   * performance. See dataQuality.sourceAttributionLimited.
   */
  sourceCounts: Record<string, number>;
  /**
   * Growth System Completion Pass 2, Part 2: the fraction of leads (created
   * within the requested range) that have at least one real appointment
   * (any `appointments.lead_id` match, regardless of the appointment's own
   * status or date) - a current-state cross-reference over real data, not a
   * time-based conversion rate (see dataQuality.stageHistoryUnavailable).
   * `null` when there are zero leads in range.
   */
  leadToBookingRate: Rate;
};

export type BiPipelineMetrics = {
  /** Count of leads whose status is one of the non-terminal statuses (new, contacted, qualified, appointment, estimate). */
  openOpportunityCount: number;
  /** SUM(leads.estimated_value) over the same open statuses - a manual estimate on the lead, never revenue. */
  pipelineValue: number;
  /** pipelineValue / openOpportunityCount. `null` when openOpportunityCount is 0. */
  averagePipelineValue: number | null;
};

export type BiEstimateMetrics = {
  totalEstimates: number;
  draftEstimates: number;
  sentEstimates: number;
  acceptedEstimates: number;
  declinedEstimates: number;
  cancelledEstimates: number;
  expiredEstimates: number;
  /** SUM(estimates.amount) across all estimates - quoted/contracted total, never revenue. */
  estimateValue: number;
  /**
   * Trackpr 2.0 Phase 5: SUM(estimates.amount) where status = 'accepted' -
   * already computed by lib/bi/queries.ts's getEstimateMetrics (one pass
   * over the same rows as estimateValue), just not previously threaded
   * through this layer. Still a quoted/contracted figure the customer
   * agreed to, never collected payment.
   */
  acceptedEstimateValue: number;
  /** AVG(estimates.amount). `null` when there are zero estimates with a non-null amount. */
  averageEstimateValue: number | null;
  /**
   * acceptedEstimates / (acceptedEstimates + declinedEstimates) - deliberately
   * excludes draft/sent/cancelled/expired from the denominator so an estimate
   * that hasn't yet received a real customer decision never dilutes the rate.
   * `null` when the denominator is 0.
   */
  estimateAcceptanceRate: Rate;
  /**
   * totalJobs / acceptedEstimates. Reliable because job creation is
   * synchronous with estimate acceptance in this codebase (one job per
   * accepted estimate, enforced by a unique index on jobs.estimate_id - see
   * lib/automation/jobs.ts) - every job traces back to exactly one accepted
   * estimate. `null` when acceptedEstimates is 0.
   */
  estimateToJobRate: Rate;
};

export type BiJobMetrics = {
  totalJobs: number;
  scheduledJobs: number;
  inProgressJobs: number;
  completedJobs: number;
  cancelledJobs: number;
  /** SUM(jobs.amount) - the contracted job value, never "revenue collected" (no payment infrastructure exists). */
  contractedJobValue: number;
  /**
   * Trackpr 2.0 Phase 5: SUM(jobs.amount) where status = 'completed' -
   * already computed by lib/bi/queries.ts's getJobMetrics (one pass over
   * the same rows as contractedJobValue), just not previously threaded
   * through this layer. The closest this schema can get to "revenue won" -
   * still the contracted figure for completed work, not a payment record
   * (no payment infrastructure exists), so it is deliberately never labeled
   * "revenue" in the UI either.
   */
  completedContractedJobValue: number;
  /** AVG(jobs.amount). `null` when there are zero jobs with a non-null amount. */
  averageContractedJobValue: number | null;
  /** completedJobs / (completedJobs + cancelledJobs). `null` when the denominator is 0. */
  jobCompletionRate: Rate;
};

export type BiAppointmentMetrics = {
  totalAppointments: number;
  scheduledAppointments: number;
  confirmedAppointments: number;
  completedAppointments: number;
  cancelledAppointments: number;
  noShowAppointments: number;
  /** noShowAppointments / (completedAppointments + cancelledAppointments + noShowAppointments) - the three "resolved" outcomes. `null` when the denominator is 0. */
  appointmentNoShowRate: Rate;
};

export type BiCommunicationMetrics = {
  inboundMessages: number;
  outboundMessages: number;
  /** Equal to inboundMessages - every inbound message in this system is sender_type='customer' by construction (verified in the Phase 4.8/4.9 audits: the inbound SMS webhook always writes direction='inbound', sender_type='customer'). Exposed under this name because "a customer replied" is the business-meaningful framing. */
  customerReplies: number;
  aiOutboundMessages: number;
  userOutboundMessages: number;
  systemOutboundMessages: number;
  conversationsOpened: number;
  conversationsClosed: number;
  /** contacts.sms_opt_out = true, scoped by contacts.created_at within the requested range - not an opt-out EVENT timestamp (no such column exists), so this measures "opted-out contacts created in this window," not "opt-outs that occurred in this window." */
  optOutCount: number;
};

export type BiAutomationMetrics = {
  automationEvents: number;
  completedAutomationEvents: number;
  failedAutomationEvents: number;
  pendingAutomationEvents: number;
  workflowExecutions: number;
  successfulWorkflowExecutions: number;
  failedWorkflowExecutions: number;
  runningWorkflowExecutions: number;
  /**
   * successfulWorkflowExecutions / (successfulWorkflowExecutions +
   * failedWorkflowExecutions) - computed over workflow_executions (the
   * dispatch/delivery outcome), not automation_events (which records the
   * business event itself, not whether the automation succeeded). `null`
   * when the denominator is 0.
   */
  automationSuccessRate: Rate;
};

export type BiAiMetrics = {
  aiInteractions: number;
  /** ai_interactions where the stored structured output has should_send = true - the AI actually recommended sending a message (subject to the outbound gate, which is not reflected here). */
  aiOutboundInteractions: number;
  /** ai_interactions where interaction_type = 'customer_reply_response'. */
  customerReplyAiInteractions: number;
  /** ai_interactions where the stored structured output has needs_human = true. */
  aiNeedsHumanCount: number;
  /**
   * Growth System Completion Pass 2, Part 4: SUM(ai_interactions.tokens_used)
   * over rows that actually have a non-null value - `null` when zero rows in
   * range have any usage data at all (never a fabricated 0, since 0 would
   * misrepresent "not reported" as "reported zero tokens").
   */
  totalTokensUsed: number | null;
  /** AVG(ai_interactions.tokens_used) over the same non-null rows. `null` under the same condition as totalTokensUsed. */
  averageTokensPerInteraction: number | null;
  /** Count of ai_interactions in range that have a non-null tokens_used - lets a caller show "usage data available for N of M interactions" rather than implying every interaction was measured. */
  interactionsWithUsageData: number;
};

export type BiFollowUpMetrics = {
  /** automation_events where event_type = 'lead.lost_nurture'. */
  lostLeadNurtureEvents: number;
  /** automation_events where event_type = 'lead.reactivation'. */
  reactivationEvents: number;
  /** automation_events where event_type = 'appointment.reminder'. */
  appointmentReminderEvents: number;
  /** automation_events where event_type = 'estimate.followup'. */
  estimateFollowUpEvents: number;
  /** automation_events where event_type = 'job.post_followup'. */
  postJobFollowUpEvents: number;
  /**
   * Distinct leads with at least one automation_events row where
   * entity_type = 'lead' (lead.created, lead.lost, lead.lost_nurture,
   * lead.reactivation). Deliberately conservative: it does NOT reach into
   * the payload of appointment/estimate/job/customer-reply events to find an
   * indirectly-associated lead_id, since those payload shapes are not
   * uniform across event types - only direct lead-entity events are counted,
   * so this is a floor, not a complete count of every lead automation has
   * ever touched.
   */
  leadsTouchedByAutomation: number;
};

/**
 * Growth System Completion Pass 2, Part 3: "Revenue Opportunity" - factual,
 * currently-open-or-recoverable amounts and counts built entirely from
 * existing estimates/leads/appointments data. Every field name and comment
 * here is deliberately explicit that this is quoted/contracted opportunity,
 * never revenue, and never a probability-weighted or close-rate-adjusted
 * figure - see lib/bi/types.ts's own file-level naming discipline. Nothing
 * here is fabricated: each field is a real SUM/COUNT over a real, already-
 * existing status, and any figure that cannot be reliably computed from
 * existing data is simply absent from this type rather than estimated.
 */
export type BiRevenueOpportunity = {
  /** SUM(estimates.amount) where status = 'sent' - real, quoted work still awaiting a customer decision. */
  openEstimateValue: number;
  /** SUM(estimates.amount) where status = 'expired' - quoted work whose follow-up window closed with no customer decision ever recorded. */
  expiredEstimateValue: number;
  /** SUM(estimates.amount) where status = 'declined' - quoted work the customer explicitly turned down. Shown for reference only; never summed into recoverableEstimateValue. */
  lostEstimateValue: number;
  /** openEstimateValue + expiredEstimateValue - real, quoted amounts that have NOT been explicitly declined and could still convert. Deliberately excludes lostEstimateValue (a customer already said no) and is never probability-weighted. */
  recoverableEstimateValue: number;
  /** Count of leads currently in 'qualified' status with no appointment ever booked - a real, ready-to-book opportunity sitting idle. */
  qualifiedLeadsWithoutAppointment: number;
  /** Count of appointments with status = 'completed' whose lead has no estimate at all - a completed visit that never turned into a quote. */
  completedAppointmentsWithoutEstimate: number;
};

/**
 * Explicit, honest limitations of the current data - see the Phase 5.1
 * audit. Every flag here is a fact about this codebase/schema today, not a
 * per-organization computed judgment - kept deliberately small per the
 * "do not overbuild a data-quality framework" instruction.
 */
export type BiDataQuality = {
  /** No payment/invoicing infrastructure exists anywhere in this codebase - every "value" figure is quoted/contracted, never confirmed collected money. */
  collectedRevenueUnavailable: true;
  /** leads.source is nullable, free-text, and not standardized - source counts are exposed but never ranked or labeled as "best"/"worst"/"highest converting". */
  sourceAttributionLimited: true;
  /**
   * Pass 5C, Batch 3A: previously a hardcoded `true` - the Pass 5C Batch 3
   * audit found that real, timestamped lead stage-transition history has
   * existed since Growth System Completion Pass 2, Part 1
   * (lib/automation/lead-stage-history.ts's lead.stage_changed events), it
   * was simply never wired into this layer's own dataQuality computation.
   * Now computed dynamically, exactly like aiTokenUsageUnavailable below:
   * `true` only when zero lead.stage_changed events exist for this
   * organization within the requested range, `false` once at least one real,
   * recorded transition exists. This does NOT mean every lead in range has
   * complete historical timing - a lead created before this feature shipped,
   * or one that has simply never had a tracked transition recorded, still
   * has no historical timing available for it individually (see
   * LeadStageTimingMetrics.leadsWithRecordedHistory in this file, and
   * lib/bi/funnel.ts's own header comment, for exactly how that partial-
   * coverage case is represented - never fabricated from updated_at or
   * inferred from current status).
   */
  stageHistoryUnavailable: boolean;
  /**
   * Growth System Completion Pass 2, Part 4: ai_interactions.tokens_used CAN
   * now be populated (when n8n's own AI call reports usage - see
   * app/api/automation/n8n-callback/route.ts's AiResult.usage), but whether
   * it actually IS populated depends entirely on what n8n sends. This is
   * computed dynamically per snapshot - `true` only when zero interactions
   * in the requested range have any usage data at all, never a hardcoded
   * assumption either way.
   */
  aiTokenUsageUnavailable: boolean;
  /** Short, human-readable notes elaborating on the flags above. */
  notes: string[];
};

export type BusinessMetricsSnapshot = {
  organizationId: string;
  period: ResolvedDateRange;
  comparisons: BusinessMetricsComparisons;
  leadMetrics: BiLeadMetrics;
  pipelineMetrics: BiPipelineMetrics;
  estimateMetrics: BiEstimateMetrics;
  jobMetrics: BiJobMetrics;
  appointmentMetrics: BiAppointmentMetrics;
  communicationMetrics: BiCommunicationMetrics;
  automationMetrics: BiAutomationMetrics;
  aiMetrics: BiAiMetrics;
  followUpMetrics: BiFollowUpMetrics;
  /**
   * Pass 3 (Revenue Intelligence Foundation): unlike every other group in
   * this snapshot, revenueOpportunity is deliberately NEVER scoped by
   * `period` - it answers "what needs attention right now" (a qualified
   * lead sitting unbooked, an estimate that expired, a completed visit that
   * never got quoted), a current-state question, not "how much of this
   * happened within the requested reporting window." Computed against an
   * unbounded range internally regardless of what `period` the caller
   * requested - see getBusinessMetricsSnapshot's own comment for why this
   * matters (a date-scoped call, e.g. "today", would otherwise make this
   * block read as almost always empty).
   */
  revenueOpportunity: BiRevenueOpportunity;
  /**
   * Pass 3 (Revenue Intelligence Foundation): migrated in from the
   * superseded Phase 5.1 BusinessIntelligenceSnapshot type (which nothing
   * in the app calls anymore) rather than left orphaned there - same real,
   * already-tested calculation (lib/bi/queries.ts's getReviewReferralMetrics),
   * not recomputed or duplicated. Scoped by `period` like every other group
   * except revenueOpportunity above - "how many review/referral requests
   * were created in this window" is a genuine date-range question.
   */
  reviewReferralMetrics: ReviewReferralMetrics;
  /**
   * Pass 5C, Batch 3B: the historical lead-stage funnel (lib/bi/funnel.ts's
   * getLeadStageTransitionMetrics/getLeadStageTimingMetrics), wired into the
   * snapshot for the first time - unlike revenueOpportunity/
   * RepeatCustomerSummary, both `transitions` (scoped by the transition's own
   * created_at) and `timing` (scoped by leads.created_at) are genuinely
   * period-scoped, computed for the same `period` as every other group here.
   * `timing`'s own averages are only ever computed over leads with a real
   * recorded transition (leadsWithQualifiedTiming/leadsWithWonTiming) -
   * never fabricated for the full leadsInRange population. See
   * LeadStageTimingMetrics's own doc comment above for the exact coverage
   * semantics a caller must respect before displaying any of its averages.
   */
  leadStageFunnel: { transitions: LeadStageTransitionMetrics; timing: LeadStageTimingMetrics };
  /**
   * Pass 5C, Batch 3B: lib/bi/funnel.ts's getLeadResponseTimeMetrics, scoped
   * to the same `period` as every other group here. See
   * LeadResponseTimeMetrics's own doc comment above for the full evidence
   * hierarchy, population definition, and the explicit created_at-vs-
   * delivery-time limitation - never rendered with wording that implies a
   * guaranteed Twilio delivery timestamp.
   */
  responseTime: LeadResponseTimeMetrics;
  dataQuality: BiDataQuality;
  /**
   * Trackpr 2.0, Phase 4B (P1 #2): true when at least one of this snapshot's
   * own core reads (lead/pipeline, estimates, jobs, appointments, AI)
   * returned a real Postgrest error rather than a genuinely empty result. A
   * successful `{ data: [], error: null }` response NEVER sets this - "no
   * data" and "the read failed" are and remain two different things.
   * Mirrors DashboardData.partialData (lib/dashboard/queries.ts) exactly.
   * Never carries the raw error itself - see partialDataSourceCount for the
   * one bounded, non-identifying number this exposes.
   */
  partialData: boolean;
  /** Count (0-5) of which of this snapshot's own 5 tracked reads failed - bounded, non-identifying, for future debugging only. Never rendered to the end user as a specific number. */
  partialDataSourceCount: number;
  /** Wall-clock time this snapshot was computed - not a business timestamp. */
  generatedAt: string;
};

// =============================================================================
// Pass 5C, Batch 3A - Funnel Truth + Response Intelligence. Two genuinely new
// capabilities, implemented in lib/bi/funnel.ts (a new, separate file - not
// merged into the "frozen"/"additive-only" Phase 5.1/5.2 files above), each
// independently callable and NOT wired into BusinessMetricsSnapshot's own
// shape - the only Batch 3A change to the existing snapshot is
// BiDataQuality.stageHistoryUnavailable becoming a real, computed boolean
// (see that field's own comment above). Wiring either capability into the
// analytics page UI is explicitly out of this pass's authorized scope.
// =============================================================================

// ---------------------------------------------------------------------------
// Historical lead-stage funnel (Part C)
// ---------------------------------------------------------------------------

/**
 * Real, timestamped lead.stage_changed events
 * (lib/automation/lead-stage-history.ts), counted by (previousStatus ->
 * newStatus) pair and scoped by the TRANSITION's own created_at (when the
 * transition itself happened) - not by when the lead was created. This is
 * activity-count data: "N transitions of this shape happened in this
 * window," never a claim about how many leads currently sit in a stage
 * (that remains BiLeadMetrics' own current-state job).
 */
export type LeadStageTransitionMetrics = {
  /** Every recorded lead.stage_changed event in range, regardless of shape. */
  totalTransitions: number;
  /** Distinct leads with at least one recorded transition INTO 'qualified' within range. */
  leadsTransitionedToQualified: number;
  /** Distinct leads with at least one recorded transition INTO 'won' within range. */
  leadsTransitionedToWon: number;
  /**
   * Keyed as `${previousStatus ?? "null"}->${newStatus}` (e.g.
   * "new->contacted", "null->new" for a lead's very first recorded entry at
   * creation). Free-form, not a fixed enum of keys - only pairs that
   * genuinely occurred in range appear.
   */
  transitionCounts: Record<string, number>;
};

/**
 * Real elapsed time from a lead's own `leads.created_at` to the first
 * RECORDED transition into a given stage - never derived from
 * `leads.updated_at`, never inferred from the lead's current status, and
 * never inferred merely because a related appointment/estimate exists (an
 * appointment or estimate being created does NOT itself write a
 * lead.stage_changed event - see lib/dashboard/queries.ts's Batch 3A fix for
 * the real, separate cross-reference that handles that question). A lead
 * created before lead-stage history existed, or one that simply never had a
 * transition recorded, contributes to `leadsInRange` but NOT to the timing
 * averages - its timing is unavailable, never fabricated as 0 or omitted
 * silently from the denominator in a way that would misrepresent coverage.
 */
export type LeadStageTimingMetrics = {
  /** Leads created within range - the population these timing figures are computed over. */
  leadsInRange: number;
  /** Leads in range with ANY recorded stage-history entry at all (including just the creation entry) - lets a caller honestly show "historical timing available for N of M leads," never assume full coverage. */
  leadsWithRecordedHistory: number;
  /** Leads in range with a genuine recorded transition into 'qualified' - real timing available for exactly these leads, no more. */
  leadsWithQualifiedTiming: number;
  /** Average ms from leads.created_at to the first recorded 'qualified' transition, across only leadsWithQualifiedTiming. Null when that count is 0. */
  averageTimeToQualifiedMs: number | null;
  /** Median ms, same population as averageTimeToQualifiedMs. Null under the same condition. */
  medianTimeToQualifiedMs: number | null;
  /** Same shape as the three qualified-timing fields above, for the 'won' transition. */
  leadsWithWonTiming: number;
  averageTimeToWonMs: number | null;
  medianTimeToWonMs: number | null;
};

// ---------------------------------------------------------------------------
// Lead response-time intelligence (Part D)
// ---------------------------------------------------------------------------

export type ResponseTimeBucket = "under_1_min" | "1_to_5_min" | "5_to_15_min" | "15_to_60_min" | "1_to_24_hours" | "over_24_hours";

/**
 * Time from `leads.created_at` to the first real, successful outbound
 * message (`messages.direction = 'outbound' AND status IN ('sent',
 * 'delivered')`) recorded for that lead's own contact, joined via
 * `leads.contact_id -> conversations.contact_id -> messages.conversation_id`
 * - the exact evidence hierarchy established in Pass 5C Batch 2's
 * `uncontacted_lead` opportunity detector. `queued`/`failed`/`undelivered`
 * outbound messages, any `workflow_executions`/`automation_events`/
 * `ai_interactions` row, and any AI `should_send` decision are NEVER treated
 * as contact - only a real, carrier-accepted-or-delivered message counts.
 *
 * KNOWN LIMITATION (deliberately not fixed in this pass - see Part E of the
 * Batch 3A task): `messages` has only `created_at`, no dedicated `sent_at`/
 * `delivered_at`. The response timestamp used here is therefore the
 * message ROW's created_at (when Trackpr recorded the outbound attempt),
 * not a guaranteed Twilio delivery timestamp. A `status = 'delivered'`
 * message proves the message eventually reached the carrier successfully,
 * but its exact delivery moment is not separately recorded - only when the
 * row was created is known precisely.
 *
 * POPULATION: every lead created within the requested range, regardless of
 * status, source, or whether it was ever eligible for automated outbound -
 * the broadest defensible population, never silently narrowed. A lead with
 * no `contact_id` at all can structurally never be contacted and correctly
 * falls under `leadsNeverContacted`. For a contact with more than one lead
 * over time, a message only counts toward a given lead if its own
 * `created_at` is at or after that specific lead's `created_at` - an outbound
 * message that predates this lead (e.g. it answered an earlier, separate
 * inquiry from the same contact) is never counted as this lead's response.
 */
export type LeadResponseTimeMetrics = {
  totalLeadsInPopulation: number;
  leadsContacted: number;
  leadsNeverContacted: number;
  /** leadsContacted / totalLeadsInPopulation, as a 0-100 percentage (matching lib/bi/metrics.ts's own Rate convention, NOT lib/bi/queries.ts's 0-1 fraction). Null when totalLeadsInPopulation is 0. */
  contactRate: number | null;
  /** Average ms from leads.created_at to first successful outbound, across only leadsContacted. Null when leadsContacted is 0. */
  averageResponseTimeMs: number | null;
  /** Median ms, same population. Null under the same condition. */
  medianResponseTimeMs: number | null;
  /** Mutually exclusive bucket counts over leadsContacted only - sums to leadsContacted, never includes leadsNeverContacted. */
  bucketCounts: Record<ResponseTimeBucket, number>;
};

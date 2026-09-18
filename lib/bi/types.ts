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
  /** Wall-clock time this snapshot was computed - not a business timestamp. */
  generatedAt: string;
};

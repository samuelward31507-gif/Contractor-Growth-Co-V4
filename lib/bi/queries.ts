import type { SupabaseClient } from "@supabase/supabase-js";
import { LEAD_STATUSES, LEAD_TEMPERATURES, OPEN_LEAD_STATUSES, type LeadStatus, type LeadTemperature } from "@/lib/leads/queries";
import { ESTIMATE_STATUSES, type EstimateStatus } from "@/lib/estimates/queries";
import { JOB_STATUSES, type JobStatus } from "@/lib/jobs/queries";
import { APPOINTMENT_STATUSES, type AppointmentStatus } from "@/lib/appointments/queries";
import { CONVERSATION_CHANNELS, type ConversationChannel, type MessageStatus } from "@/lib/conversations/queries";
import type {
  DateRangeInput,
  ResolvedDateRange,
  LeadMetrics,
  PipelineMetrics,
  EstimateMetrics,
  JobMetrics,
  AppointmentMetrics,
  CommunicationMetrics,
  AutomationMetrics,
  AiMetrics,
  FollowUpMetrics,
  BusinessIntelligenceSnapshot,
} from "./types";

/**
 * Phase 5.1 - canonical BI metrics layer. This is the ONLY place any of
 * these numbers should ever be computed - the dashboard (Phase 5.4) and
 * future AI insights (Phase 5.3) must both call into this file rather than
 * recomputing a metric themselves. See lib/bi/types.ts for the documented
 * shape of every metric and the naming discipline around "value" vs
 * "revenue" (there is no payment infrastructure in this codebase - see the
 * Phase 5.1 audit).
 *
 * Every function here takes an already-resolved `organizationId` exactly
 * like every other query module in this codebase (lib/dashboard/queries.ts,
 * lib/leads/queries.ts, ...) - callers resolve it via
 * getUserOrganization(supabase, user.id) first (see lib/auth/organization.ts)
 * and are responsible for verifying the caller is actually a member of that
 * organization before calling in here. RLS (is_org_member(organization_id),
 * verified on every relevant table in the Phase 5.1 audit) remains
 * defense-in-depth underneath every query below - this file never bypasses
 * it and never uses a service-role client itself.
 *
 * Query strategy: each metric group issues exactly ONE narrow-column,
 * org-scoped, date-range-scoped SELECT per source table (never `select("*")`,
 * never one query per status value) and reduces counts/sums from that single
 * result in memory - the same "fetch once, derive everything" approach
 * lib/dashboard/queries.ts already uses, chosen deliberately over N separate
 * `count: 'exact', head: true` queries per status so that a single table
 * only needs to be read once per metric group even though several counts and
 * sums are derived from it (e.g. the one `leads` fetch below produces both
 * LeadMetrics and PipelineMetrics). Each fetch is capped at MAX_ROWS as a
 * safety bound; at the data volumes confirmed in the Phase 5.1 audit (a
 * handful of rows per table, in one production organization) this is not a
 * practical limitation. If a real organization's row count for one of these
 * tables approaches that cap, the honest next step is a real SQL COUNT/SUM
 * (an RPC) for that table - not raising the cap.
 */

const MAX_ROWS = 10_000;

// ---------------------------------------------------------------------------
// Date range
// ---------------------------------------------------------------------------

/**
 * Resolves a preset or custom date range into concrete ISO boundaries.
 * `from` is inclusive, `to` is exclusive. Boundaries for the named presets
 * are computed using the server process's local time (JS `Date` local
 * getters/setters, not UTC and not the organization's own timezone) - a
 * known simplification, not a per-organization-correct "start of day."
 * Timezone-aware bucketing would need the organization's `timezone` column
 * threaded through here; that's a reasonable Phase 5 follow-up, not part of
 * this phase's scope.
 */
export function resolveDateRange(input: DateRangeInput, now: Date = new Date()): ResolvedDateRange {
  if (typeof input === "object" && input !== null) {
    return { label: "custom", from: input.from, to: input.to };
  }

  switch (input) {
    case "allTime":
      return { label: "all time", from: null, to: null };

    case "today": {
      const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const to = new Date(from);
      to.setDate(to.getDate() + 1);
      return { label: "today", from: from.toISOString(), to: to.toISOString() };
    }

    case "last7Days": {
      const to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      to.setDate(to.getDate() + 1);
      const from = new Date(to);
      from.setDate(from.getDate() - 7);
      return { label: "last 7 days", from: from.toISOString(), to: to.toISOString() };
    }

    case "last30Days": {
      const to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      to.setDate(to.getDate() + 1);
      const from = new Date(to);
      from.setDate(from.getDate() - 30);
      return { label: "last 30 days", from: from.toISOString(), to: to.toISOString() };
    }

    case "currentMonth": {
      const from = new Date(now.getFullYear(), now.getMonth(), 1);
      const to = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      return { label: "current month", from: from.toISOString(), to: to.toISOString() };
    }

    case "previousMonth": {
      const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const to = new Date(now.getFullYear(), now.getMonth(), 1);
      return { label: "previous month", from: from.toISOString(), to: to.toISOString() };
    }

    default:
      return { label: "all time", from: null, to: null };
  }
}

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

function zeroCounts<K extends string>(keys: readonly K[]): Record<K, number> {
  const result = {} as Record<K, number>;
  for (const key of keys) result[key] = 0;
  return result;
}

function sum(values: (number | null)[]): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return sum(values) / values.length;
}

// Mirrors the DB CHECK constraints - see the Phase 5.1 audit. No exported
// constant exists for these elsewhere in the codebase (unlike LEAD_STATUSES
// etc.), so they're defined once, locally, here.
const MESSAGE_STATUSES: MessageStatus[] = ["queued", "sent", "delivered", "failed", "undelivered", "received", "logged"];
const AUTOMATION_EVENT_STATUSES = ["pending", "processing", "completed", "failed"] as const;
const WORKFLOW_EXECUTION_STATUSES = ["running", "completed", "failed", "cancelled"] as const;

// ---------------------------------------------------------------------------
// Leads + pipeline (one fetch feeds both)
// ---------------------------------------------------------------------------

/**
 * Definition: current-state counts by `leads.status` / `leads.temperature`,
 * plus pipeline value = SUM(leads.estimated_value) over the non-terminal
 * ("open") statuses (new, contacted, qualified, appointment, estimate - see
 * OPEN_LEAD_STATUSES). Timestamp used for date-range filtering: created_at.
 * Reliability: directly reliable (Phase 5.1 audit section 2/5) - these are
 * live counts/sums over stored columns, not derived history. No historical
 * stage-transition data exists, so this never reports "when" a lead entered
 * a stage - only current counts.
 */
export async function getLeadAndPipelineMetrics(
  supabase: SupabaseClient,
  organizationId: string,
  range: ResolvedDateRange,
): Promise<{ leads: LeadMetrics; pipeline: PipelineMetrics }> {
  let query = supabase
    .from("leads")
    .select("status, temperature, estimated_value")
    .eq("organization_id", organizationId)
    .limit(MAX_ROWS);
  if (range.from) query = query.gte("created_at", range.from);
  if (range.to) query = query.lt("created_at", range.to);

  const { data } = await query;
  const rows = (data ?? []) as { status: LeadStatus; temperature: LeadTemperature; estimated_value: number | null }[];

  const byStatus = zeroCounts(LEAD_STATUSES.map((s) => s.value));
  const byTemperature = zeroCounts(LEAD_TEMPERATURES.map((t) => t.value));
  let pipelineValue = 0;

  for (const row of rows) {
    if (row.status in byStatus) byStatus[row.status] += 1;
    if (row.temperature in byTemperature) byTemperature[row.temperature] += 1;
    if (OPEN_LEAD_STATUSES.has(row.status)) pipelineValue += row.estimated_value ?? 0;
  }

  const leads: LeadMetrics = {
    totalLeads: rows.length,
    byStatus,
    newLeads: byStatus.new,
    contactedLeads: byStatus.contacted,
    qualifiedLeads: byStatus.qualified,
    appointmentStageLeads: byStatus.appointment,
    estimateStageLeads: byStatus.estimate,
    wonLeads: byStatus.won,
    lostLeads: byStatus.lost,
    byTemperature,
    hotLeads: byTemperature.hot,
    warmLeads: byTemperature.warm,
    coldLeads: byTemperature.cold,
    openLeads: rows.filter((row) => OPEN_LEAD_STATUSES.has(row.status)).length,
  };

  const pipeline: PipelineMetrics = {
    pipelineValue,
    pipelineStatuses: [...OPEN_LEAD_STATUSES],
  };

  return { leads, pipeline };
}

// ---------------------------------------------------------------------------
// Estimates
// ---------------------------------------------------------------------------

/**
 * Definition: current-state counts by `estimates.status`, plus
 * SUM/AVG(estimates.amount) - a quoted/contracted figure, never revenue (no
 * payment infrastructure exists - see the Phase 5.1 audit). Timestamp used
 * for date-range filtering: created_at. Reliability: directly reliable.
 */
export async function getEstimateMetrics(
  supabase: SupabaseClient,
  organizationId: string,
  range: ResolvedDateRange,
): Promise<EstimateMetrics> {
  let query = supabase
    .from("estimates")
    .select("status, amount")
    .eq("organization_id", organizationId)
    .limit(MAX_ROWS);
  if (range.from) query = query.gte("created_at", range.from);
  if (range.to) query = query.lt("created_at", range.to);

  const { data } = await query;
  const rows = (data ?? []) as { status: EstimateStatus; amount: number | null }[];

  const byStatus = zeroCounts(ESTIMATE_STATUSES.map((s) => s.value));
  for (const row of rows) {
    if (row.status in byStatus) byStatus[row.status] += 1;
  }

  const amounts = rows.map((row) => row.amount).filter((amount): amount is number => amount !== null);
  const sentAmounts = rows.filter((row) => row.status === "sent").map((row) => row.amount ?? 0);
  const acceptedAmounts = rows.filter((row) => row.status === "accepted").map((row) => row.amount ?? 0);

  return {
    totalEstimates: rows.length,
    byStatus,
    draftEstimates: byStatus.draft,
    sentEstimates: byStatus.sent,
    acceptedEstimates: byStatus.accepted,
    declinedEstimates: byStatus.declined,
    cancelledEstimates: byStatus.cancelled,
    expiredEstimates: byStatus.expired,
    totalEstimateValue: sum(amounts),
    sentEstimateValue: sum(sentAmounts),
    acceptedEstimateValue: sum(acceptedAmounts),
    averageEstimateValue: average(amounts),
  };
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/**
 * Definition: current-state counts by `jobs.status`, plus
 * SUM/AVG(jobs.amount) - the contracted job value, never "revenue collected"
 * (no payment infrastructure exists). Timestamp used for date-range
 * filtering: created_at (NOT started_at - the Phase 5.1 audit confirmed
 * `jobs.started_at` is never written by any code path in this repo and is
 * always null in practice). Reliability: directly reliable.
 */
export async function getJobMetrics(
  supabase: SupabaseClient,
  organizationId: string,
  range: ResolvedDateRange,
): Promise<JobMetrics> {
  let query = supabase
    .from("jobs")
    .select("status, amount")
    .eq("organization_id", organizationId)
    .limit(MAX_ROWS);
  if (range.from) query = query.gte("created_at", range.from);
  if (range.to) query = query.lt("created_at", range.to);

  const { data } = await query;
  const rows = (data ?? []) as { status: JobStatus; amount: number | null }[];

  const byStatus = zeroCounts(JOB_STATUSES.map((s) => s.value));
  for (const row of rows) {
    if (row.status in byStatus) byStatus[row.status] += 1;
  }

  const amounts = rows.map((row) => row.amount).filter((amount): amount is number => amount !== null);
  const completedAmounts = rows.filter((row) => row.status === "completed").map((row) => row.amount ?? 0);

  return {
    totalJobs: rows.length,
    byStatus,
    scheduledJobs: byStatus.scheduled,
    inProgressJobs: byStatus.in_progress,
    completedJobs: byStatus.completed,
    cancelledJobs: byStatus.cancelled,
    totalContractedJobValue: sum(amounts),
    completedContractedJobValue: sum(completedAmounts),
    averageContractedJobValue: average(amounts),
  };
}

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------

/**
 * Definition: current-state counts by `appointments.status`. Timestamp used
 * for date-range filtering: created_at (when the appointment record was
 * created - not start_at, which is a scheduling dimension rather than an
 * activity-volume one). Reliability: directly reliable.
 */
export async function getAppointmentMetrics(
  supabase: SupabaseClient,
  organizationId: string,
  range: ResolvedDateRange,
): Promise<AppointmentMetrics> {
  let query = supabase
    .from("appointments")
    .select("status")
    .eq("organization_id", organizationId)
    .limit(MAX_ROWS);
  if (range.from) query = query.gte("created_at", range.from);
  if (range.to) query = query.lt("created_at", range.to);

  const { data } = await query;
  const rows = (data ?? []) as { status: AppointmentStatus }[];

  const byStatus = zeroCounts(APPOINTMENT_STATUSES.map((s) => s.value));
  for (const row of rows) {
    if (row.status in byStatus) byStatus[row.status] += 1;
  }

  return {
    totalAppointments: rows.length,
    byStatus,
    scheduledAppointments: byStatus.scheduled,
    confirmedAppointments: byStatus.confirmed,
    completedAppointments: byStatus.completed,
    cancelledAppointments: byStatus.cancelled,
    noShowAppointments: byStatus.no_show,
  };
}

// ---------------------------------------------------------------------------
// Communication (conversations + messages)
// ---------------------------------------------------------------------------

/**
 * Definition: conversation counts by `conversations.status`/`channel`, and
 * message counts by `messages.direction`/`sender_type`/`status`. Timestamp
 * used for date-range filtering: created_at on each respective table.
 * Reliability: directly reliable - both tables are populated by the
 * production-verified automation pipeline (Phase 4.2-4.9) and the inbound
 * SMS webhook, with CHECK constraints matching the enums used here exactly.
 */
export async function getCommunicationMetrics(
  supabase: SupabaseClient,
  organizationId: string,
  range: ResolvedDateRange,
): Promise<CommunicationMetrics> {
  let conversationsQuery = supabase
    .from("conversations")
    .select("status, channel")
    .eq("organization_id", organizationId)
    .limit(MAX_ROWS);
  if (range.from) conversationsQuery = conversationsQuery.gte("created_at", range.from);
  if (range.to) conversationsQuery = conversationsQuery.lt("created_at", range.to);

  let messagesQuery = supabase
    .from("messages")
    .select("direction, sender_type, status")
    .eq("organization_id", organizationId)
    .limit(MAX_ROWS);
  if (range.from) messagesQuery = messagesQuery.gte("created_at", range.from);
  if (range.to) messagesQuery = messagesQuery.lt("created_at", range.to);

  const [{ data: conversationRows }, { data: messageRows }] = await Promise.all([conversationsQuery, messagesQuery]);

  const conversations = (conversationRows ?? []) as { status: "open" | "closed"; channel: ConversationChannel }[];
  const messages = (messageRows ?? []) as { direction: "inbound" | "outbound"; sender_type: "customer" | "ai" | "user" | "system"; status: MessageStatus }[];

  const byChannel = zeroCounts(CONVERSATION_CHANNELS.map((c) => c.value));
  let openConversations = 0;
  let closedConversations = 0;
  for (const row of conversations) {
    if (row.channel in byChannel) byChannel[row.channel] += 1;
    if (row.status === "open") openConversations += 1;
    else closedConversations += 1;
  }

  const byMessageStatus = zeroCounts(MESSAGE_STATUSES);
  let totalInboundMessages = 0;
  let totalOutboundMessages = 0;
  let aiOutboundMessages = 0;
  let userOutboundMessages = 0;
  let systemOutboundMessages = 0;
  for (const row of messages) {
    if (row.status in byMessageStatus) byMessageStatus[row.status] += 1;
    if (row.direction === "inbound") {
      totalInboundMessages += 1;
    } else {
      totalOutboundMessages += 1;
      if (row.sender_type === "ai") aiOutboundMessages += 1;
      else if (row.sender_type === "user") userOutboundMessages += 1;
      else if (row.sender_type === "system") systemOutboundMessages += 1;
    }
  }

  return {
    totalInboundMessages,
    totalOutboundMessages,
    aiOutboundMessages,
    userOutboundMessages,
    systemOutboundMessages,
    openConversations,
    closedConversations,
    byChannel,
    smsConversations: byChannel.sms,
    webConversations: byChannel.web,
    emailConversations: byChannel.email,
    voiceConversations: byChannel.voice,
    byMessageStatus,
    deliveredMessages: byMessageStatus.delivered,
    failedMessages: byMessageStatus.failed,
    undeliveredMessages: byMessageStatus.undelivered,
    queuedMessages: byMessageStatus.queued,
  };
}

// ---------------------------------------------------------------------------
// Automation + follow-up (one automation_events fetch feeds both)
// ---------------------------------------------------------------------------

/**
 * Definition: automation_events counted by status and by event_type;
 * workflow_executions counted by status and by workflow_name. Timestamp used
 * for date-range filtering: automation_events.created_at,
 * workflow_executions.started_at (workflow_executions has no created_at
 * column). Reliability: directly reliable - these are the same tables the
 * entire Phase 4.2-4.9 automation pipeline itself relies on for idempotency.
 *
 * followUp counts are drawn from the same automation_events fetch used for
 * `automation` above (event_type/entity_type breakdowns), so this table is
 * only read once. These are activity counts only, never a causal or
 * revenue claim - see FollowUpMetrics in lib/bi/types.ts.
 */
export async function getAutomationAndFollowUpMetrics(
  supabase: SupabaseClient,
  organizationId: string,
  range: ResolvedDateRange,
): Promise<{ automation: AutomationMetrics; followUp: FollowUpMetrics }> {
  let eventsQuery = supabase
    .from("automation_events")
    .select("event_type, entity_type, status")
    .eq("organization_id", organizationId)
    .limit(MAX_ROWS);
  if (range.from) eventsQuery = eventsQuery.gte("created_at", range.from);
  if (range.to) eventsQuery = eventsQuery.lt("created_at", range.to);

  let executionsQuery = supabase
    .from("workflow_executions")
    .select("workflow_name, status")
    .eq("organization_id", organizationId)
    .limit(MAX_ROWS);
  if (range.from) executionsQuery = executionsQuery.gte("started_at", range.from);
  if (range.to) executionsQuery = executionsQuery.lt("started_at", range.to);

  const [{ data: eventRows }, { data: executionRows }] = await Promise.all([eventsQuery, executionsQuery]);

  const events = (eventRows ?? []) as { event_type: string; entity_type: string | null; status: (typeof AUTOMATION_EVENT_STATUSES)[number] }[];
  const executions = (executionRows ?? []) as { workflow_name: string; status: (typeof WORKFLOW_EXECUTION_STATUSES)[number] }[];

  const eventStatusCounts = zeroCounts(AUTOMATION_EVENT_STATUSES);
  const automationEventsByType: Record<string, number> = {};
  let leadLostNurtureEvents = 0;
  let leadReactivationEvents = 0;
  let estimateFollowupEvents = 0;
  let postJobFollowupEvents = 0;
  let appointmentAutomationEvents = 0;

  for (const row of events) {
    if (row.status in eventStatusCounts) eventStatusCounts[row.status] += 1;
    automationEventsByType[row.event_type] = (automationEventsByType[row.event_type] ?? 0) + 1;

    if (row.event_type === "lead.lost_nurture") leadLostNurtureEvents += 1;
    else if (row.event_type === "lead.reactivation") leadReactivationEvents += 1;
    else if (row.event_type === "estimate.followup") estimateFollowupEvents += 1;
    else if (row.event_type === "job.post_followup") postJobFollowupEvents += 1;
    if (row.entity_type === "appointment") appointmentAutomationEvents += 1;
  }

  const executionStatusCounts = zeroCounts(WORKFLOW_EXECUTION_STATUSES);
  const workflowExecutionsByName: Record<string, number> = {};
  for (const row of executions) {
    if (row.status in executionStatusCounts) executionStatusCounts[row.status] += 1;
    workflowExecutionsByName[row.workflow_name] = (workflowExecutionsByName[row.workflow_name] ?? 0) + 1;
  }

  const automation: AutomationMetrics = {
    totalAutomationEvents: events.length,
    completedAutomationEvents: eventStatusCounts.completed,
    failedAutomationEvents: eventStatusCounts.failed,
    pendingAutomationEvents: eventStatusCounts.pending,
    processingAutomationEvents: eventStatusCounts.processing,
    automationEventsByType,
    totalWorkflowExecutions: executions.length,
    completedWorkflows: executionStatusCounts.completed,
    failedWorkflows: executionStatusCounts.failed,
    runningWorkflows: executionStatusCounts.running,
    cancelledWorkflows: executionStatusCounts.cancelled,
    workflowExecutionsByName,
  };

  const followUp: FollowUpMetrics = {
    leadLostNurtureEvents,
    leadReactivationEvents,
    estimateFollowupEvents,
    postJobFollowupEvents,
    appointmentAutomationEvents,
  };

  return { automation, followUp };
}

// ---------------------------------------------------------------------------
// AI interactions
// ---------------------------------------------------------------------------

/**
 * Definition: ai_interactions counted by interaction_type and by model.
 * Timestamp used for date-range filtering: created_at. Reliability: directly
 * reliable for counts. Token/cost figures are deliberately NOT computed here
 * - the Phase 5.1 audit confirmed `ai_interactions.tokens_used` is never
 * populated by any code path in this repo (always null in practice), so any
 * derived cost figure would be fabricated, not calculated.
 */
export async function getAiMetrics(
  supabase: SupabaseClient,
  organizationId: string,
  range: ResolvedDateRange,
): Promise<AiMetrics> {
  let query = supabase
    .from("ai_interactions")
    .select("interaction_type, model")
    .eq("organization_id", organizationId)
    .limit(MAX_ROWS);
  if (range.from) query = query.gte("created_at", range.from);
  if (range.to) query = query.lt("created_at", range.to);

  const { data } = await query;
  const rows = (data ?? []) as { interaction_type: string; model: string | null }[];

  const aiInteractionsByType: Record<string, number> = {};
  const aiInteractionsByModel: Record<string, number> = {};

  for (const row of rows) {
    aiInteractionsByType[row.interaction_type] = (aiInteractionsByType[row.interaction_type] ?? 0) + 1;
    const model = row.model ?? "unknown";
    aiInteractionsByModel[model] = (aiInteractionsByModel[model] ?? 0) + 1;
  }

  return {
    totalAiInteractions: rows.length,
    aiInteractionsByType,
    aiInteractionsByModel,
  };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * The single canonical entry point: computes every Phase 5.1 metric group
 * for one organization and one date range in nine parallel, narrow-column
 * queries (one per source table - see the query-strategy note at the top of
 * this file). This is what Phase 5.4 (dashboard) and Phase 5.3 (AI insights)
 * are both expected to call - neither should recompute any of these numbers
 * independently.
 */
export async function getBusinessIntelligenceSnapshot(
  supabase: SupabaseClient,
  organizationId: string,
  dateRangeInput: DateRangeInput = "allTime",
): Promise<BusinessIntelligenceSnapshot> {
  const range = resolveDateRange(dateRangeInput);

  const [{ leads, pipeline }, estimates, jobs, appointments, communication, { automation, followUp }, ai] = await Promise.all([
    getLeadAndPipelineMetrics(supabase, organizationId, range),
    getEstimateMetrics(supabase, organizationId, range),
    getJobMetrics(supabase, organizationId, range),
    getAppointmentMetrics(supabase, organizationId, range),
    getCommunicationMetrics(supabase, organizationId, range),
    getAutomationAndFollowUpMetrics(supabase, organizationId, range),
    getAiMetrics(supabase, organizationId, range),
  ]);

  return {
    organizationId,
    dateRange: range,
    leads,
    pipeline,
    estimates,
    jobs,
    appointments,
    communication,
    automation,
    ai,
    followUp,
    generatedAt: new Date().toISOString(),
  };
}

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resolveDateRange,
  getLeadAndPipelineMetrics,
  getEstimateMetrics,
  getJobMetrics,
  getAppointmentMetrics,
  getCommunicationMetrics,
  getAutomationAndFollowUpMetrics,
  getAiMetrics,
} from "./queries";
import type {
  DateRangeInput,
  ResolvedDateRange,
  PeriodComparison,
  BusinessMetricsComparisons,
  BiLeadMetrics,
  BiPipelineMetrics,
  BiEstimateMetrics,
  BiJobMetrics,
  BiAppointmentMetrics,
  BiCommunicationMetrics,
  BiAutomationMetrics,
  BiAiMetrics,
  BiFollowUpMetrics,
  BiDataQuality,
  BusinessMetricsSnapshot,
} from "./types";

/**
 * Phase 5.2 - Business Intelligence Metrics Layer. This file is purely a
 * TRANSFORMATION on top of Phase 5.1 (lib/bi/queries.ts, frozen - not
 * modified here): it calls Phase 5.1's own query functions for every count/
 * sum it needs and adds rate calculations, period-over-period comparisons,
 * and a small data-quality block. It never re-implements a query Phase 5.1
 * already provides, and it never queries a Phase 5.1-covered table with
 * different filter logic than Phase 5.1 uses - see each function below for
 * exactly which Phase 5.1 function it wraps.
 *
 * A small number of columns Phase 5.1 didn't need are queried directly here
 * (leads.source, contacts.sms_opt_out, ai_interactions.output,
 * automation_events.entity_id) - each is called out explicitly in the
 * function that needs it, and none of them duplicate a Phase 5.1 query;
 * they're genuinely new columns Phase 5.1's narrower selects didn't fetch.
 *
 * Every function here takes an already-resolved `organizationId`, exactly
 * like Phase 5.1 and every other query module in this codebase - callers
 * resolve it via getUserOrganization(supabase, user.id) first (see
 * lib/auth/organization.ts). RLS remains defense-in-depth underneath every
 * query. No new authorization mechanism is introduced.
 */

const MAX_ROWS = 10_000;

// ---------------------------------------------------------------------------
// Rate / comparison helpers
// ---------------------------------------------------------------------------

/** A rate is null whenever its denominator is 0 - never a divide-by-zero, never a fabricated 0%/100%. */
function rate(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return (numerator / denominator) * 100;
}

function safeAverage(total: number, count: number): number | null {
  if (count === 0) return null;
  return total / count;
}

/**
 * The previous period is the same-length window immediately preceding the
 * current one. Returns null when the current range is open-ended (either
 * bound missing - e.g. "all time," or a custom range without both a from
 * and a to) - an unbounded range has no defined "previous period" of the
 * same length.
 */
function previousPeriodOf(range: ResolvedDateRange): ResolvedDateRange | null {
  if (!range.from || !range.to) return null;
  const fromMs = new Date(range.from).getTime();
  const toMs = new Date(range.to).getTime();
  const length = toMs - fromMs;
  return {
    label: `previous period (${range.label})`,
    from: new Date(fromMs - length).toISOString(),
    to: new Date(fromMs).toISOString(),
  };
}

function computeComparison(current: number, previous: number | null): PeriodComparison {
  if (previous === null) {
    return { current, previous: null, change: null, percentageChange: null };
  }
  const change = current - previous;
  const percentageChange = previous === 0 ? null : (change / previous) * 100;
  return { current, previous, change, percentageChange };
}

// ---------------------------------------------------------------------------
// New narrow queries Phase 5.1 didn't need (leads.source, contacts.sms_opt_out,
// ai_interactions.output, automation_events.entity_id) - each documented
// individually. None of these duplicate a Phase 5.1 query.
// ---------------------------------------------------------------------------

async function getSourceCounts(supabase: SupabaseClient, organizationId: string, range: ResolvedDateRange): Promise<Record<string, number>> {
  let query = supabase.from("leads").select("source").eq("organization_id", organizationId).limit(MAX_ROWS);
  if (range.from) query = query.gte("created_at", range.from);
  if (range.to) query = query.lt("created_at", range.to);

  const { data } = await query;
  const rows = (data ?? []) as { source: string | null }[];

  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = row.source?.trim() || "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * contacts has no opt-out-event timestamp column, so this is scoped by
 * contacts.created_at - see BiCommunicationMetrics.optOutCount in
 * lib/bi/types.ts for the exact caveat this implies.
 */
async function getOptOutCount(supabase: SupabaseClient, organizationId: string, range: ResolvedDateRange): Promise<number> {
  let query = supabase.from("contacts").select("sms_opt_out").eq("organization_id", organizationId).limit(MAX_ROWS);
  if (range.from) query = query.gte("created_at", range.from);
  if (range.to) query = query.lt("created_at", range.to);

  const { data } = await query;
  const rows = (data ?? []) as { sms_opt_out: boolean }[];
  return rows.filter((row) => row.sms_opt_out).length;
}

type AiOutputFields = { aiOutboundInteractions: number; customerReplyAiInteractions: number; aiNeedsHumanCount: number };

async function getAiOutputFields(supabase: SupabaseClient, organizationId: string, range: ResolvedDateRange): Promise<AiOutputFields> {
  let query = supabase.from("ai_interactions").select("interaction_type, output").eq("organization_id", organizationId).limit(MAX_ROWS);
  if (range.from) query = query.gte("created_at", range.from);
  if (range.to) query = query.lt("created_at", range.to);

  const { data } = await query;
  const rows = (data ?? []) as { interaction_type: string; output: Record<string, unknown> | null }[];

  let aiOutboundInteractions = 0;
  let customerReplyAiInteractions = 0;
  let aiNeedsHumanCount = 0;

  for (const row of rows) {
    if (row.output?.should_send === true) aiOutboundInteractions += 1;
    if (row.output?.needs_human === true) aiNeedsHumanCount += 1;
    if (row.interaction_type === "customer_reply_response") customerReplyAiInteractions += 1;
  }

  return { aiOutboundInteractions, customerReplyAiInteractions, aiNeedsHumanCount };
}

/**
 * A real SQL COUNT (no rows transferred) of rows with a non-null `amount` -
 * needed because Phase 5.1's average() collapses both "no rows at all" and
 * "rows exist but none have an amount" into the same 0, which would make an
 * average of 0 indistinguishable from "no data" if totalEstimates/totalJobs
 * alone were used to decide when to return null.
 */
async function getNonNullAmountCount(supabase: SupabaseClient, table: "estimates" | "jobs", organizationId: string, range: ResolvedDateRange): Promise<number> {
  let query = supabase.from(table).select("id", { count: "exact", head: true }).eq("organization_id", organizationId).not("amount", "is", null);
  if (range.from) query = query.gte("created_at", range.from);
  if (range.to) query = query.lt("created_at", range.to);

  const { count } = await query;
  return count ?? 0;
}

/**
 * Distinct leads directly targeted by a lead-entity automation event
 * (entity_type = 'lead') - see BiFollowUpMetrics.leadsTouchedByAutomation in
 * lib/bi/types.ts for why this is deliberately conservative.
 */
async function getLeadsTouchedByAutomation(supabase: SupabaseClient, organizationId: string, range: ResolvedDateRange): Promise<number> {
  let query = supabase
    .from("automation_events")
    .select("entity_id")
    .eq("organization_id", organizationId)
    .eq("entity_type", "lead")
    .limit(MAX_ROWS);
  if (range.from) query = query.gte("created_at", range.from);
  if (range.to) query = query.lt("created_at", range.to);

  const { data } = await query;
  const rows = (data ?? []) as { entity_id: string | null }[];
  return new Set(rows.map((row) => row.entity_id).filter((id): id is string => id !== null)).size;
}

// ---------------------------------------------------------------------------
// Metric group builders - each wraps exactly one Phase 5.1 query function
// (plus, where noted, one of the small new queries above) and adds rates.
// ---------------------------------------------------------------------------

async function buildLeadMetrics(supabase: SupabaseClient, organizationId: string, range: ResolvedDateRange): Promise<{ lead: BiLeadMetrics; pipeline: BiPipelineMetrics }> {
  const [{ leads, pipeline }, sourceCounts] = await Promise.all([
    getLeadAndPipelineMetrics(supabase, organizationId, range),
    getSourceCounts(supabase, organizationId, range),
  ]);

  const lead: BiLeadMetrics = {
    totalLeads: leads.totalLeads,
    newLeads: leads.newLeads,
    contactedLeads: leads.contactedLeads,
    qualifiedLeads: leads.qualifiedLeads,
    appointmentStageLeads: leads.appointmentStageLeads,
    estimateStageLeads: leads.estimateStageLeads,
    wonLeads: leads.wonLeads,
    lostLeads: leads.lostLeads,
    hotLeads: leads.hotLeads,
    warmLeads: leads.warmLeads,
    coldLeads: leads.coldLeads,
    lostRate: rate(leads.lostLeads, leads.wonLeads + leads.lostLeads),
    sourceCounts,
  };

  const biPipeline: BiPipelineMetrics = {
    openOpportunityCount: leads.openLeads,
    pipelineValue: pipeline.pipelineValue,
    averagePipelineValue: safeAverage(pipeline.pipelineValue, leads.openLeads),
  };

  return { lead, pipeline: biPipeline };
}

async function buildEstimateMetrics(supabase: SupabaseClient, organizationId: string, range: ResolvedDateRange): Promise<BiEstimateMetrics> {
  const [estimates, amountCount] = await Promise.all([
    getEstimateMetrics(supabase, organizationId, range),
    getNonNullAmountCount(supabase, "estimates", organizationId, range),
  ]);
  return {
    totalEstimates: estimates.totalEstimates,
    draftEstimates: estimates.draftEstimates,
    sentEstimates: estimates.sentEstimates,
    acceptedEstimates: estimates.acceptedEstimates,
    declinedEstimates: estimates.declinedEstimates,
    cancelledEstimates: estimates.cancelledEstimates,
    expiredEstimates: estimates.expiredEstimates,
    estimateValue: estimates.totalEstimateValue,
    averageEstimateValue: amountCount === 0 ? null : estimates.averageEstimateValue,
    estimateAcceptanceRate: rate(estimates.acceptedEstimates, estimates.acceptedEstimates + estimates.declinedEstimates),
    estimateToJobRate: null, // filled in by the caller once job metrics are available
  };
}

async function buildJobMetrics(supabase: SupabaseClient, organizationId: string, range: ResolvedDateRange): Promise<BiJobMetrics> {
  const [jobs, amountCount] = await Promise.all([
    getJobMetrics(supabase, organizationId, range),
    getNonNullAmountCount(supabase, "jobs", organizationId, range),
  ]);
  return {
    totalJobs: jobs.totalJobs,
    scheduledJobs: jobs.scheduledJobs,
    inProgressJobs: jobs.inProgressJobs,
    completedJobs: jobs.completedJobs,
    cancelledJobs: jobs.cancelledJobs,
    contractedJobValue: jobs.totalContractedJobValue,
    averageContractedJobValue: amountCount === 0 ? null : jobs.averageContractedJobValue,
    jobCompletionRate: rate(jobs.completedJobs, jobs.completedJobs + jobs.cancelledJobs),
  };
}

async function buildAppointmentMetrics(supabase: SupabaseClient, organizationId: string, range: ResolvedDateRange): Promise<BiAppointmentMetrics> {
  const appointments = await getAppointmentMetrics(supabase, organizationId, range);
  const resolved = appointments.completedAppointments + appointments.cancelledAppointments + appointments.noShowAppointments;
  return {
    totalAppointments: appointments.totalAppointments,
    scheduledAppointments: appointments.scheduledAppointments,
    confirmedAppointments: appointments.confirmedAppointments,
    completedAppointments: appointments.completedAppointments,
    cancelledAppointments: appointments.cancelledAppointments,
    noShowAppointments: appointments.noShowAppointments,
    appointmentNoShowRate: rate(appointments.noShowAppointments, resolved),
  };
}

async function buildCommunicationMetrics(supabase: SupabaseClient, organizationId: string, range: ResolvedDateRange): Promise<BiCommunicationMetrics> {
  const [communication, optOutCount] = await Promise.all([
    getCommunicationMetrics(supabase, organizationId, range),
    getOptOutCount(supabase, organizationId, range),
  ]);

  return {
    inboundMessages: communication.totalInboundMessages,
    outboundMessages: communication.totalOutboundMessages,
    customerReplies: communication.totalInboundMessages,
    aiOutboundMessages: communication.aiOutboundMessages,
    userOutboundMessages: communication.userOutboundMessages,
    systemOutboundMessages: communication.systemOutboundMessages,
    conversationsOpened: communication.openConversations,
    conversationsClosed: communication.closedConversations,
    optOutCount,
  };
}

async function buildAutomationMetrics(supabase: SupabaseClient, organizationId: string, range: ResolvedDateRange): Promise<{ automation: BiAutomationMetrics; followUp: BiFollowUpMetrics }> {
  const [{ automation, followUp }, leadsTouchedByAutomation] = await Promise.all([
    getAutomationAndFollowUpMetrics(supabase, organizationId, range),
    getLeadsTouchedByAutomation(supabase, organizationId, range),
  ]);

  const biAutomation: BiAutomationMetrics = {
    automationEvents: automation.totalAutomationEvents,
    completedAutomationEvents: automation.completedAutomationEvents,
    failedAutomationEvents: automation.failedAutomationEvents,
    pendingAutomationEvents: automation.pendingAutomationEvents,
    workflowExecutions: automation.totalWorkflowExecutions,
    successfulWorkflowExecutions: automation.completedWorkflows,
    failedWorkflowExecutions: automation.failedWorkflows,
    runningWorkflowExecutions: automation.runningWorkflows,
    automationSuccessRate: rate(automation.completedWorkflows, automation.completedWorkflows + automation.failedWorkflows),
  };

  const biFollowUp: BiFollowUpMetrics = {
    lostLeadNurtureEvents: followUp.leadLostNurtureEvents,
    reactivationEvents: followUp.leadReactivationEvents,
    appointmentReminderEvents: automation.automationEventsByType["appointment.reminder"] ?? 0,
    estimateFollowUpEvents: followUp.estimateFollowupEvents,
    postJobFollowUpEvents: followUp.postJobFollowupEvents,
    leadsTouchedByAutomation,
  };

  return { automation: biAutomation, followUp: biFollowUp };
}

async function buildAiMetrics(supabase: SupabaseClient, organizationId: string, range: ResolvedDateRange): Promise<BiAiMetrics> {
  const [ai, outputFields] = await Promise.all([
    getAiMetrics(supabase, organizationId, range),
    getAiOutputFields(supabase, organizationId, range),
  ]);

  return {
    aiInteractions: ai.totalAiInteractions,
    aiOutboundInteractions: outputFields.aiOutboundInteractions,
    customerReplyAiInteractions: outputFields.customerReplyAiInteractions,
    aiNeedsHumanCount: outputFields.aiNeedsHumanCount,
  };
}

function buildDataQuality(): BiDataQuality {
  return {
    collectedRevenueUnavailable: true,
    sourceAttributionLimited: true,
    stageHistoryUnavailable: true,
    aiTokenUsageUnavailable: true,
    notes: [
      "No payment/invoicing infrastructure exists - pipelineValue, estimateValue, and contractedJobValue are quoted/contracted figures, never collected revenue.",
      "leads.source is nullable and not standardized - sourceCounts is exposed for transparency only, never as a performance ranking.",
      "No lead stage-transition history exists - all counts/rates here are current-state or activity counts, not true historical conversion rates.",
      "ai_interactions.tokens_used is never populated in this codebase - no AI cost figure is calculated anywhere in this layer.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * The Phase 5.2 canonical entry point. Computes the current period's full
 * metrics set (each group built from Phase 5.1's own query functions - see
 * the builders above), and, only when the resolved range has both bounds
 * (i.e. is not open-ended), also computes the equivalent previous period's
 * lead/estimate/job counts for the `comparisons` block. An open-ended range
 * (e.g. "all time") yields `previous: null` throughout `comparisons`, per
 * the "do not fabricate comparison periods" requirement.
 */
export async function getBusinessMetricsSnapshot(
  supabase: SupabaseClient,
  organizationId: string,
  dateRangeInput: DateRangeInput = "allTime",
): Promise<BusinessMetricsSnapshot> {
  const range = resolveDateRange(dateRangeInput);
  const previousRange = previousPeriodOf(range);

  const [{ lead, pipeline }, estimateMetrics, jobMetrics, appointmentMetrics, communicationMetrics, { automation, followUp }, aiMetrics, previousTotals] =
    await Promise.all([
      buildLeadMetrics(supabase, organizationId, range),
      buildEstimateMetrics(supabase, organizationId, range),
      buildJobMetrics(supabase, organizationId, range),
      buildAppointmentMetrics(supabase, organizationId, range),
      buildCommunicationMetrics(supabase, organizationId, range),
      buildAutomationMetrics(supabase, organizationId, range),
      buildAiMetrics(supabase, organizationId, range),
      previousRange
        ? Promise.all([
            getLeadAndPipelineMetrics(supabase, organizationId, previousRange),
            getEstimateMetrics(supabase, organizationId, previousRange),
            getJobMetrics(supabase, organizationId, previousRange),
          ])
        : Promise.resolve(null),
    ]);

  estimateMetrics.estimateToJobRate = rate(jobMetrics.totalJobs, estimateMetrics.acceptedEstimates);

  const comparisons: BusinessMetricsComparisons = previousTotals
    ? {
        leadCount: computeComparison(lead.totalLeads, previousTotals[0].leads.totalLeads),
        estimateCount: computeComparison(estimateMetrics.totalEstimates, previousTotals[1].totalEstimates),
        jobCount: computeComparison(jobMetrics.totalJobs, previousTotals[2].totalJobs),
      }
    : {
        leadCount: computeComparison(lead.totalLeads, null),
        estimateCount: computeComparison(estimateMetrics.totalEstimates, null),
        jobCount: computeComparison(jobMetrics.totalJobs, null),
      };

  return {
    organizationId,
    period: range,
    comparisons,
    leadMetrics: lead,
    pipelineMetrics: pipeline,
    estimateMetrics,
    jobMetrics,
    appointmentMetrics,
    communicationMetrics,
    automationMetrics: automation,
    aiMetrics,
    followUpMetrics: followUp,
    dataQuality: buildDataQuality(),
    generatedAt: new Date().toISOString(),
  };
}

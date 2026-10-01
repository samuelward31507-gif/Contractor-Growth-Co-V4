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
  getReviewReferralMetrics,
} from "./queries";
import { hasAnyLeadStageHistoryResult, getLeadsForRangeResult, getLeadStageTransitionMetrics, getLeadStageTimingMetrics, getLeadResponseTimeMetrics } from "./funnel";
import { computeBillingMetrics, computeInvoiceAging, getBillingRowsResult, SANCTIONED_COLLECTED_REVENUE_DEFINITION, type BiBillingMetrics } from "./billing";
import { calendarDateInTimeZone } from "@/lib/invoices/domain";
import { calendarDaysBetween, previousOrganizationRange, safeTimeZone } from "./date-range";
import { getOrganizationTimezone } from "@/lib/settings/queries";
import type {
  DateRangeInput,
  ResolvedDateRange,
  PeriodComparison,
  UnavailableComparison,
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
  BiRevenueOpportunity,
  BiEstimateAging,
  BiDataQuality,
  BusinessMetricsSnapshot,
  LeadStageTimingMetrics,
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

/** Phase 2F: the comparison for a figure whose current or previous period could not be read - all null, never a number. */
const UNAVAILABLE_COMPARISON: UnavailableComparison = { unavailable: true, current: null, previous: null, change: null, percentageChange: null };

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

type AiOutputFields = { aiOutboundInteractions: number; customerReplyAiInteractions: number; aiNeedsHumanCount: number; failed: boolean };

/** Trackpr 2.0, Phase 4B (P1 #2): `failed` feeds buildAiMetrics's own combined failure signal - see getLeadAndPipelineMetrics's own comment in lib/bi/queries.ts for the full discipline this mirrors. */
async function getAiOutputFields(supabase: SupabaseClient, organizationId: string, range: ResolvedDateRange): Promise<AiOutputFields> {
  let query = supabase.from("ai_interactions").select("interaction_type, output").eq("organization_id", organizationId).limit(MAX_ROWS);
  if (range.from) query = query.gte("created_at", range.from);
  if (range.to) query = query.lt("created_at", range.to);

  const { data, error } = await query;
  const rows = (data ?? []) as { interaction_type: string; output: Record<string, unknown> | null }[];

  let aiOutboundInteractions = 0;
  let customerReplyAiInteractions = 0;
  let aiNeedsHumanCount = 0;

  for (const row of rows) {
    if (row.output?.should_send === true) aiOutboundInteractions += 1;
    if (row.output?.needs_human === true) aiNeedsHumanCount += 1;
    if (row.interaction_type === "customer_reply_response") customerReplyAiInteractions += 1;
  }

  return { aiOutboundInteractions, customerReplyAiInteractions, aiNeedsHumanCount, failed: error != null };
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

/**
 * Growth System Completion Pass 2, Part 2: leads (created within `range`)
 * cross-referenced against real appointments by `appointments.lead_id` -
 * "did this lead ever get booked", regardless of the appointment's own date
 * or status. Also returns the subset with status = 'qualified' and no
 * appointment, reused directly by buildRevenueOpportunity (Part 3) below so
 * leads/appointments are each fetched only once for both metrics.
 */
async function getLeadBookingCrossReference(
  supabase: SupabaseClient,
  organizationId: string,
  range: ResolvedDateRange,
): Promise<{ leadsInRange: number; leadsWithAppointment: number; qualifiedLeadsWithoutAppointment: number }> {
  let leadQuery = supabase.from("leads").select("id, status").eq("organization_id", organizationId).limit(MAX_ROWS);
  if (range.from) leadQuery = leadQuery.gte("created_at", range.from);
  if (range.to) leadQuery = leadQuery.lt("created_at", range.to);

  const { data: leadRows } = await leadQuery;
  const leads = (leadRows ?? []) as { id: string; status: string }[];
  if (leads.length === 0) return { leadsInRange: 0, leadsWithAppointment: 0, qualifiedLeadsWithoutAppointment: 0 };

  const leadIds = new Set(leads.map((row) => row.id));

  const { data: appointmentRows } = await supabase
    .from("appointments")
    .select("lead_id")
    .eq("organization_id", organizationId)
    .not("lead_id", "is", null)
    .limit(MAX_ROWS);
  const bookedLeadIds = new Set(
    ((appointmentRows ?? []) as { lead_id: string | null }[]).map((row) => row.lead_id).filter((id): id is string => id !== null && leadIds.has(id)),
  );

  const qualifiedLeadsWithoutAppointment = leads.filter((row) => row.status === "qualified" && !bookedLeadIds.has(row.id)).length;

  return { leadsInRange: leads.length, leadsWithAppointment: bookedLeadIds.size, qualifiedLeadsWithoutAppointment };
}

/** Growth System Completion Pass 2, Part 3: SUM(estimates.amount) grouped by status = 'sent' (openEstimateValue), 'expired', and 'declined' - one query for all three "opportunity" value fields. */
type SentEstimateRow = { amount: number | null; sent_at: string | null; expires_at: string | null };

async function getEstimateOpportunityValues(
  supabase: SupabaseClient,
  organizationId: string,
  range: ResolvedDateRange,
): Promise<{ openEstimateValue: number; expiredEstimateValue: number; lostEstimateValue: number; sentRows: SentEstimateRow[] }> {
  let query = supabase.from("estimates").select("status, amount, sent_at, expires_at").eq("organization_id", organizationId).in("status", ["sent", "expired", "declined"]).limit(MAX_ROWS);
  if (range.from) query = query.gte("created_at", range.from);
  if (range.to) query = query.lt("created_at", range.to);

  const { data } = await query;
  const rows = (data ?? []) as ({ status: "sent" | "expired" | "declined" } & SentEstimateRow)[];

  let openEstimateValue = 0;
  let expiredEstimateValue = 0;
  let lostEstimateValue = 0;
  for (const row of rows) {
    if (row.status === "sent") openEstimateValue += row.amount ?? 0;
    else if (row.status === "expired") expiredEstimateValue += row.amount ?? 0;
    else lostEstimateValue += row.amount ?? 0;
  }
  return { openEstimateValue, expiredEstimateValue, lostEstimateValue, sentRows: rows.filter((row) => row.status === "sent") };
}

/**
 * Phase 2A (Analytics): estimates still awaiting a decision (status sent), by
 * whole calendar days since sent_at in the organization's timezone - 0-7,
 * 8-30, 31+ - with value, plus a "no send date" bucket for any without one
 * (never guessed into an age), and how many are already past expires_at.
 * Pure - unit-tested in metrics.rates.test.ts.
 */
export function computeEstimateAging(sentRows: SentEstimateRow[], now: Date, timeZone: string): BiEstimateAging {
  const zone = safeTimeZone(timeZone);
  const today = calendarDateInTimeZone(now, zone);
  const buckets: { key: string; label: string; values: number[] }[] = [
    { key: "0-7", label: "0-7 days", values: [] },
    { key: "8-30", label: "8-30 days", values: [] },
    { key: "31+", label: "31+ days", values: [] },
    { key: "undated", label: "No send date", values: [] },
  ];
  let pastExpiryCount = 0;
  let pastExpiryValue = 0;
  for (const row of sentRows) {
    const amount = row.amount ?? 0;
    if (!row.sent_at) buckets[3].values.push(amount);
    else {
      const age = calendarDaysBetween(calendarDateInTimeZone(new Date(row.sent_at), zone), today);
      buckets[age <= 7 ? 0 : age <= 30 ? 1 : 2].values.push(amount);
    }
    if (row.expires_at && new Date(row.expires_at).getTime() < now.getTime()) {
      pastExpiryCount += 1;
      pastExpiryValue += amount;
    }
  }
  return {
    buckets: buckets.map((bucket) => ({ key: bucket.key, label: bucket.label, count: bucket.values.length, value: bucket.values.reduce((sum, value) => sum + value, 0) })),
    pastExpiryCount,
    pastExpiryValue,
  };
}

/** Growth System Completion Pass 2, Part 3: completed appointments (in `range`) whose lead has no estimate at all - a real visit that never turned into a quote. Estimate existence is checked without its own date bound - the question is "does one exist at all," not "was one created in the same window." */
async function getCompletedAppointmentsWithoutEstimate(supabase: SupabaseClient, organizationId: string, range: ResolvedDateRange): Promise<number> {
  let appointmentQuery = supabase
    .from("appointments")
    .select("lead_id")
    .eq("organization_id", organizationId)
    .eq("status", "completed")
    .not("lead_id", "is", null)
    .limit(MAX_ROWS);
  if (range.from) appointmentQuery = appointmentQuery.gte("created_at", range.from);
  if (range.to) appointmentQuery = appointmentQuery.lt("created_at", range.to);

  const { data: appointmentRows } = await appointmentQuery;
  const leadIds = new Set(((appointmentRows ?? []) as { lead_id: string | null }[]).map((row) => row.lead_id).filter((id): id is string => id !== null));
  if (leadIds.size === 0) return 0;

  const { data: estimateRows } = await supabase.from("estimates").select("lead_id").eq("organization_id", organizationId).in("lead_id", [...leadIds]).limit(MAX_ROWS);
  const leadsWithEstimate = new Set(((estimateRows ?? []) as { lead_id: string | null }[]).map((row) => row.lead_id));

  return [...leadIds].filter((id) => !leadsWithEstimate.has(id)).length;
}

/**
 * Growth System Completion Pass 2, Part 3 (revised in Pass 3 - Revenue
 * Intelligence Foundation): "Revenue Opportunity" - see
 * BiRevenueOpportunity's own documentation in lib/bi/types.ts for the exact,
 * deliberately factual meaning of each field.
 *
 * Pass 3 fix: this used to be scoped to the caller's requested `range` (the
 * dashboard's main render passes "today", the AI Insights action passes
 * "last30Days"), which made it read as almost always near-empty - a
 * qualified lead that went unbooked last month, or an estimate that was
 * sent weeks ago and is still open today, is still a real outstanding
 * opportunity regardless of when it was created. Per lib/bi/types.ts's own
 * already-declared MetricTemporality distinction, this is a "current_state"
 * question, not a "date_range" one, so it is now always computed against an
 * unbounded ("allTime") range internally, completely independent of
 * whatever range the caller passed to getBusinessMetricsSnapshot - which is
 * why, unlike every other builder in this file, it takes no `range`
 * parameter and fetches its own leads/appointments cross-reference rather
 * than reusing buildLeadMetrics's range-scoped one.
 */
async function buildRevenueOpportunity(supabase: SupabaseClient, organizationId: string, now: Date, timeZone: string): Promise<{ opportunity: BiRevenueOpportunity; estimateAging: BiEstimateAging }> {
  const unboundedRange = resolveDateRange("allTime");

  const [{ openEstimateValue, expiredEstimateValue, lostEstimateValue, sentRows }, completedAppointmentsWithoutEstimate, bookingCrossReference] = await Promise.all([
    getEstimateOpportunityValues(supabase, organizationId, unboundedRange),
    getCompletedAppointmentsWithoutEstimate(supabase, organizationId, unboundedRange),
    getLeadBookingCrossReference(supabase, organizationId, unboundedRange),
  ]);

  return {
    opportunity: {
      openEstimateValue,
      expiredEstimateValue,
      lostEstimateValue,
      recoverableEstimateValue: openEstimateValue + expiredEstimateValue,
      qualifiedLeadsWithoutAppointment: bookingCrossReference.qualifiedLeadsWithoutAppointment,
      completedAppointmentsWithoutEstimate,
    },
    estimateAging: computeEstimateAging(sentRows, now, timeZone),
  };
}

// ---------------------------------------------------------------------------
// Metric group builders - each wraps exactly one Phase 5.1 query function
// (plus, where noted, one of the small new queries above) and adds rates.
// ---------------------------------------------------------------------------

async function buildLeadMetrics(
  supabase: SupabaseClient,
  organizationId: string,
  range: ResolvedDateRange,
): Promise<{ lead: BiLeadMetrics; pipeline: BiPipelineMetrics; failed: boolean }> {
  const [{ leads, pipeline, failed }, sourceCounts, bookingCrossReference] = await Promise.all([
    getLeadAndPipelineMetrics(supabase, organizationId, range),
    getSourceCounts(supabase, organizationId, range),
    getLeadBookingCrossReference(supabase, organizationId, range),
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
    leadToBookingRate: rate(bookingCrossReference.leadsWithAppointment, bookingCrossReference.leadsInRange),
  };

  const biPipeline: BiPipelineMetrics = {
    openOpportunityCount: leads.openLeads,
    pipelineValue: pipeline.pipelineValue,
    averagePipelineValue: safeAverage(pipeline.pipelineValue, leads.openLeads),
  };

  return { lead, pipeline: biPipeline, failed };
}

/** Trackpr 2.0, Phase 4B (P1 #2): `failed` propagates getEstimateMetrics's own error signal up to getBusinessMetricsSnapshot's partialData - see lib/bi/queries.ts's getLeadAndPipelineMetrics for the full discipline. getNonNullAmountCount's own error handling is a narrower, already-safe-direction case (a failure there can only ever force a real average into "not enough data yet," never fabricate one) and is left as-is, matching this phase's scope. */
/** An accepted estimate with whatever job is linked to it through jobs.estimate_id (PostgREST returns the embed as an array, or an object for a detected one-to-one). */
export type AcceptedEstimateJobRow = { id: string; jobs: { id: string }[] | { id: string } | null };

/**
 * Estimate → job: of the estimates accepted in the period, the share that
 * became a job - the numerator counts only accepted estimates with a linked
 * job (jobs.estimate_id), never all jobs, so a job created directly (no
 * estimate) can't inflate it. jobs_estimate_id_unique allows at most one job
 * per estimate, so the numerator can't exceed the denominator; it is still
 * capped at it in case the two reads saw a row change in between. `null`
 * when nothing was accepted.
 */
export function estimateToJobRate(acceptedRows: AcceptedEstimateJobRow[], acceptedEstimates: number): number | null {
  const withJob = acceptedRows.filter((row) => (Array.isArray(row.jobs) ? row.jobs.length > 0 : row.jobs != null)).length;
  return rate(Math.min(withJob, acceptedEstimates), acceptedEstimates);
}

/**
 * The accepted estimates created in `range` (the same filters
 * getEstimateMetrics counts acceptedEstimates with), each with its linked
 * job. The embed names its foreign key because invoices (job_id +
 * estimate_id) is a second path between the two tables.
 */
async function getAcceptedEstimateJobRows(supabase: SupabaseClient, organizationId: string, range: ResolvedDateRange): Promise<{ rows: AcceptedEstimateJobRow[]; failed: boolean }> {
  let query = supabase.from("estimates").select("id, jobs!jobs_estimate_id_fkey(id)").eq("organization_id", organizationId).eq("status", "accepted").limit(MAX_ROWS);
  if (range.from) query = query.gte("created_at", range.from);
  if (range.to) query = query.lt("created_at", range.to);
  const { data, error } = await query;
  return { rows: (data ?? []) as AcceptedEstimateJobRow[], failed: error != null };
}

async function buildEstimateMetrics(supabase: SupabaseClient, organizationId: string, range: ResolvedDateRange): Promise<{ metrics: BiEstimateMetrics; failed: boolean }> {
  const [estimates, amountCount, acceptedJobRows] = await Promise.all([
    getEstimateMetrics(supabase, organizationId, range),
    getNonNullAmountCount(supabase, "estimates", organizationId, range),
    getAcceptedEstimateJobRows(supabase, organizationId, range),
  ]);
  return {
    metrics: {
      totalEstimates: estimates.totalEstimates,
      draftEstimates: estimates.draftEstimates,
      sentEstimates: estimates.sentEstimates,
      acceptedEstimates: estimates.acceptedEstimates,
      declinedEstimates: estimates.declinedEstimates,
      cancelledEstimates: estimates.cancelledEstimates,
      expiredEstimates: estimates.expiredEstimates,
      estimateValue: estimates.totalEstimateValue,
      acceptedEstimateValue: estimates.acceptedEstimateValue,
      averageEstimateValue: amountCount === 0 ? null : estimates.averageEstimateValue,
      estimateAcceptanceRate: rate(estimates.acceptedEstimates, estimates.acceptedEstimates + estimates.declinedEstimates),
      estimateToJobRate: estimateToJobRate(acceptedJobRows.rows, estimates.acceptedEstimates),
    },
    failed: estimates.failed || acceptedJobRows.failed,
  };
}

/** Trackpr 2.0, Phase 4B (P1 #2): `failed` propagates getJobMetrics's own error signal - see buildEstimateMetrics's own comment above for the identical discipline and the same getNonNullAmountCount scope note. */
async function buildJobMetrics(supabase: SupabaseClient, organizationId: string, range: ResolvedDateRange): Promise<{ metrics: BiJobMetrics; failed: boolean }> {
  const [jobs, amountCount] = await Promise.all([
    getJobMetrics(supabase, organizationId, range),
    getNonNullAmountCount(supabase, "jobs", organizationId, range),
  ]);
  return {
    metrics: {
      totalJobs: jobs.totalJobs,
      scheduledJobs: jobs.scheduledJobs,
      inProgressJobs: jobs.inProgressJobs,
      completedJobs: jobs.completedJobs,
      cancelledJobs: jobs.cancelledJobs,
      contractedJobValue: jobs.totalContractedJobValue,
      completedContractedJobValue: jobs.completedContractedJobValue,
      averageContractedJobValue: amountCount === 0 ? null : jobs.averageContractedJobValue,
      jobCompletionRate: rate(jobs.completedJobs, jobs.completedJobs + jobs.cancelledJobs),
    },
    failed: jobs.failed,
  };
}

/** Trackpr 2.0, Phase 4B (P1 #2): `failed` propagates getAppointmentMetrics's own error signal - see buildEstimateMetrics's own comment above for the identical discipline. */
async function buildAppointmentMetrics(supabase: SupabaseClient, organizationId: string, range: ResolvedDateRange): Promise<{ metrics: BiAppointmentMetrics; failed: boolean }> {
  const appointments = await getAppointmentMetrics(supabase, organizationId, range);
  const resolved = appointments.completedAppointments + appointments.cancelledAppointments + appointments.noShowAppointments;
  return {
    metrics: {
      totalAppointments: appointments.totalAppointments,
      scheduledAppointments: appointments.scheduledAppointments,
      confirmedAppointments: appointments.confirmedAppointments,
      completedAppointments: appointments.completedAppointments,
      cancelledAppointments: appointments.cancelledAppointments,
      noShowAppointments: appointments.noShowAppointments,
      appointmentNoShowRate: rate(appointments.noShowAppointments, resolved),
    },
    failed: appointments.failed,
  };
}

/** Pure: status counts and no-show rate for a set of appointments - the same definitions buildAppointmentMetrics uses. */
export function summarizeAppointmentStatuses(rows: { status: string }[]): BiAppointmentMetrics {
  const count = (status: string) => rows.filter((row) => row.status === status).length;
  const completedAppointments = count("completed");
  const cancelledAppointments = count("cancelled");
  const noShowAppointments = count("no_show");
  return {
    totalAppointments: rows.length,
    scheduledAppointments: count("scheduled"),
    confirmedAppointments: count("confirmed"),
    completedAppointments,
    cancelledAppointments,
    noShowAppointments,
    appointmentNoShowRate: rate(noShowAppointments, completedAppointments + cancelledAppointments + noShowAppointments),
  };
}

/**
 * Phase 2A (Analytics only): appointments by when they take place - start_at
 * in [range.from, range.to) - rather than when they were booked. An
 * appointment booked last month for this week counts this week; one booked
 * this week for next month does not. The snapshot's appointmentMetrics
 * (created_at) is unchanged: Agency and the AI observations read it.
 */
export async function getAppointmentOccurrenceMetrics(supabase: SupabaseClient, organizationId: string, range: ResolvedDateRange): Promise<{ metrics: BiAppointmentMetrics; failed: boolean }> {
  let query = supabase.from("appointments").select("status").eq("organization_id", organizationId).limit(MAX_ROWS);
  if (range.from) query = query.gte("start_at", range.from);
  if (range.to) query = query.lt("start_at", range.to);
  const { data, error } = await query;
  return { metrics: summarizeAppointmentStatuses((data ?? []) as { status: string }[]), failed: error != null };
}

export type OpportunityOutcomeGroup = { key: "lost" | "no_longer_applies" | "dismissed" | "other"; label: string; count: number; value: number };

/**
 * Pure: closed opportunities by how they closed. "Marked lost" is the
 * resolver's `lost` reason (the lead was lost); "No longer applies" is
 * `condition_no_longer_true` - the condition simply stopped holding, which is
 * NOT evidence the work or money was recovered; "Dismissed" is the owner's
 * own call; "Other" is anything recorded without a reason (legacy rows).
 * Value is the opportunity's own estimated_value, a quoted/estimated figure.
 */
export function groupOpportunityOutcomes(rows: { status: string; resolution_reason: string | null; estimated_value: number | null }[]): OpportunityOutcomeGroup[] {
  const groups: OpportunityOutcomeGroup[] = [
    { key: "lost", label: "Marked lost", count: 0, value: 0 },
    { key: "no_longer_applies", label: "No longer applies", count: 0, value: 0 },
    { key: "dismissed", label: "Dismissed", count: 0, value: 0 },
    { key: "other", label: "Other", count: 0, value: 0 },
  ];
  for (const row of rows) {
    const index =
      row.status === "dismissed" || row.resolution_reason === "dismissed" ? 2 : row.resolution_reason === "lost" ? 0 : row.resolution_reason === "condition_no_longer_true" ? 1 : 3;
    groups[index].count += 1;
    groups[index].value += row.estimated_value ?? 0;
  }
  return groups;
}

/**
 * Phase 2A (Analytics only): opportunities that closed (resolved or
 * dismissed) in the period, grouped by groupOpportunityOutcomes. Dated by
 * resolved_at - when Trackpr's opportunity sync noticed the change, not
 * necessarily when it happened.
 */
export async function getOpportunityOutcomes(supabase: SupabaseClient, organizationId: string, range: ResolvedDateRange): Promise<{ groups: OpportunityOutcomeGroup[]; failed: boolean }> {
  let query = supabase.from("opportunities").select("status, resolution_reason, estimated_value").eq("organization_id", organizationId).in("status", ["resolved", "dismissed"]).limit(MAX_ROWS);
  if (range.from) query = query.gte("resolved_at", range.from);
  if (range.to) query = query.lt("resolved_at", range.to);
  const { data, error } = await query;
  return { groups: groupOpportunityOutcomes((data ?? []) as { status: string; resolution_reason: string | null; estimated_value: number | null }[]), failed: error != null };
}

/**
 * Phase 2B (Analytics only): lifecycle linkage coverage - how many of the
 * organization's jobs (all time) are linked to a lead, the link revenue
 * attribution, lead-to-paid conversion and sales-cycle reporting depend on.
 * Two head-only counts, no rows read. Not part of the snapshot, so Agency
 * and the AI observations never see it.
 */
export async function getJobLeadLinkage(supabase: SupabaseClient, organizationId: string): Promise<{ linked: number; total: number; failed: boolean }> {
  const [all, linked] = await Promise.all([
    supabase.from("jobs").select("id", { count: "exact", head: true }).eq("organization_id", organizationId),
    supabase.from("jobs").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).not("lead_id", "is", null),
  ]);
  return { linked: linked.count ?? 0, total: all.count ?? 0, failed: all.error != null || linked.error != null };
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

/**
 * Growth System Completion Pass 2, Part 4: SUM/AVG/count over
 * ai_interactions.tokens_used - only ever real, provider-reported totals
 * (see AiResult.usage in the n8n-callback route); never estimated. Rows
 * with a null tokens_used are excluded from the sum/average and counted
 * separately, matching getNonNullAmountCount's own established null-vs-zero
 * discipline for estimates/jobs.
 */
async function getAiUsageTotals(
  supabase: SupabaseClient,
  organizationId: string,
  range: ResolvedDateRange,
): Promise<{ totalTokensUsed: number | null; averageTokensPerInteraction: number | null; interactionsWithUsageData: number; failed: boolean }> {
  let query = supabase.from("ai_interactions").select("tokens_used").eq("organization_id", organizationId).not("tokens_used", "is", null).limit(MAX_ROWS);
  if (range.from) query = query.gte("created_at", range.from);
  if (range.to) query = query.lt("created_at", range.to);

  const { data, error } = await query;
  const rows = (data ?? []) as { tokens_used: number | null }[];
  const values = rows.map((row) => row.tokens_used).filter((value): value is number => value !== null);
  const failed = error != null;

  if (values.length === 0) {
    return { totalTokensUsed: null, averageTokensPerInteraction: null, interactionsWithUsageData: 0, failed };
  }

  const total = values.reduce((sum, value) => sum + value, 0);
  return { totalTokensUsed: total, averageTokensPerInteraction: total / values.length, interactionsWithUsageData: values.length, failed };
}

/** Trackpr 2.0, Phase 4B (P1 #2): `failed` is true if ANY of the three reads that make up BiAiMetrics failed - see getLeadAndPipelineMetrics's own comment in lib/bi/queries.ts for the full discipline. */
// Phase 2A-1: exported (unchanged) so the Dashboard's "What AI handled"
// panel can compute exactly these metrics without building a whole snapshot -
// see lib/dashboard/business-metrics.ts's getDashboardAiHandled.
/** Every AI interaction except the owner-requested business_insights reports - see BiAiMetrics.customerAiInteractions. */
export function customerAiInteractions(totalAiInteractions: number, aiInteractionsByType: Record<string, number>): number {
  return totalAiInteractions - (aiInteractionsByType.business_insights ?? 0);
}

export async function buildAiMetrics(supabase: SupabaseClient, organizationId: string, range: ResolvedDateRange): Promise<{ metrics: BiAiMetrics; failed: boolean }> {
  const [ai, outputFields, usage] = await Promise.all([
    getAiMetrics(supabase, organizationId, range),
    getAiOutputFields(supabase, organizationId, range),
    getAiUsageTotals(supabase, organizationId, range),
  ]);

  return {
    metrics: {
      aiInteractions: ai.totalAiInteractions,
      customerAiInteractions: customerAiInteractions(ai.totalAiInteractions, ai.aiInteractionsByType),
      aiOutboundInteractions: outputFields.aiOutboundInteractions,
      customerReplyAiInteractions: outputFields.customerReplyAiInteractions,
      aiNeedsHumanCount: outputFields.aiNeedsHumanCount,
      totalTokensUsed: usage.totalTokensUsed,
      averageTokensPerInteraction: usage.averageTokensPerInteraction,
      interactionsWithUsageData: usage.interactionsWithUsageData,
    },
    failed: ai.failed || outputFields.failed || usage.failed,
  };
}

/**
 * Pass 5C, Batch 3B: the stageHistoryUnavailable note now also states the
 * exact coverage fraction (leadsWithRecordedHistory of leadsInRange) rather
 * than only a binary existence fact - this is the "smallest safe change"
 * the Batch 3B audit recommended for the known existence-vs-coverage
 * ambiguity: stageHistoryUnavailable's own type/name/computation are
 * deliberately untouched (still a plain boolean, still fed by
 * hasAnyLeadStageHistory), only the human-readable text a contractor
 * actually reads is made precise. Never claims complete coverage - a
 * partial-coverage period (some leads have recorded history, most don't)
 * states that explicitly, using the real counts already computed by
 * getLeadStageTimingMetrics for this same snapshot.
 */
function buildDataQuality(aiUsage: BiAiMetrics, stageHistoryUnavailable: boolean, timing: LeadStageTimingMetrics, collectedRevenueUnavailable: boolean, stageHistoryReadFailed = false): BiDataQuality {
  const aiTokenUsageUnavailable = aiUsage.interactionsWithUsageData === 0;
  // Phase 1B-4: the payment ledger exists now. The first note states the one
  // sanctioned definition of collected revenue and keeps every quoted/
  // contracted figure on the other side of that line.
  const notes = [
    collectedRevenueUnavailable
      ? "The invoice and payment ledger could not be read for this snapshot - collected revenue is unavailable here, and billingMetrics is zeroed, not measured. pipelineValue, estimateValue, and contractedJobValue remain quoted/contracted figures, never collected revenue."
      : `${SANCTIONED_COLLECTED_REVENUE_DEFINITION} Only billingMetrics.collectedValue is collected revenue; pipelineValue, estimateValue, contractedJobValue, and invoicedValue are quoted, contracted, or invoiced figures, never collected revenue.`,
    "leads.source is nullable and not standardized - sourceCounts is exposed for transparency only, never as a performance ranking.",
  ];
  notes.push(
    // Phase 2F: a failed read is never reported as "no history" or as a coverage count.
    stageHistoryReadFailed
      ? "Lead stage history could not be read for this snapshot - the historical funnel figures and their comparisons are unavailable, not zero. Do not describe them."
      : stageHistoryUnavailable
      ? "No lead.stage_changed event exists for this organization in this period - the historical funnel section below has nothing to compute from yet."
      : `Historical stage timing (time to qualified/won) is available only for leads with a recorded lead.stage_changed event - in this period, that is ${timing.leadsWithRecordedHistory} of ${timing.leadsInRange} lead(s). This is not a complete historical record for every lead; see the funnel section below for the exact current counts before treating any average as representative of the full period.`,
  );
  notes.push(
    aiTokenUsageUnavailable
      ? "No ai_interactions row in this period has provider-reported token usage - n8n's own AI call did not report it for any interaction in range."
      : `Token usage is available for ${aiUsage.interactionsWithUsageData} of ${aiUsage.aiInteractions} AI interaction(s) in this period - only n8n calls that reported usage are included.`,
  );

  return {
    collectedRevenueUnavailable,
    sourceAttributionLimited: true,
    stageHistoryUnavailable: stageHistoryUnavailable || stageHistoryReadFailed,
    aiTokenUsageUnavailable,
    notes,
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
  options: { timeZone?: string; now?: Date } = {},
): Promise<BusinessMetricsSnapshot> {
  // Phase 2A: Analytics passes the organization's timezone, which switches
  // the period and its comparison to organization-calendar boundaries
  // (./date-range.ts). Every other caller (Agency, AI Observations) passes
  // nothing and keeps the original server-calendar, same-length behavior.
  const { timeZone: organizationTimeZone, now = new Date() } = options;
  const range = resolveDateRange(dateRangeInput, now, organizationTimeZone);
  const previousRange = organizationTimeZone !== undefined ? previousOrganizationRange(dateRangeInput, range, now, organizationTimeZone) : previousPeriodOf(range);

  const [
    { lead, pipeline, failed: leadFailed },
    { metrics: estimateMetrics, failed: estimatesFailed },
    { metrics: jobMetrics, failed: jobsFailed },
    { metrics: appointmentMetrics, failed: appointmentsFailed },
    communicationMetrics,
    { automation, followUp },
    { metrics: aiMetrics, failed: aiFailed },
    reviewReferralMetrics,
    stageHistory,
    { leads: sharedLeads, failed: sharedLeadsFailed },
    transitionMetrics,
    previousTotals,
    billingRows,
    timeZone,
  ] =
    await Promise.all([
      buildLeadMetrics(supabase, organizationId, range),
      buildEstimateMetrics(supabase, organizationId, range),
      buildJobMetrics(supabase, organizationId, range),
      buildAppointmentMetrics(supabase, organizationId, range),
      buildCommunicationMetrics(supabase, organizationId, range),
      buildAutomationMetrics(supabase, organizationId, range),
      buildAiMetrics(supabase, organizationId, range),
      getReviewReferralMetrics(supabase, organizationId, range),
      // Pass 5C, Batch 3A: a cheap count:exact/head:true existence check -
      // see BiDataQuality.stageHistoryUnavailable's own comment in
      // lib/bi/types.ts. Left exactly as-is per the Batch 3B audit's own
      // instruction not to change this flag's computation mechanism, even
      // though transitionMetrics/timingMetrics below are now also computed
      // in this same function.
      hasAnyLeadStageHistoryResult(supabase, organizationId, range),
      // Pass 5C, Batch 3B: the one shared, range-scoped `leads` fetch reused
      // below by getLeadStageTimingMetrics and getLeadResponseTimeMetrics -
      // see lib/bi/funnel.ts's own header comment for why this replaces two
      // separate, redundant `leads` reads with one.
      getLeadsForRangeResult(supabase, organizationId, range),
      getLeadStageTransitionMetrics(supabase, organizationId, range),
      previousRange
        ? Promise.all([
            getLeadAndPipelineMetrics(supabase, organizationId, previousRange),
            getEstimateMetrics(supabase, organizationId, previousRange),
            getJobMetrics(supabase, organizationId, previousRange),
            getLeadStageTransitionMetrics(supabase, organizationId, previousRange),
            getLeadsForRangeResult(supabase, organizationId, previousRange),
          ])
        : Promise.resolve(null),
      // Phase 1B-4: one unbounded read of the invoice/payment ledger feeds
      // the period-scoped, previous-period and current-state billing
      // figures below - see lib/bi/billing.ts.
      getBillingRowsResult(supabase, organizationId),
      // "Overdue" is judged against today's calendar date in the
      // organization's own timezone, the same calendar the issue trigger
      // used for the default due date (lib/invoices/queries.ts's
      // getInvoiceWithContext does exactly this). Analytics already passes
      // the timezone, so it isn't read twice.
      organizationTimeZone !== undefined ? Promise.resolve(organizationTimeZone) : getOrganizationTimezone(supabase, organizationId),
    ]);


  const today = calendarDateInTimeZone(now, timeZone ?? "UTC");
  const billingMetrics: BiBillingMetrics = computeBillingMetrics({ invoices: billingRows.invoices, payments: billingRows.payments, range, today });
  const previousBilling = previousRange ? computeBillingMetrics({ invoices: billingRows.invoices, payments: billingRows.payments, range: previousRange, today }) : null;

  const { opportunity: revenueOpportunity, estimateAging } = await buildRevenueOpportunity(supabase, organizationId, now, timeZone ?? "UTC");
  const invoiceAging = computeInvoiceAging(billingRows.invoices, today);

  // Second stage: getLeadStageTimingMetrics/getLeadResponseTimeMetrics both
  // need `sharedLeads` (and, for the previous period, previousTotals[4])
  // before they can run - the one unavoidable sequential dependency in this
  // function, never expanded beyond what's genuinely required.
  const [timingMetrics, responseTimeMetrics, previousResponseTimeMetrics] = await Promise.all([
    getLeadStageTimingMetrics(supabase, organizationId, sharedLeads),
    getLeadResponseTimeMetrics(supabase, organizationId, sharedLeads),
    previousTotals ? getLeadResponseTimeMetrics(supabase, organizationId, previousTotals[4].leads) : Promise.resolve(null),
  ]);

  // Phase 2F: a funnel figure is unavailable when its own read - or the
  // shared leads read its population comes from - failed. A comparison is
  // unavailable when either period's read failed, so neither Analytics nor
  // the AI observations ever describe a change from a figure that wasn't
  // measured.
  const funnelUnavailable = {
    responseTime: sharedLeadsFailed || responseTimeMetrics.failed,
    stageTransitions: transitionMetrics.failed,
    stageTiming: sharedLeadsFailed || timingMetrics.failed,
  };
  const previousContactedFailed = previousTotals ? previousTotals[4].failed || previousResponseTimeMetrics!.failed : false;
  const previousTransitionsFailed = previousTotals ? previousTotals[3].failed : false;
  const contactedComparison = funnelUnavailable.responseTime || previousContactedFailed ? UNAVAILABLE_COMPARISON : computeComparison(responseTimeMetrics.leadsContacted, previousTotals ? previousResponseTimeMetrics!.leadsContacted : null);
  const transitionComparison = (current: number, previous: number | undefined) =>
    funnelUnavailable.stageTransitions || previousTransitionsFailed ? UNAVAILABLE_COMPARISON : computeComparison(current, previous ?? null);

  const comparisons: BusinessMetricsComparisons = previousTotals
    ? {
        leadCount: computeComparison(lead.totalLeads, previousTotals[0].leads.totalLeads),
        estimateCount: computeComparison(estimateMetrics.totalEstimates, previousTotals[1].totalEstimates),
        jobCount: computeComparison(jobMetrics.totalJobs, previousTotals[2].totalJobs),
        leadsTransitionedToQualified: transitionComparison(transitionMetrics.leadsTransitionedToQualified, previousTotals[3].leadsTransitionedToQualified),
        leadsTransitionedToWon: transitionComparison(transitionMetrics.leadsTransitionedToWon, previousTotals[3].leadsTransitionedToWon),
        leadsContacted: contactedComparison,
        invoicedValue: computeComparison(billingMetrics.invoicedValue, previousBilling!.invoicedValue),
        collectedValue: computeComparison(billingMetrics.collectedValue, previousBilling!.collectedValue),
      }
    : {
        leadCount: computeComparison(lead.totalLeads, null),
        estimateCount: computeComparison(estimateMetrics.totalEstimates, null),
        jobCount: computeComparison(jobMetrics.totalJobs, null),
        leadsTransitionedToQualified: transitionComparison(transitionMetrics.leadsTransitionedToQualified, undefined),
        leadsTransitionedToWon: transitionComparison(transitionMetrics.leadsTransitionedToWon, undefined),
        leadsContacted: contactedComparison,
        invoicedValue: computeComparison(billingMetrics.invoicedValue, null),
        collectedValue: computeComparison(billingMetrics.collectedValue, null),
      };

  // Trackpr 2.0, Phase 4B (P1 #2): true only when one of this function's own
  // core reads (lead/pipeline, estimates, jobs, appointments, AI) returned a
  // real Postgrest error - a genuinely empty `{ data: [], error: null }`
  // response never sets this. Mirrors DashboardData.partialData
  // (lib/dashboard/queries.ts) exactly. Deliberately scoped to the CURRENT
  // period's reads only, not the previous-period comparison reads above
  // (comparisons/leadCount etc. are a secondary, smaller-stakes signal), and
  // deliberately does not extend to communication/automation/review-referral
  // metrics, which are outside this file's own audited scope.
  //
  // Trackpr 2.0, Phase 4C (P2 #1): extended to also cover lib/bi/funnel.ts's
  // own reads (the shared leads fetch, historical transitions, timing, and
  // response-time metrics) - a failure there would otherwise silently render
  // as an empty/zeroed "Historical funnel"/"Time to first response" section
  // on Analytics, indistinguishable from a genuinely quiet period.
  //
  // Phase 1B-4: also covers the billing ledger read - a failure there would
  // otherwise render as a false "$0 collected."
  const partialDataSourceCount = [leadFailed, estimatesFailed, jobsFailed, appointmentsFailed, aiFailed, sharedLeadsFailed, transitionMetrics.failed, timingMetrics.failed, responseTimeMetrics.failed, billingRows.failed].filter(
    Boolean,
  ).length;
  const partialData = partialDataSourceCount > 0;

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
    billingMetrics,
    revenueOpportunity,
    invoiceAging,
    estimateAging,
    reviewReferralMetrics,
    leadStageFunnel: { transitions: transitionMetrics, timing: timingMetrics },
    responseTime: responseTimeMetrics,
    dataQuality: buildDataQuality(aiMetrics, !stageHistory.exists, timingMetrics, billingRows.failed, stageHistory.failed || funnelUnavailable.stageTransitions || funnelUnavailable.stageTiming),
    partialData,
    partialDataSourceCount,
    funnelUnavailable,
    generatedAt: new Date().toISOString(),
  };
}

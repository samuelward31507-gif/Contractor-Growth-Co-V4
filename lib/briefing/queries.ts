import type { SupabaseClient } from "@supabase/supabase-js";
import { cache } from "react";
import { getDashboardData, getDashboardSqlData, type AttentionItem, type DashboardData } from "@/lib/dashboard/queries";
import { briefingContactName, briefingMoney, getDashboardBriefingInputs, type DashboardBriefingInputs } from "@/lib/dashboard/sql";
import { getHotLeadCount } from "@/lib/leads/queries";
import { getAppointmentsResult, type Appointment } from "@/lib/appointments/queries";
import { getEstimatesResult, type Estimate } from "@/lib/estimates/queries";
import { getJobsResult, type Job } from "@/lib/jobs/queries";
import { getReviewRequestsResult, getReferralRequestsResult } from "@/lib/reviews-referrals/queries";
import { getOrganizationHealth } from "@/lib/automation-health/health";
import { formatCurrency } from "@/lib/dashboard/format";
import { contactDisplayName } from "@/lib/contacts/format";

/**
 * Growth System Completion Pass 2, Parts 5 & 6: the Owner Daily Briefing and
 * End-of-Day Summary, sharing this one module - "the same underlying
 * briefing architecture," per the task's own instruction. Both are entirely
 * deterministic: every field is a real count, sum, or list item read
 * directly from existing tables/queries this codebase already has
 * (lib/dashboard/queries.ts, lib/appointments/queries.ts,
 * lib/estimates/queries.ts, lib/jobs/queries.ts,
 * lib/reviews-referrals/queries.ts, lib/automation-health/health.ts) -
 * nothing here recomputes a metric a different module already owns, and
 * nothing here ever calls an AI model. This means both functions work
 * fully, with a real and useful result, whether or not ANTHROPIC_API_KEY is
 * configured - there is no AI dependency to fail closed on.
 *
 * A short, deterministic `summary` sentence is composed directly from the
 * structured counts on each type - never an LLM call, never a fabricated
 * narrative. If a future phase wants an AI-generated narrative on top of
 * this data, the existing lib/bi/insights.ts machinery (already safe,
 * already validated, already gated on a fresh, explicit request - never a
 * background call) is the correct place to extend, not a new AI path here.
 */

const MAX_LIST_ITEMS = 5;

export type BriefingLead = { id: string; name: string; detail: string; value: string | null; href: string };
export type BriefingAppointment = { id: string; title: string; time: string; contactName: string | null; href: string };
export type BriefingEstimate = { id: string; title: string; value: string | null; contactName: string | null; href: string };
export type BriefingJob = { id: string; title: string; value: string | null; contactName: string | null; href: string };
export type BriefingReviewReferralItem = { id: string; kind: "review" | "referral"; status: string; href: string };
export type BriefingProblem = { title: string; detail: string; severity: "critical" | "warning" };

function isToday(iso: string, now: Date): boolean {
  const date = new Date(iso);
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
}

function appointmentContactName(appointment: Appointment): string | null {
  return appointment.contact ? contactDisplayName(appointment.contact) : null;
}

/**
 * Phase 2D: `source: "sql"` builds the briefing and the end-of-day summary
 * from dashboard_briefing (supabase/pending/dashboard_sql.sql) - counts over
 * every row, lists bounded to MAX_LIST_ITEMS in SQL - plus the request's
 * shared getDashboardSqlData, instead of the capped appointments / estimates
 * / jobs / review / referral reads. The default stays "legacy".
 */
export type BriefingOptions = { source?: "legacy" | "sql" };

/** One dashboard_briefing call per request, org and `now` (pass the same Date to both loaders to share it). Request-scoped via React.cache. */
const getBriefingInputsForRequest = cache((supabase: SupabaseClient, organizationId: string, now: Date) => getDashboardBriefingInputs(supabase, organizationId, now));

async function getAiEscalationCount(supabase: SupabaseClient, organizationId: string): Promise<number> {
  const { count } = await supabase
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("status", "open")
    .eq("ai_enabled", false);
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// Owner Daily Briefing (Part 5)
// ---------------------------------------------------------------------------

export type OwnerDailyBriefing = {
  organizationId: string;
  generatedAt: string;
  newLeadsCount: number;
  /** Capped at MAX_LIST_ITEMS for whatever future list rendering needs a short sample - the summary sentence's own "N hot" figure uses the real, uncapped getHotLeadCount instead (see getOwnerDailyBriefing), so the two numbers can legitimately differ for an org with more than MAX_LIST_ITEMS hot leads; this array's own .length is never the authoritative count. */
  hotLeads: BriefingLead[];
  appointmentsToday: BriefingAppointment[];
  appointmentsNeedingAttention: AttentionItem[];
  estimatesAwaitingAction: BriefingEstimate[];
  jobsRecentlyCompleted: BriefingJob[];
  reviewReferralOpportunities: BriefingReviewReferralItem[];
  automationProblems: BriefingProblem[];
  aiEscalationsCount: number;
  /** A short, deterministic, non-AI-generated sentence composed from the fields above. */
  summary: string;
  /**
   * Trackpr 2.0, Phase 4C (P2 #2): true when any of this briefing's own
   * reads (appointments, estimates, jobs, review/referral requests, or
   * dashboard.partialData's own 5 direct reads) returned a real Postgrest
   * error - a genuinely quiet day must never be indistinguishable from a
   * briefing built on incomplete data. Never set by genuine emptiness.
   */
  partialData: boolean;
};

export async function getOwnerDailyBriefing(supabase: SupabaseClient, organizationId: string, now: Date = new Date(), options: BriefingOptions = {}): Promise<OwnerDailyBriefing> {
  if (options.source === "sql") {
    const [dashboard, briefing, health] = await Promise.all([getDashboardSqlData(supabase, organizationId), getBriefingInputsForRequest(supabase, organizationId, now), getOrganizationHealth(supabase, organizationId)]);
    return composeOwnerDailyBriefing({
      organizationId,
      dashboard,
      health,
      partialData: dashboard.partialData || briefing.failed,
      appointmentsToday: briefing.data.appointments_today.map((row) => ({ id: row.id, title: row.title, time: row.start_at, contactName: briefingContactName(row), href: `/appointments/${row.id}` })),
      estimatesAwaitingAction: briefing.data.estimates_awaiting.map((row) => ({ id: row.id, title: row.title, value: briefingMoney(row.amount), contactName: briefingContactName(row), href: `/estimates/${row.id}` })),
      jobsRecentlyCompleted: briefing.data.jobs_recently_completed.map((row) => ({ id: row.id, title: row.title, value: briefingMoney(row.amount), contactName: briefingContactName(row), href: `/jobs/${row.id}` })),
      reviewReferralOpportunities: responsesAsOpportunities(briefing.data),
      aiEscalationsCount: briefing.data.ai_escalations_count,
      hotLeadCount: briefing.data.hot_lead_count,
    });
  }
  const [dashboard, appointmentsResult, estimatesResult, jobsResult, reviewRequestsResult, referralRequestsResult, health, aiEscalationsCount, hotLeadCount] = await Promise.all([
    getDashboardData(supabase, organizationId),
    getAppointmentsResult(supabase, organizationId),
    getEstimatesResult(supabase, organizationId),
    getJobsResult(supabase, organizationId),
    getReviewRequestsResult(supabase, organizationId),
    getReferralRequestsResult(supabase, organizationId),
    getOrganizationHealth(supabase, organizationId),
    getAiEscalationCount(supabase, organizationId),
    // Finalization pass, product-consistency audit: the summary sentence
    // below used to say `${hotLeads.length} hot`, capped at MAX_LIST_ITEMS
    // (5) by the same slice() that bounds the (unrendered) hotLeads list -
    // an org with more than 5 hot leads got a silently wrong, undercounted
    // sentence ("5 hot") that disagreed with Today's own header, which
    // already shows the true, uncapped count via this exact same function.
    // Reusing it here - rather than a second, independently-drifting hot-lead
    // count - is what makes the two numbers agree everywhere they're shown.
    getHotLeadCount(supabase, organizationId),
  ]);
  const appointments = appointmentsResult.data;
  const estimates = estimatesResult.data;
  const jobs = jobsResult.data;
  const reviewRequests = reviewRequestsResult.data;
  const referralRequests = referralRequestsResult.data;
  const partialData = dashboard.partialData || appointmentsResult.failed || estimatesResult.failed || jobsResult.failed || reviewRequestsResult.failed || referralRequestsResult.failed;

  const appointmentsToday: BriefingAppointment[] = appointments
    .filter((appointment) => isToday(appointment.start_at, now) && (appointment.status === "scheduled" || appointment.status === "confirmed"))
    .slice(0, MAX_LIST_ITEMS)
    .map((appointment) => ({ id: appointment.id, title: appointment.title, time: appointment.start_at, contactName: appointmentContactName(appointment), href: `/appointments/${appointment.id}` }));

  const estimatesAwaitingAction: BriefingEstimate[] = estimates
    .filter((estimate: Estimate) => estimate.status === "sent")
    .slice(0, MAX_LIST_ITEMS)
    .map((estimate) => ({ id: estimate.id, title: estimate.title, value: estimate.amount != null ? formatCurrency(estimate.amount) : null, contactName: estimate.contact ? contactDisplayName(estimate.contact) : null, href: `/estimates/${estimate.id}` }));

  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const jobsRecentlyCompleted: BriefingJob[] = jobs
    .filter((job: Job) => job.status === "completed" && job.completed_at && new Date(job.completed_at).getTime() >= sevenDaysAgo.getTime())
    .slice(0, MAX_LIST_ITEMS)
    .map((job) => ({ id: job.id, title: job.title, value: job.amount != null ? formatCurrency(job.amount) : null, contactName: job.contact ? contactDisplayName(job.contact) : null, href: `/jobs/${job.id}` }));

  // "Opportunities": a customer already responded, but the contractor
  // hasn't yet confirmed the outcome (completed/declined, converted/
  // declined) - a real, actionable item, never a fabricated one.
  const reviewReferralOpportunities: BriefingReviewReferralItem[] = [
    ...reviewRequests.filter((r) => r.status === "responded").map((r) => ({ id: r.id, kind: "review" as const, status: r.status, href: `/jobs/${r.job_id}` })),
    ...referralRequests.filter((r) => r.status === "responded").map((r) => ({ id: r.id, kind: "referral" as const, status: r.status, href: `/jobs/${r.job_id}` })),
  ].slice(0, MAX_LIST_ITEMS);

  return composeOwnerDailyBriefing({ organizationId, dashboard, health, partialData, appointmentsToday, estimatesAwaitingAction, jobsRecentlyCompleted, reviewReferralOpportunities, aiEscalationsCount, hotLeadCount });
}

function responsesAsOpportunities(briefing: DashboardBriefingInputs): BriefingReviewReferralItem[] {
  return [
    ...briefing.responded_reviews.map((r) => ({ id: r.id, kind: "review" as const, status: r.status, href: `/jobs/${r.job_id}` })),
    ...briefing.responded_referrals.map((r) => ({ id: r.id, kind: "referral" as const, status: r.status, href: `/jobs/${r.job_id}` })),
  ].slice(0, MAX_LIST_ITEMS);
}

/** The part of the Owner Daily Briefing both sources share: everything derived from the dashboard, health and the already-built lists. */
function composeOwnerDailyBriefing(input: {
  organizationId: string;
  dashboard: DashboardData;
  health: Awaited<ReturnType<typeof getOrganizationHealth>>;
  partialData: boolean;
  appointmentsToday: BriefingAppointment[];
  estimatesAwaitingAction: BriefingEstimate[];
  jobsRecentlyCompleted: BriefingJob[];
  reviewReferralOpportunities: BriefingReviewReferralItem[];
  aiEscalationsCount: number;
  hotLeadCount: number;
}): OwnerDailyBriefing {
  const { organizationId, dashboard, health, partialData, appointmentsToday, estimatesAwaitingAction, jobsRecentlyCompleted, reviewReferralOpportunities, aiEscalationsCount, hotLeadCount } = input;

  const hotLeads: BriefingLead[] = dashboard.attentionItems
    .filter((item): item is AttentionItem & { kind: "hot_lead" } => item.kind === "hot_lead")
    .slice(0, MAX_LIST_ITEMS)
    .map((item) => ({ id: item.id, name: item.title, detail: item.detail, value: item.value, href: item.href }));

  const appointmentsNeedingAttention = dashboard.attentionItems.filter((item) => item.kind === "overdue_appointment").slice(0, MAX_LIST_ITEMS);

  const automationProblems: BriefingProblem[] = [];
  if (health.criticalIncidentCount > 0) {
    automationProblems.push({ title: "Critical automation incidents", detail: `${health.criticalIncidentCount} open`, severity: "critical" });
  }
  if (health.warningIncidentCount > 0) {
    automationProblems.push({ title: "Automation incidents", detail: `${health.warningIncidentCount} open`, severity: "warning" });
  }
  if (health.smsDeliveryFailureCount > 0) {
    automationProblems.push({ title: "SMS delivery failures", detail: `${health.smsDeliveryFailureCount} recent`, severity: "warning" });
  }

  const summaryParts: string[] = [];
  if (dashboard.overview.newLeads > 0) summaryParts.push(`${dashboard.overview.newLeads} new lead${dashboard.overview.newLeads === 1 ? "" : "s"}`);
  if (hotLeadCount > 0) summaryParts.push(`${hotLeadCount} hot`);
  if (appointmentsToday.length > 0) summaryParts.push(`${appointmentsToday.length} appointment${appointmentsToday.length === 1 ? "" : "s"} today`);
  if (estimatesAwaitingAction.length > 0) summaryParts.push(`${estimatesAwaitingAction.length} estimate${estimatesAwaitingAction.length === 1 ? "" : "s"} awaiting a reply`);
  if (aiEscalationsCount > 0) summaryParts.push(`${aiEscalationsCount} conversation${aiEscalationsCount === 1 ? "" : "s"} waiting on you`);
  if (automationProblems.length > 0) summaryParts.push(`${automationProblems.length} automation problem${automationProblems.length === 1 ? "" : "s"}`);

  const summary = summaryParts.length > 0 ? summaryParts.join(", ") + "." : "You're all caught up.";

  return {
    organizationId,
    generatedAt: new Date().toISOString(),
    newLeadsCount: dashboard.overview.newLeads,
    hotLeads,
    appointmentsToday,
    appointmentsNeedingAttention,
    estimatesAwaitingAction,
    jobsRecentlyCompleted,
    reviewReferralOpportunities,
    automationProblems,
    aiEscalationsCount,
    summary,
    partialData,
  };
}

// ---------------------------------------------------------------------------
// End-of-Day Summary (Part 6)
// ---------------------------------------------------------------------------

export type EndOfDaySummary = {
  organizationId: string;
  generatedAt: string;
  leadsReceived: number;
  appointmentsBooked: number;
  estimatesSent: number;
  jobsWonOrCompleted: number;
  /** SUM(estimates.amount) for estimates sent today + SUM(jobs.amount) for jobs won/completed today - the quoted/contracted amount those activities REPRESENT, never collected revenue (no payment infrastructure exists in this codebase). */
  valueRepresented: number;
  /**
   * Finalization pass: a raw count of every Attention Engine item
   * (lib/dashboard/queries.ts's 17 kinds), computed here but never rendered
   * anywhere in the current UI (confirmed by a full-repo search) - kept for
   * API compatibility with any future consumer, but explicitly NOT the same
   * number as Today's own canonical "N things need you" total
   * (lib/opportunities/intelligence.ts's getPrioritizedOpportunities +
   * getOperationalExceptions + getConversationSignals), which deduplicates
   * and covers 2 opportunity types this raw count doesn't. A future consumer
   * wanting "how many things need attention" should call the canonical
   * intelligence layer directly, never read this field for that purpose.
   */
  unresolvedItemsCount: number;
  automationIncidentsCount: number;
  aiEscalationsCount: number;
  summary: string;
  /** Trackpr 2.0, Phase 4C (P2 #2): true when any of this summary's own reads returned a real Postgrest error - see OwnerDailyBriefing.partialData's own comment for the full discipline. */
  partialData: boolean;
};

/**
 * "Today" throughout this function means the server process's local
 * calendar day (JS `Date` local getters) - the same documented
 * simplification lib/bi/queries.ts's own resolveDateRange already uses for
 * its "today" preset, not yet organization-timezone-aware.
 */
export async function getEndOfDaySummary(supabase: SupabaseClient, organizationId: string, now: Date = new Date(), options: BriefingOptions = {}): Promise<EndOfDaySummary> {
  if (options.source === "sql") {
    const [dashboard, briefing, health] = await Promise.all([getDashboardSqlData(supabase, organizationId), getBriefingInputsForRequest(supabase, organizationId, now), getOrganizationHealth(supabase, organizationId)]);
    return composeEndOfDaySummary({
      organizationId,
      now,
      dashboard,
      health,
      partialData: dashboard.partialData || briefing.failed,
      appointmentsBooked: briefing.data.appointments_booked_today,
      estimatesSent: briefing.data.estimates_sent_today,
      jobsWonOrCompleted: briefing.data.jobs_won_or_completed_today,
      valueRepresented: briefing.data.estimates_sent_today_value + briefing.data.jobs_won_or_completed_today_value,
      aiEscalationsCount: briefing.data.ai_escalations_count,
    });
  }
  const [dashboard, appointmentsResult, estimatesResult, jobsResult, health, aiEscalationsCount] = await Promise.all([
    getDashboardData(supabase, organizationId),
    getAppointmentsResult(supabase, organizationId),
    getEstimatesResult(supabase, organizationId),
    getJobsResult(supabase, organizationId),
    getOrganizationHealth(supabase, organizationId),
    getAiEscalationCount(supabase, organizationId),
  ]);
  const appointments = appointmentsResult.data;
  const estimates = estimatesResult.data;
  const jobs = jobsResult.data;
  const partialData = dashboard.partialData || appointmentsResult.failed || estimatesResult.failed || jobsResult.failed;

  const appointmentsBookedToday = appointments.filter((appointment) => isToday(appointment.created_at, now));
  const estimatesSentToday = estimates.filter((estimate: Estimate) => estimate.sent_at && isToday(estimate.sent_at, now));
  // "Won" = a job created today (a job is only ever created the moment an
  // estimate is accepted, or - Growth System Completion Pass 1, Part 6 -
  // directly by the contractor; both represent genuinely new confirmed
  // work) that hasn't since been cancelled. "Completed" = marked completed
  // today, regardless of when it was created. A job matching both in the
  // same day is still counted exactly once (a single filter predicate, not
  // two merged lists).
  const jobsWonOrCompletedToday = jobs.filter((job: Job) => (job.status !== "cancelled" && isToday(job.created_at, now)) || (job.status === "completed" && job.completed_at && isToday(job.completed_at, now)));

  const estimateValueRepresented = estimatesSentToday.reduce((sum, estimate) => sum + (estimate.amount ?? 0), 0);
  const jobValueRepresented = jobsWonOrCompletedToday.reduce((sum, job) => sum + (job.amount ?? 0), 0);

  return composeEndOfDaySummary({
    organizationId,
    now,
    dashboard,
    health,
    partialData,
    appointmentsBooked: appointmentsBookedToday.length,
    estimatesSent: estimatesSentToday.length,
    jobsWonOrCompleted: jobsWonOrCompletedToday.length,
    valueRepresented: estimateValueRepresented + jobValueRepresented,
    aiEscalationsCount,
  });
}

/** The part of the End-of-Day Summary both sources share. */
function composeEndOfDaySummary(input: {
  organizationId: string;
  now: Date;
  dashboard: DashboardData;
  health: Awaited<ReturnType<typeof getOrganizationHealth>>;
  partialData: boolean;
  appointmentsBooked: number;
  estimatesSent: number;
  jobsWonOrCompleted: number;
  valueRepresented: number;
  aiEscalationsCount: number;
}): EndOfDaySummary {
  const { organizationId, now, dashboard, health, partialData, appointmentsBooked, estimatesSent, jobsWonOrCompleted, valueRepresented, aiEscalationsCount } = input;

  const leadsReceived = dashboard.recentActivity.filter((item) => item.id.startsWith("lead-") && isToday(item.timestamp, now)).length;

  const unresolvedItemsCount = dashboard.attentionItems.length;
  const automationIncidentsCount = health.activeIncidentCount;

  const summaryParts: string[] = [];
  if (leadsReceived > 0) summaryParts.push(`${leadsReceived} lead${leadsReceived === 1 ? "" : "s"} received`);
  if (appointmentsBooked > 0) summaryParts.push(`${appointmentsBooked} appointment${appointmentsBooked === 1 ? "" : "s"} booked`);
  if (estimatesSent > 0) summaryParts.push(`${estimatesSent} estimate${estimatesSent === 1 ? "" : "s"} sent`);
  if (jobsWonOrCompleted > 0) summaryParts.push(`${jobsWonOrCompleted} job${jobsWonOrCompleted === 1 ? "" : "s"} won/completed`);
  // Phase 0 (Foundation Trust), item 3: deliberately NOT folded into this
  // sentence - this used to add "N items still need attention" using its
  // own count (dashboard.attentionItems.length, a raw AttentionItem count),
  // while /today's own H1 states a DIFFERENT number for what reads as the
  // same claim (queue.length, which also folds in the two opportunity-only
  // card types AttentionItem doesn't cover). Today's H1 is the one
  // authoritative "things need you" statement; this summary sentence
  // stays scoped to what actually happened today (leads/appointments/
  // estimates/jobs), never a second, competing count of the same concept.
  // unresolvedItemsCount is still returned below (a real, honest number),
  // just no longer composed into this sentence.
  if (automationIncidentsCount > 0) summaryParts.push(`${automationIncidentsCount} automation incident${automationIncidentsCount === 1 ? "" : "s"}`);

  const summary = summaryParts.length > 0 ? summaryParts.join(", ") + "." : "A quiet day - nothing new to report.";

  return {
    organizationId,
    generatedAt: new Date().toISOString(),
    leadsReceived,
    appointmentsBooked,
    estimatesSent,
    jobsWonOrCompleted,
    valueRepresented,
    unresolvedItemsCount,
    automationIncidentsCount,
    aiEscalationsCount,
    summary,
    partialData,
  };
}

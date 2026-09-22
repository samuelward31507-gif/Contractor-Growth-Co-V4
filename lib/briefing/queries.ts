import type { SupabaseClient } from "@supabase/supabase-js";
import { getDashboardData, type AttentionItem } from "@/lib/dashboard/queries";
import { getAppointments, type Appointment } from "@/lib/appointments/queries";
import { getEstimates, type Estimate } from "@/lib/estimates/queries";
import { getJobs, type Job } from "@/lib/jobs/queries";
import { getReviewRequests, getReferralRequests } from "@/lib/reviews-referrals/queries";
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
};

export async function getOwnerDailyBriefing(supabase: SupabaseClient, organizationId: string, now: Date = new Date()): Promise<OwnerDailyBriefing> {
  const [dashboard, appointments, estimates, jobs, reviewRequests, referralRequests, health, aiEscalationsCount] = await Promise.all([
    getDashboardData(supabase, organizationId),
    getAppointments(supabase, organizationId),
    getEstimates(supabase, organizationId),
    getJobs(supabase, organizationId),
    getReviewRequests(supabase, organizationId),
    getReferralRequests(supabase, organizationId),
    getOrganizationHealth(supabase, organizationId),
    getAiEscalationCount(supabase, organizationId),
  ]);

  const hotLeads: BriefingLead[] = dashboard.attentionItems
    .filter((item): item is AttentionItem & { kind: "hot_lead" } => item.kind === "hot_lead")
    .slice(0, MAX_LIST_ITEMS)
    .map((item) => ({ id: item.id, name: item.title, detail: item.detail, value: item.value, href: item.href }));

  const appointmentsToday: BriefingAppointment[] = appointments
    .filter((appointment) => isToday(appointment.start_at, now) && (appointment.status === "scheduled" || appointment.status === "confirmed"))
    .slice(0, MAX_LIST_ITEMS)
    .map((appointment) => ({ id: appointment.id, title: appointment.title, time: appointment.start_at, contactName: appointmentContactName(appointment), href: `/appointments/${appointment.id}` }));

  const appointmentsNeedingAttention = dashboard.attentionItems.filter((item) => item.kind === "overdue_appointment").slice(0, MAX_LIST_ITEMS);

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
  if (hotLeads.length > 0) summaryParts.push(`${hotLeads.length} hot`);
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
  unresolvedItemsCount: number;
  automationIncidentsCount: number;
  aiEscalationsCount: number;
  summary: string;
};

/**
 * "Today" throughout this function means the server process's local
 * calendar day (JS `Date` local getters) - the same documented
 * simplification lib/bi/queries.ts's own resolveDateRange already uses for
 * its "today" preset, not yet organization-timezone-aware.
 */
export async function getEndOfDaySummary(supabase: SupabaseClient, organizationId: string, now: Date = new Date()): Promise<EndOfDaySummary> {
  const [dashboard, appointments, estimates, jobs, health, aiEscalationsCount] = await Promise.all([
    getDashboardData(supabase, organizationId),
    getAppointments(supabase, organizationId),
    getEstimates(supabase, organizationId),
    getJobs(supabase, organizationId),
    getOrganizationHealth(supabase, organizationId),
    getAiEscalationCount(supabase, organizationId),
  ]);

  const leadsReceived = dashboard.recentActivity.filter((item) => item.id.startsWith("lead-") && isToday(item.timestamp, now)).length;

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

  const unresolvedItemsCount = dashboard.attentionItems.length;
  const automationIncidentsCount = health.activeIncidentCount;

  const summaryParts: string[] = [];
  if (leadsReceived > 0) summaryParts.push(`${leadsReceived} lead${leadsReceived === 1 ? "" : "s"} received`);
  if (appointmentsBookedToday.length > 0) summaryParts.push(`${appointmentsBookedToday.length} appointment${appointmentsBookedToday.length === 1 ? "" : "s"} booked`);
  if (estimatesSentToday.length > 0) summaryParts.push(`${estimatesSentToday.length} estimate${estimatesSentToday.length === 1 ? "" : "s"} sent`);
  if (jobsWonOrCompletedToday.length > 0) summaryParts.push(`${jobsWonOrCompletedToday.length} job${jobsWonOrCompletedToday.length === 1 ? "" : "s"} won/completed`);
  if (unresolvedItemsCount > 0) summaryParts.push(`${unresolvedItemsCount} item${unresolvedItemsCount === 1 ? "" : "s"} still need attention`);
  if (automationIncidentsCount > 0) summaryParts.push(`${automationIncidentsCount} automation incident${automationIncidentsCount === 1 ? "" : "s"}`);

  const summary = summaryParts.length > 0 ? summaryParts.join(", ") + "." : "A quiet day - nothing new to report.";

  return {
    organizationId,
    generatedAt: new Date().toISOString(),
    leadsReceived,
    appointmentsBooked: appointmentsBookedToday.length,
    estimatesSent: estimatesSentToday.length,
    jobsWonOrCompleted: jobsWonOrCompletedToday.length,
    valueRepresented: estimateValueRepresented + jobValueRepresented,
    unresolvedItemsCount,
    automationIncidentsCount,
    aiEscalationsCount,
    summary,
  };
}

import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getAgencyBusinessMetrics } from "@/lib/agency/queries";
import { getAgencyHealth } from "@/lib/agency/health";
import { pageTitleClass, pageDescriptionClass, sectionLabelClass, metaClass } from "@/lib/ui/typography";
import { formatCurrency } from "@/lib/dashboard/format";
import { formatRate, formatCount } from "../../_components/format";
import { StatGrid, type Stat } from "../../_components/stat-grid";
import { UnauthorizedState } from "../../_components/unauthorized-state";
import { ErrorState } from "../../_components/error-state";

/**
 * Agency operational view of ONE client organization - not a CRM
 * impersonation screen. No lead/contact/message/estimate/job records are
 * fetched or rendered here, only the same aggregate BusinessMetricsSnapshot
 * (via lib/bi/*, reused unchanged) and health rollup every other agency
 * page reads.
 *
 * Reuses the same agency-wide fetch as app/agency/page.tsx and finds this
 * one organization in the result, rather than adding a second backend
 * entry point: the org either appears in the caller's already-authorized
 * list or it doesn't - the exact same scoping guarantee the backend's own
 * test suite already verified, with no new authorization logic to get
 * wrong here.
 */
export default async function AgencyOrganizationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const supabase = await createClient();
  const service = createServiceRoleClient();

  let metrics: Awaited<ReturnType<typeof getAgencyBusinessMetrics>>;
  let health: Awaited<ReturnType<typeof getAgencyHealth>>;

  try {
    [metrics, health] = await Promise.all([getAgencyBusinessMetrics(supabase, service), getAgencyHealth(supabase, service)]);
  } catch {
    return (
      <div className="flex flex-1 flex-col px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
        <ErrorState />
      </div>
    );
  }

  if (!metrics.ok || !health.ok) {
    return (
      <div className="flex flex-1 flex-col px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
        <UnauthorizedState />
      </div>
    );
  }

  const org = metrics.organizations.find((o) => o.organizationId === id);
  const orgHealth = health.organizations.find((o) => o.organizationId === id);

  // Not present in this agency's own resolved list - whether it doesn't
  // exist or simply isn't an agency-associated organization, the response
  // is identical either way, so this page never confirms or denies the
  // existence of an organization the caller isn't authorized to see.
  if (!org || !orgHealth) {
    return (
      <div className="flex flex-1 flex-col px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
        <UnauthorizedState />
      </div>
    );
  }

  const { metrics: m } = org;

  const businessStats: Stat[] = [
    { key: "leads", label: "Leads", value: formatCount(m.leadMetrics.totalLeads) },
    { key: "open-opportunities", label: "Open opportunities", value: formatCount(m.pipelineMetrics.openOpportunityCount) },
    { key: "pipeline-value", label: "Pipeline value", value: formatCurrency(m.pipelineMetrics.pipelineValue) },
    { key: "estimates", label: "Estimates", value: formatCount(m.estimateMetrics.totalEstimates) },
    { key: "jobs", label: "Jobs", value: formatCount(m.jobMetrics.totalJobs) },
    { key: "contracted-job-value", label: "Contracted job value", value: formatCurrency(m.jobMetrics.contractedJobValue) },
  ];

  const estimateStats: Stat[] = [
    { key: "sent", label: "Sent", value: formatCount(m.estimateMetrics.sentEstimates) },
    { key: "accepted", label: "Accepted", value: formatCount(m.estimateMetrics.acceptedEstimates) },
    { key: "declined", label: "Declined", value: formatCount(m.estimateMetrics.declinedEstimates) },
    { key: "acceptance-rate", label: "Acceptance rate", value: formatRate(m.estimateMetrics.estimateAcceptanceRate) },
  ];

  const jobStats: Stat[] = [
    { key: "scheduled", label: "Scheduled", value: formatCount(m.jobMetrics.scheduledJobs) },
    { key: "in-progress", label: "In progress", value: formatCount(m.jobMetrics.inProgressJobs) },
    { key: "completed", label: "Completed", value: formatCount(m.jobMetrics.completedJobs) },
    { key: "cancelled", label: "Cancelled", value: formatCount(m.jobMetrics.cancelledJobs) },
    { key: "completion-rate", label: "Completion rate", value: formatRate(m.jobMetrics.jobCompletionRate) },
  ];

  const appointmentStats: Stat[] = [
    { key: "total", label: "Total", value: formatCount(m.appointmentMetrics.totalAppointments) },
    { key: "completed", label: "Completed", value: formatCount(m.appointmentMetrics.completedAppointments) },
    { key: "cancelled", label: "Cancelled", value: formatCount(m.appointmentMetrics.cancelledAppointments) },
    { key: "no-show", label: "No-show", value: formatCount(m.appointmentMetrics.noShowAppointments) },
    { key: "no-show-rate", label: "No-show rate", value: formatRate(m.appointmentMetrics.appointmentNoShowRate) },
  ];

  // BiCommunicationMetrics (Phase 5.2) only has inbound/outbound totals -
  // the full delivery-status breakdown (incl. "sent") comes from Phase
  // 5.1's raw byMessageStatus, already fetched as org.messagesByStatus.
  const communicationStats: Stat[] = [
    { key: "inbound", label: "Inbound messages", value: formatCount(m.communicationMetrics.inboundMessages) },
    { key: "outbound", label: "Outbound messages", value: formatCount(m.communicationMetrics.outboundMessages) },
    { key: "delivered", label: "Delivered", value: formatCount(org.messagesByStatus.delivered ?? 0) },
    { key: "failed", label: "Failed", value: formatCount(org.messagesByStatus.failed ?? 0) },
    { key: "undelivered", label: "Undelivered", value: formatCount(org.messagesByStatus.undelivered ?? 0) },
    { key: "queued", label: "Queued", value: formatCount(org.messagesByStatus.queued ?? 0) },
  ];

  const automationStats: Stat[] = [
    { key: "workflow-executions", label: "Workflow executions", value: formatCount(m.automationMetrics.workflowExecutions) },
    { key: "completed", label: "Completed", value: formatCount(m.automationMetrics.successfulWorkflowExecutions) },
    { key: "failed", label: "Failed", value: formatCount(m.automationMetrics.failedWorkflowExecutions) },
    { key: "running", label: "Running", value: formatCount(m.automationMetrics.runningWorkflowExecutions) },
    { key: "stuck", label: "Stuck", value: formatCount(orgHealth.stuckExecutionCount) },
    { key: "success-rate", label: "Success rate", value: formatRate(m.automationMetrics.automationSuccessRate) },
  ];

  const aiTypeEntries = Object.entries(org.aiInteractionsByType).sort(([, a], [, b]) => b - a);

  const dataQualityNotes = [
    "No payment infrastructure exists - every value figure is quoted/contracted, never confirmed collected money.",
    "leads.source is not standardized - source counts, where shown, are never ranked or labeled as best/worst.",
    "No stage-transition history exists - rates are current-state or activity-count metrics, never true historical conversion rates.",
    metrics.dataQuality.aiTokenUsageUnavailable ? "AI token usage unavailable - not populated by any automation path yet." : null,
  ].filter((note): note is string => note !== null);

  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <div>
        <Link href="/agency" className="text-xs text-slate-500 hover:text-slate-700 hover:underline">
          ← Agency Command Center
        </Link>
        <h1 className={`mt-2 ${pageTitleClass}`}>{org.organizationName}</h1>
        <p className={`mt-1.5 ${pageDescriptionClass}`}>
          {orgHealth.needsAttention ? "This organization currently needs attention." : "No operational issues detected."}
        </p>
      </div>

      <div className="border-t border-slate-200 pt-8">
        <p className={sectionLabelClass}>Business</p>
        <div className="mt-3">
          <StatGrid stats={businessStats} />
        </div>
      </div>

      <div className="border-t border-slate-200 pt-8">
        <p className={sectionLabelClass}>Estimates</p>
        <div className="mt-3">
          <StatGrid stats={estimateStats} />
        </div>
      </div>

      <div className="border-t border-slate-200 pt-8">
        <p className={sectionLabelClass}>Jobs</p>
        <div className="mt-3">
          <StatGrid stats={jobStats} />
        </div>
      </div>

      <div className="border-t border-slate-200 pt-8">
        <p className={sectionLabelClass}>Appointments</p>
        <div className="mt-3">
          <StatGrid stats={appointmentStats} />
        </div>
      </div>

      <div className="border-t border-slate-200 pt-8">
        <p className={sectionLabelClass}>Communication</p>
        <div className="mt-3">
          <StatGrid stats={communicationStats} columns="sm:grid-cols-3 lg:grid-cols-6" />
        </div>
      </div>

      <div className="border-t border-slate-200 pt-8">
        <p className={sectionLabelClass}>Automation health</p>
        <div className="mt-3">
          <StatGrid stats={automationStats} columns="sm:grid-cols-3 lg:grid-cols-6" />
        </div>
      </div>

      <div className="border-t border-slate-200 pt-8">
        <p className={sectionLabelClass}>AI activity</p>
        <div className="mt-3">
          <p className="text-xs text-slate-500">AI interactions</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-slate-900">{formatCount(m.aiMetrics.aiInteractions)}</p>
        </div>
        {aiTypeEntries.length > 0 ? (
          <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3">
            {aiTypeEntries.map(([type, count]) => (
              <div key={type}>
                <dt className="text-xs text-slate-500">{type}</dt>
                <dd className="mt-0.5 text-sm font-medium tabular-nums text-slate-900">{formatCount(count)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>

      <div className="border-t border-slate-200 pt-8">
        <p className={sectionLabelClass}>Data quality limitations</p>
        <ul className={`mt-3 list-inside list-disc space-y-1 ${metaClass}`}>
          {dataQualityNotes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

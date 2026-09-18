import Link from "next/link";
import {
  ArrowLeft,
  Building2,
  FileText,
  Briefcase,
  CalendarClock,
  MessageSquare,
  Workflow,
  Bot,
  Info,
  Users,
  Target,
  Wallet,
  Banknote,
  CheckCircle2,
  XCircle,
  Loader2,
  AlertTriangle,
  Percent,
  Ban,
  Send,
  Inbox as InboxIcon,
  Clock3,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getAgencyBusinessMetrics } from "@/lib/agency/queries";
import { getAgencyHealth } from "@/lib/agency/health";
import { formatCurrency } from "@/lib/dashboard/format";
import { formatRate, formatCount } from "../../_components/format";
import { StatGrid, type Stat } from "../../_components/stat-grid";
import { SectionCard } from "../../_components/section-card";
import { StatusPill } from "../../_components/status-pill";
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
      <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col px-4 py-5 sm:px-6 sm:py-6 lg:px-10">
        <ErrorState />
      </div>
    );
  }

  if (!metrics.ok || !health.ok) {
    return (
      <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col px-4 py-5 sm:px-6 sm:py-6 lg:px-10">
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
      <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col px-4 py-5 sm:px-6 sm:py-6 lg:px-10">
        <UnauthorizedState />
      </div>
    );
  }

  const { metrics: m } = org;

  const businessStats: Stat[] = [
    { key: "leads", label: "Leads", value: formatCount(m.leadMetrics.totalLeads), icon: Users },
    { key: "open-opportunities", label: "Open opportunities", value: formatCount(m.pipelineMetrics.openOpportunityCount), icon: Target },
    { key: "pipeline-value", label: "Pipeline value", value: formatCurrency(m.pipelineMetrics.pipelineValue), icon: Wallet },
    { key: "estimates", label: "Estimates", value: formatCount(m.estimateMetrics.totalEstimates), icon: FileText },
    { key: "jobs", label: "Jobs", value: formatCount(m.jobMetrics.totalJobs), icon: Briefcase },
    { key: "contracted-job-value", label: "Contracted job value", value: formatCurrency(m.jobMetrics.contractedJobValue), icon: Banknote },
  ];

  const estimateStats: Stat[] = [
    { key: "sent", label: "Sent", value: formatCount(m.estimateMetrics.sentEstimates), icon: Send },
    { key: "accepted", label: "Accepted", value: formatCount(m.estimateMetrics.acceptedEstimates), icon: CheckCircle2 },
    { key: "declined", label: "Declined", value: formatCount(m.estimateMetrics.declinedEstimates), icon: Ban },
    { key: "acceptance-rate", label: "Acceptance rate", value: formatRate(m.estimateMetrics.estimateAcceptanceRate), icon: Percent },
  ];

  const jobStats: Stat[] = [
    { key: "scheduled", label: "Scheduled", value: formatCount(m.jobMetrics.scheduledJobs), icon: Clock3 },
    { key: "in-progress", label: "In progress", value: formatCount(m.jobMetrics.inProgressJobs), icon: Loader2 },
    { key: "completed", label: "Completed", value: formatCount(m.jobMetrics.completedJobs), icon: CheckCircle2 },
    { key: "cancelled", label: "Cancelled", value: formatCount(m.jobMetrics.cancelledJobs), icon: Ban },
    { key: "completion-rate", label: "Completion rate", value: formatRate(m.jobMetrics.jobCompletionRate), icon: Percent },
  ];

  const appointmentStats: Stat[] = [
    { key: "total", label: "Total", value: formatCount(m.appointmentMetrics.totalAppointments), icon: CalendarClock },
    { key: "completed", label: "Completed", value: formatCount(m.appointmentMetrics.completedAppointments), icon: CheckCircle2 },
    { key: "cancelled", label: "Cancelled", value: formatCount(m.appointmentMetrics.cancelledAppointments), icon: Ban },
    { key: "no-show", label: "No-show", value: formatCount(m.appointmentMetrics.noShowAppointments), icon: XCircle },
    { key: "no-show-rate", label: "No-show rate", value: formatRate(m.appointmentMetrics.appointmentNoShowRate), icon: Percent },
  ];

  // BiCommunicationMetrics (Phase 5.2) only has inbound/outbound totals -
  // the full delivery-status breakdown (incl. "sent") comes from Phase
  // 5.1's raw byMessageStatus, already fetched as org.messagesByStatus.
  const communicationStats: Stat[] = [
    { key: "inbound", label: "Inbound", value: formatCount(m.communicationMetrics.inboundMessages), icon: InboxIcon },
    { key: "outbound", label: "Outbound", value: formatCount(m.communicationMetrics.outboundMessages), icon: Send },
    { key: "delivered", label: "Delivered", value: formatCount(org.messagesByStatus.delivered ?? 0), icon: CheckCircle2 },
    {
      key: "failed",
      label: "Failed",
      value: formatCount(org.messagesByStatus.failed ?? 0),
      icon: XCircle,
      tone: (org.messagesByStatus.failed ?? 0) > 0 ? "danger" : "default",
    },
    {
      key: "undelivered",
      label: "Undelivered",
      value: formatCount(org.messagesByStatus.undelivered ?? 0),
      icon: AlertTriangle,
      tone: (org.messagesByStatus.undelivered ?? 0) > 0 ? "warning" : "default",
    },
    { key: "queued", label: "Queued", value: formatCount(org.messagesByStatus.queued ?? 0), icon: Clock3 },
  ];

  const automationStats: Stat[] = [
    { key: "workflow-executions", label: "Executions", value: formatCount(m.automationMetrics.workflowExecutions), icon: Workflow },
    { key: "completed", label: "Completed", value: formatCount(m.automationMetrics.successfulWorkflowExecutions), icon: CheckCircle2 },
    {
      key: "failed",
      label: "Failed",
      value: formatCount(m.automationMetrics.failedWorkflowExecutions),
      icon: XCircle,
      tone: m.automationMetrics.failedWorkflowExecutions > 0 ? "danger" : "default",
    },
    { key: "running", label: "Running", value: formatCount(m.automationMetrics.runningWorkflowExecutions), icon: Loader2 },
    {
      key: "stuck",
      label: "Stuck",
      value: formatCount(orgHealth.stuckExecutionCount),
      icon: AlertTriangle,
      tone: orgHealth.stuckExecutionCount > 0 ? "warning" : "default",
    },
    { key: "success-rate", label: "Success rate", value: formatRate(m.automationMetrics.automationSuccessRate), icon: Percent },
  ];

  const aiTypeEntries = Object.entries(org.aiInteractionsByType).sort(([, a], [, b]) => b - a);

  const dataQualityNotes = [
    "No payment infrastructure exists - every value figure is quoted/contracted, never confirmed collected money.",
    "leads.source is not standardized - source counts, where shown, are never ranked or labeled as best/worst.",
    "No stage-transition history exists - rates are current-state or activity-count metrics, never true historical conversion rates.",
    metrics.dataQuality.aiTokenUsageUnavailable ? "AI token usage unavailable - not populated by any automation path yet." : null,
  ].filter((note): note is string => note !== null);

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 py-5 sm:px-6 sm:py-6 lg:px-10">
      <Link href="/agency" className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-700">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Agency Command Center
      </Link>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-900">
            <Building2 className="h-4 w-4 text-white" aria-hidden />
          </span>
          <h1 className="text-lg font-semibold tracking-tight text-slate-900">{org.organizationName}</h1>
        </div>
        {orgHealth.needsAttention ? <StatusPill tone="attention" label="Needs attention" /> : <StatusPill tone="healthy" label="Healthy" />}
      </div>

      <div className="mt-4 flex flex-col gap-3.5">
        <SectionCard title="Business" icon={Building2}>
          <StatGrid stats={businessStats} />
        </SectionCard>

        <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
          <SectionCard title="Estimates" icon={FileText}>
            <StatGrid stats={estimateStats} columns="sm:grid-cols-2 lg:grid-cols-4" />
          </SectionCard>

          <SectionCard title="Jobs" icon={Briefcase}>
            <StatGrid stats={jobStats} columns="sm:grid-cols-3 lg:grid-cols-5" />
          </SectionCard>
        </div>

        <SectionCard title="Appointments" icon={CalendarClock}>
          <StatGrid stats={appointmentStats} columns="sm:grid-cols-3 lg:grid-cols-5" />
        </SectionCard>

        <SectionCard title="Communication" icon={MessageSquare}>
          <StatGrid stats={communicationStats} columns="sm:grid-cols-3 lg:grid-cols-6" />
        </SectionCard>

        <SectionCard title="Automation health" icon={Workflow}>
          <StatGrid stats={automationStats} columns="sm:grid-cols-3 lg:grid-cols-6" />
        </SectionCard>

        <SectionCard title="AI activity" icon={Bot}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2">
              <p className="text-[10.5px] font-medium uppercase tracking-wide text-slate-500">AI interactions</p>
              <p className="mt-0.5 text-xl font-semibold tracking-tight tabular-nums text-slate-900">{formatCount(m.aiMetrics.aiInteractions)}</p>
            </div>
            {aiTypeEntries.length > 0 ? (
              <dl className="flex flex-1 flex-wrap gap-x-5 gap-y-1.5">
                {aiTypeEntries.map(([type, count]) => (
                  <div key={type} className="min-w-[8rem]">
                    <dt className="text-xs text-slate-500">{type}</dt>
                    <dd className="mt-0.5 text-sm font-semibold tabular-nums text-slate-900">{formatCount(count)}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>
        </SectionCard>

        <SectionCard title="Data quality limitations" icon={Info}>
          <ul className="space-y-1.5 text-xs text-slate-500">
            {dataQualityNotes.map((note) => (
              <li key={note} className="flex gap-2">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-300" aria-hidden />
                {note}
              </li>
            ))}
          </ul>
        </SectionCard>
      </div>
    </div>
  );
}

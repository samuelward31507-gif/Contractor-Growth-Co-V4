import Link from "next/link";
import { ArrowLeft, AlertTriangle, CheckCircle2, Circle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getAgencyBusinessMetrics } from "@/lib/agency/queries";
import { getAgencyHealth } from "@/lib/agency/health";
import { getAgencyOperationsToday } from "@/lib/agency/operations";
import { getAgencyEscalatedConversations } from "@/lib/agency/communication";
import { getAgencyOrganizationAutomations } from "@/lib/agency/automations";
import { getAgencyNeedsAttentionItems } from "@/lib/agency/needs-attention";
import { listIncidents } from "@/lib/automation-health/queries";
import { getDashboardData } from "@/lib/dashboard/queries";
import { computeSetupChecklist, ONBOARDING_STAGE_LABEL, type OnboardingStage } from "@/lib/onboarding/checklist";
import { getBusinessProfile, getServiceAreas } from "@/lib/settings/queries";
import { formatCurrency, formatRelativeTime } from "@/lib/dashboard/format";
import { Badge, type BadgeTone } from "@/lib/ui/badge";
import { pageTitleClass, sectionLabelClass, metaClass, statLabelClass, statValueClass } from "@/lib/ui/typography";
import { Row, RowGroup } from "../../_components/row";
import { formatRate, formatCount } from "../../_components/format";
import { UnauthorizedState } from "../../_components/unauthorized-state";
import { ErrorState } from "../../_components/error-state";
import { NeedsAttention } from "../../_components/needs-attention";
import { AutomationsPanel } from "../../_components/automations-panel";
import { AutomationPauseControl } from "./_components/automation-pause-control";

const STAGE_TONE: Record<OnboardingStage, BadgeTone> = {
  new: "neutral",
  configuring: "warning",
  testing: "info",
  ready: "info",
  live: "success",
};

/**
 * Agency Command Center UI review: the operational detail page for one
 * managed client, restructured around the information hierarchy Phase 5
 * asks for (identity/status, readiness, configuration, automation,
 * communication, recent activity, operational detail) - via the same
 * typography/divider system as the redesigned overview page, replacing the
 * old stack of bordered SectionCard/StatGrid boxes. Every figure is still
 * read from the exact same already-authorized backend
 * (lib/agency/queries.ts, lib/agency/health.ts, lib/onboarding/checklist.ts,
 * lib/settings/queries.ts) plus one org-scoped getDashboardData call for
 * recent activity - the same function the client dashboard itself calls,
 * reused here for a real (not fabricated) activity feed. No authorization
 * logic changed: an organization id not present in this agency's own
 * resolved list still renders UnauthorizedState, never confirming or
 * denying whether it exists.
 */
export default async function AgencyOrganizationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const supabase = await createClient();
  const service = createServiceRoleClient();

  let metrics: Awaited<ReturnType<typeof getAgencyBusinessMetrics>>;
  let health: Awaited<ReturnType<typeof getAgencyHealth>>;
  let today: Awaited<ReturnType<typeof getAgencyOperationsToday>>;
  let escalations: Awaited<ReturnType<typeof getAgencyEscalatedConversations>>;
  let automations: Awaited<ReturnType<typeof getAgencyOrganizationAutomations>>;
  let needsAttention: Awaited<ReturnType<typeof getAgencyNeedsAttentionItems>>;

  try {
    [metrics, health, today, escalations, automations, needsAttention] = await Promise.all([
      getAgencyBusinessMetrics(supabase, service),
      getAgencyHealth(supabase, service),
      getAgencyOperationsToday(supabase, service),
      getAgencyEscalatedConversations(supabase, service),
      getAgencyOrganizationAutomations(supabase, service, id),
      getAgencyNeedsAttentionItems(supabase, service),
    ]);
  } catch {
    return (
      <div className="mx-auto flex w-full max-w-[1100px] flex-1 flex-col px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
        <ErrorState />
      </div>
    );
  }

  if (!metrics.ok || !health.ok || !today.ok || !escalations.ok || !needsAttention.ok) {
    return (
      <div className="mx-auto flex w-full max-w-[1100px] flex-1 flex-col px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
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
  if (!org || !orgHealth || !automations.ok) {
    return (
      <div className="mx-auto flex w-full max-w-[1100px] flex-1 flex-col px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
        <UnauthorizedState />
      </div>
    );
  }

  const orgToday = today.byOrg.get(id);
  const escalationCount = escalations.countByOrg.get(id) ?? 0;
  const clientNeedsAttention = needsAttention.items.filter((item) => item.organizationId === id);

  // Only reached once `id` is confirmed to be one of THIS agency's own
  // already-authorized organizations (the check immediately above) - never
  // a second, independent authorization path. Uses the service-role client
  // like every other agency read on this page.
  const [incidents, checklist, profile, serviceAreas, dashboardData, automationPauseRow] = await Promise.all([
    listIncidents(service, id, { status: ["open", "acknowledged"] }),
    computeSetupChecklist(service, id),
    getBusinessProfile(service, id),
    getServiceAreas(service, id),
    getDashboardData(service, id),
    // Launch Blocker #5: not yet part of getAgencyBusinessMetrics's snapshot
    // shape - read directly here, the same way profile/serviceAreas/
    // dashboardData already are, scoped to this same already-authorized `id`.
    service.from("organizations").select("automation_paused").eq("id", id).maybeSingle(),
  ]);
  // Fail closed on a read error too, not only a true value - an org whose
  // pause state couldn't be confirmed is shown (and, via outbound-gate,
  // enforced) as paused, never silently assumed to be running.
  const isAutomationPaused = automationPauseRow.error ? true : Boolean(automationPauseRow.data?.automation_paused);
  const { readiness, testLeadOutcome } = checklist;
  const { metrics: m } = org;
  const missingItems = checklist.items.filter((item) => !item.complete);

  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link href="/agency" className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-700">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          Agency Command Center
        </Link>
        <span className="text-xs text-slate-300">·</span>
        <Link href="/dashboard" className="text-xs font-medium text-slate-500 hover:text-slate-700">
          Back to Trackpr
        </Link>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className={sectionLabelClass}>Client</p>
          <h1 className={`mt-1.5 ${pageTitleClass}`}>{org.organizationName}</h1>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={STAGE_TONE[checklist.stage]}>{ONBOARDING_STAGE_LABEL[checklist.stage]}</Badge>
          {orgHealth.needsAttention ? (
            <Badge tone="danger" icon={AlertTriangle}>Needs attention</Badge>
          ) : (
            <Badge tone="success" icon={CheckCircle2}>Healthy</Badge>
          )}
        </div>
      </div>

      <div className="mt-4">
        <AutomationPauseControl organizationId={id} isPaused={isAutomationPaused} />
      </div>

      {clientNeedsAttention.length > 0 ? (
        <div className="mt-8">
          <NeedsAttention items={clientNeedsAttention} />
        </div>
      ) : null}

      {/* Today + Live activity - what changed, surfaced immediately after
          what needs action and how healthy the client is, before any of the
          slower-moving setup/business detail below. Today's two numbers get
          the same large stat treatment as a dashboard KPI (not a Row) since
          this is meant to be read at a glance, not scanned in a list. */}
      <div className="mt-8 grid grid-cols-1 gap-8 border-t border-slate-200 pt-8 sm:grid-cols-[auto_1fr]">
        <div className="flex gap-8 sm:shrink-0">
          <div>
            <p className={statLabelClass}>Leads today</p>
            <p className={statValueClass}>{formatCount(orgToday?.leadsToday ?? 0)}</p>
          </div>
          <div>
            <p className={statLabelClass}>Appointments today</p>
            <p className={statValueClass}>{formatCount(orgToday?.appointmentsToday ?? 0)}</p>
          </div>
        </div>
        <div className="sm:border-l sm:border-slate-200 sm:pl-8">
          <p className={sectionLabelClass}>Live activity</p>
          {dashboardData.recentActivity.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">No activity yet for this client.</p>
          ) : (
            <ul className="mt-2 divide-y divide-slate-100">
              {dashboardData.recentActivity.slice(0, 5).map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-4 py-1.5">
                  <span className="min-w-0 truncate text-sm text-slate-700">{item.message}</span>
                  <span className="shrink-0 text-xs tabular-nums text-slate-400">{formatRelativeTime(item.timestamp)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Automation + Communication - operational status side by side. */}
      <div className="mt-8 grid grid-cols-1 gap-8 border-t border-slate-200 pt-8 sm:grid-cols-2">
        <RowGroup label="Automation">
          <Row label="Executions" value={formatCount(m.automationMetrics.workflowExecutions)} />
          <Row label="Completed" value={formatCount(m.automationMetrics.successfulWorkflowExecutions)} tone={m.automationMetrics.successfulWorkflowExecutions > 0 ? "success" : "default"} />
          <Row label="Failed" value={formatCount(m.automationMetrics.failedWorkflowExecutions)} tone={m.automationMetrics.failedWorkflowExecutions > 0 ? "danger" : "default"} />
          <Row label="Running" value={formatCount(m.automationMetrics.runningWorkflowExecutions)} />
          <Row label="Stuck" value={formatCount(orgHealth.stuckExecutionCount)} tone={orgHealth.stuckExecutionCount > 0 ? "warning" : "default"} />
          <Row label="Success rate" value={formatRate(m.automationMetrics.automationSuccessRate)} />
        </RowGroup>
        <RowGroup label="Communication">
          <Row label="Inbound" value={formatCount(m.communicationMetrics.inboundMessages)} />
          <Row label="Outbound" value={formatCount(m.communicationMetrics.outboundMessages)} />
          <Row label="Delivered" value={formatCount(org.messagesByStatus.delivered ?? 0)} />
          <Row label="Failed" value={formatCount(org.messagesByStatus.failed ?? 0)} tone={(org.messagesByStatus.failed ?? 0) > 0 ? "danger" : "default"} />
          <Row label="Undelivered" value={formatCount(org.messagesByStatus.undelivered ?? 0)} tone={(org.messagesByStatus.undelivered ?? 0) > 0 ? "warning" : "default"} />
          <Row label="Queued" value={formatCount(org.messagesByStatus.queued ?? 0)} />
          <Row
            label="AI escalations waiting"
            value={escalationCount > 0 ? formatCount(escalationCount) : "None"}
            tone={escalationCount > 0 ? "warning" : "default"}
            description={escalationCount > 0 ? "AI is paused on these conversations until a human replies." : undefined}
          />
        </RowGroup>
      </div>

      {/* Automations - real, per-automation operational state (excludes the
          internal safe-AI safety layer, which is never independently
          triggered). Never invents an automation that isn't in
          AUTOMATION_CATALOG. */}
      <div className="mt-8 border-t border-slate-200 pt-8">
        <p className={sectionLabelClass}>Automations</p>
        <AutomationsPanel automations={automations.automations} />
      </div>

      {/* Client + Setup - identity and configuration status side by side, the
          two things "is this client configured" is actually made of. Secondary
          business/CRM-style detail from here down - operational state and
          what changed already surfaced above. */}
      <div className="mt-8 grid grid-cols-1 gap-8 border-t border-slate-200 pt-8 sm:grid-cols-2">
        <RowGroup label="Client">
          <Row label="Owner / contact" value={profile?.owner_name ?? "Not set"} />
          <Row label="Trade" value={profile?.trade ?? "Not set"} />
          <Row label="Service area" value={serviceAreas.length > 0 ? serviceAreas.map((a) => a.name).join(", ") : "Not set"} />
        </RowGroup>
        <RowGroup label="Setup">
          <Row label="Business hours" value={readiness.items.find((i) => i.key === "hours")?.complete ? "Configured" : "Not configured"} />
          <Row label="SMS" value={readiness.items.find((i) => i.key === "sms")?.complete ? "Configured" : "Not configured"} />
          <Row label="Lead capture" value={readiness.items.find((i) => i.key === "leadCapture")?.complete ? "Ready" : "Unavailable"} />
          <Row label="AI review" value={readiness.items.find((i) => i.key === "ai")?.complete ? "Reviewed" : "Not reviewed"} />
          <Row label="Automation mode" value={readiness.automationMode === "live" ? "Live" : "Test"} tone={readiness.automationMode === "live" ? "success" : "default"} />
        </RowGroup>
      </div>

      {/* Readiness - what's still blocking Go Live, if anything. */}
      <div className="mt-8 border-t border-slate-200 pt-8">
        <p className={sectionLabelClass}>Readiness</p>
        {missingItems.length === 0 ? (
          <p className="mt-2 text-sm text-accent-text">Everything required is complete.</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-100">
            {missingItems.map((item) => (
              <li key={item.key} className="flex items-center gap-2.5 py-1.5">
                <Circle className="h-3.5 w-3.5 shrink-0 text-slate-300" aria-hidden />
                <p className="text-sm text-slate-700">{item.label}</p>
              </li>
            ))}
          </ul>
        )}
        {readiness.status !== "live" ? (
          <p className={`mt-2 ${metaClass}`}>Go Live is blocked until business profile, business hours, and SMS routing are all configured.</p>
        ) : null}
      </div>

      {/* Test - the real, most recent onboarding test-lead outcome. */}
      <div className="mt-8 border-t border-slate-200 pt-8">
        <p className={sectionLabelClass}>Test</p>
        {testLeadOutcome ? (
          <div className="mt-2 space-y-1 text-sm text-slate-700">
            <p>Last run {new Date(testLeadOutcome.createdAt).toLocaleString()}.</p>
            <p>
              {testLeadOutcome.executionStatus === "completed" && (testLeadOutcome.blockedReason === null || testLeadOutcome.blockedReason === "organization_not_live")
                ? "Automation response confirmed working."
                : testLeadOutcome.executionStatus === "completed" && testLeadOutcome.blockedReason
                  ? `Response held back (${testLeadOutcome.blockedReason.replace(/_/g, " ")}).`
                  : "Still in progress or the automation service was unavailable when last checked."}
            </p>
          </div>
        ) : (
          <p className="mt-2 text-sm text-slate-500">No test has been attempted yet.</p>
        )}
      </div>

      {/* Active incidents - kept as its own list, already the right shape. */}
      <div className="mt-8 border-t border-slate-200 pt-8">
        <div className="flex items-baseline justify-between">
          <p className={sectionLabelClass}>Active incidents</p>
          <span className={metaClass}>{incidents.length} open or acknowledged</span>
        </div>
        {incidents.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No active operational incidents for this organization.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100">
            {incidents.map((incident) => (
              <li key={incident.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div>
                  <p className="text-sm font-medium text-slate-900">{incident.title}</p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    First seen {new Date(incident.firstSeenAt).toLocaleString()} · {formatCount(incident.occurrenceCount)} occurrence{incident.occurrenceCount === 1 ? "" : "s"}
                  </p>
                </div>
                <Badge tone={incident.severity === "critical" ? "danger" : incident.severity === "warning" ? "warning" : "neutral"}>{incident.severity}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Operational detail - business/estimate/job/appointment/AI figures,
          grouped as reference rows rather than six separate card walls. */}
      <div className="mt-8 grid grid-cols-1 gap-8 border-t border-slate-200 pt-8 sm:grid-cols-2">
        <RowGroup label="Business">
          <Row label="Leads" value={formatCount(m.leadMetrics.totalLeads)} />
          <Row label="Open opportunities" value={formatCount(m.pipelineMetrics.openOpportunityCount)} />
          <Row label="Pipeline value" value={formatCurrency(m.pipelineMetrics.pipelineValue)} />
          <Row label="Contracted job value" value={formatCurrency(m.jobMetrics.contractedJobValue)} />
        </RowGroup>
        <RowGroup label="Estimates">
          <Row label="Sent" value={formatCount(m.estimateMetrics.sentEstimates)} />
          <Row label="Accepted" value={formatCount(m.estimateMetrics.acceptedEstimates)} tone="success" />
          <Row label="Declined" value={formatCount(m.estimateMetrics.declinedEstimates)} />
          <Row label="Acceptance rate" value={formatRate(m.estimateMetrics.estimateAcceptanceRate)} />
        </RowGroup>
        <RowGroup label="Jobs">
          <Row label="Scheduled" value={formatCount(m.jobMetrics.scheduledJobs)} />
          <Row label="In progress" value={formatCount(m.jobMetrics.inProgressJobs)} />
          <Row label="Completed" value={formatCount(m.jobMetrics.completedJobs)} tone="success" />
          <Row label="Cancelled" value={formatCount(m.jobMetrics.cancelledJobs)} />
          <Row label="Completion rate" value={formatRate(m.jobMetrics.jobCompletionRate)} />
        </RowGroup>
        <RowGroup label="Appointments">
          <Row label="Total" value={formatCount(m.appointmentMetrics.totalAppointments)} />
          <Row label="Completed" value={formatCount(m.appointmentMetrics.completedAppointments)} tone="success" />
          <Row label="Cancelled" value={formatCount(m.appointmentMetrics.cancelledAppointments)} />
          <Row label="No-show" value={formatCount(m.appointmentMetrics.noShowAppointments)} />
          <Row label="No-show rate" value={formatRate(m.appointmentMetrics.appointmentNoShowRate)} />
        </RowGroup>
      </div>

      {Object.keys(org.aiInteractionsByType).length > 0 ? (
        <div className="mt-8 border-t border-slate-200 pt-8">
          <RowGroup label="AI activity">
            <Row label="Total interactions" value={formatCount(m.aiMetrics.aiInteractions)} />
            {Object.entries(org.aiInteractionsByType)
              .sort(([, a], [, b]) => b - a)
              .map(([type, count]) => (
                <Row key={type} label={type} value={formatCount(count)} />
              ))}
          </RowGroup>
        </div>
      ) : null}

      <div className="mt-8 border-t border-slate-200 pt-8">
        <p className={sectionLabelClass}>Data quality</p>
        <ul className="mt-2 space-y-1.5 text-xs text-slate-500">
          <li className="flex gap-2">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-300" aria-hidden />
            No payment infrastructure exists - every value figure is quoted/contracted, never confirmed collected money.
          </li>
          <li className="flex gap-2">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-300" aria-hidden />
            leads.source is not standardized - source counts, where shown, are never ranked or labeled as best/worst.
          </li>
          <li className="flex gap-2">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-300" aria-hidden />
            No stage-transition history exists - rates are current-state or activity-count metrics, never true historical conversion rates.
          </li>
          {metrics.dataQuality.aiTokenUsageUnavailable ? (
            <li className="flex gap-2">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-300" aria-hidden />
              AI token usage unavailable - not populated by any automation path yet.
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}

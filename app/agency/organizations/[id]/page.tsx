import Link from "next/link";
import type { ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  Building,
  CalendarDays,
  ChartColumn,
  CheckCircle2,
  Circle,
  FlaskConical,
  Info,
  ListChecks,
  MessageSquare,
  Settings2,
  ShieldAlert,
  Sparkles,
  UserPlus,
  Workflow,
} from "lucide-react";
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
import { DetailHeader } from "@/lib/ui/detail-header";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";
import { StatGrid, StatCard } from "@/lib/ui/stat-card";
import { SectionCard, Panel } from "@/lib/ui/section-card";
import { StatusLabel, type StatusDotTone } from "@/lib/ui/status-dot";
import { detailLabelClass, detailValueClass, metaClass, subsectionTitleClass } from "@/lib/ui/typography";
import { formatRate, formatCount } from "../../_components/format";
import { UnauthorizedState } from "../../_components/unauthorized-state";
import { NeedsAttention } from "../../_components/needs-attention";
import { AutomationPauseControl } from "./_components/automation-pause-control";
import { MetricList, Row, type RowTone } from "./_components/metric-rows";
import { SectionEmpty } from "./_components/section-empty";
import { AutomationsTable } from "./_components/automations-table";
import { IncidentsTable } from "./_components/incidents-table";
import { StatePage, ClientUnavailableState, ClientLoadErrorState } from "./_components/page-states";

const STAGE_TONE: Record<OnboardingStage, BadgeTone> = {
  new: "neutral",
  configuring: "warning",
  testing: "info",
  ready: "info",
  live: "success",
};

/**
 * Growth System Completion Pass 1: the three-way booking/calendar readiness
 * state (lib/onboarding/readiness.ts) rendered as a short, distinct label -
 * never collapsed back down to a plain complete/incomplete boolean, so a
 * founder can immediately tell "not configured, needs attention" apart from
 * "configured and intentionally off".
 */
function readinessStateLabel(state: "ready" | "not_ready" | "disabled_by_intent" | undefined): string {
  if (state === "ready") return "Ready";
  if (state === "disabled_by_intent") return "Off by choice";
  return "Not ready";
}

/**
 * Growth System Completion Pass 2, Part 9: founder/admin-only, read-only
 * display of organizations.payment_status - see AgencyPaymentStatus's own
 * documentation in lib/agency/health.ts for why there is no write path here
 * to weaken. "payment_required" is labeled neutrally (not a danger tone) -
 * it is the normal state for an organization still in onboarding, before its
 * first payment, not itself a regression.
 */
const PAYMENT_STATUS_LABEL: Record<string, string> = {
  payment_required: "Payment required",
  active: "Active",
  suspended: "Suspended",
  cancelled: "Cancelled",
};

const PAYMENT_STATUS_TONE: Record<string, RowTone> = {
  payment_required: "default",
  active: "success",
  suspended: "danger",
  cancelled: "danger",
};

/** One label/value pair of the Client card - the same dl grammar the client app's detail pages use (app/(app)/estimates/[id]/page.tsx). */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className={detailLabelClass}>{label}</dt>
      <dd className={`${detailValueClass} break-words`}>{children}</dd>
    </div>
  );
}

function DataQualityNote({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-line-strong" aria-hidden />
      <span>{children}</span>
    </li>
  );
}

/**
 * Agency client detail (design-system pass): the operational detail page
 * for one managed client, moved onto the client app's detail-page system -
 * DetailHeader (back link, name, status badges, the automation kill switch
 * as the header action), the standard page container, a StatGrid for the
 * at-a-glance numbers, and SectionCards for every grouped section. Every
 * figure is still read from the exact same already-authorized backend
 * (lib/agency/queries.ts, lib/agency/health.ts, lib/onboarding/checklist.ts,
 * lib/settings/queries.ts) plus one org-scoped getDashboardData call for
 * recent activity - the same function the client dashboard itself calls,
 * reused here for a real (not fabricated) activity feed. No authorization
 * logic changed: a caller who is not an agency admin still renders
 * UnauthorizedState, and an organization id not present in this agency's
 * own resolved list renders one neutral "not available" state that never
 * confirms or denies whether it exists.
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
      <StatePage>
        <ClientLoadErrorState />
      </StatePage>
    );
  }

  if (!metrics.ok || !health.ok || !today.ok || !escalations.ok || !needsAttention.ok) {
    return (
      <StatePage>
        <UnauthorizedState />
      </StatePage>
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
      <StatePage>
        <ClientUnavailableState />
      </StatePage>
    );
  }

  const orgToday = today.byOrg.get(id);
  // Phase 3E: null when the escalation read failed - never "None".
  const escalationCount = escalations.failed ? null : (escalations.countByOrg.get(id) ?? 0);
  const clientNeedsAttention = needsAttention.items.filter((item) => item.organizationId === id);
  // Phase 3E: the same distinct-client set the Agency header counts.
  const clientInAttention = needsAttention.attentionOrganizationIds.includes(id);
  const aiUnavailable = org.metrics.aiUnavailable || org.aiFailed;
  // Phase 3E: any read behind this client's figures that failed is disclosed, never shown as a clean page of zeros.
  const clientPartialData =
    org.metrics.partialData ||
    org.metrics.reviewReferralUnavailable ||
    aiUnavailable ||
    orgHealth.communicationUnavailable ||
    orgHealth.automationUnavailable ||
    orgHealth.incidentsUnavailable ||
    escalations.failed;

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

  // Presentation only: the same three test-lead outcomes the page has always distinguished, each now with a status label.
  const testOutcome: { tone: StatusDotTone; label: string; detail: string } | null = testLeadOutcome
    ? testLeadOutcome.executionStatus === "completed" && (testLeadOutcome.blockedReason === null || testLeadOutcome.blockedReason === "organization_not_live")
      ? { tone: "healthy", label: "Working", detail: "Automation response confirmed working." }
      : testLeadOutcome.executionStatus === "completed" && testLeadOutcome.blockedReason
        ? { tone: "attention", label: "Held back", detail: `Response held back (${testLeadOutcome.blockedReason.replace(/_/g, " ")}).` }
        : { tone: "neutral", label: "Not confirmed", detail: "Still in progress or the automation service was unavailable when last checked." }
    : null;

  const bookingState = readiness.items.find((i) => i.key === "booking")?.state;
  const calendarState = readiness.items.find((i) => i.key === "calendar")?.state;
  // An empty incident list is only a confirmed zero when the health read could read incidents.
  const incidentsUnreadable = orgHealth.incidentsUnavailable && incidents.length === 0;

  return (
    <div className="flex flex-1 flex-col">
      <DetailHeader
        eyebrow="Client"
        backHref="/agency"
        backLabel="Back to Agency Command Center"
        title={org.organizationName}
        badges={
          <>
            <Badge tone={STAGE_TONE[checklist.stage]}>{ONBOARDING_STAGE_LABEL[checklist.stage]}</Badge>
            {clientInAttention ? (
              <Badge tone="danger" icon={AlertTriangle}>Needs attention</Badge>
            ) : (
              <Badge tone="success" icon={CheckCircle2}>Healthy</Badge>
            )}
          </>
        }
        action={<AutomationPauseControl organizationId={id} isPaused={isAutomationPaused} />}
      />

      <div className={`${PAGE_CONTAINER_CLASS} gap-6 ${PAGE_MAX_WIDTH_CLASS}`}>
        {clientPartialData ? (
          <div role="status" className="flex items-start gap-2.5 rounded-xl border border-warning-border bg-warning-muted px-4 py-2.5 text-sm text-warning-text">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <p>Some information for this client is temporarily unavailable. Figures marked Unavailable or &ldquo;—&rdquo; could not be read - they are not zero.</p>
          </div>
        ) : null}

        {/* At a glance - every number is a real read; one that could not be read shows "—", never 0. */}
        <StatGrid columns={4}>
          <StatCard label="Leads today" value={orgToday ? formatCount(orgToday.leadsToday) : "—"} description={orgToday ? undefined : "Couldn't be read"} icon={UserPlus} />
          <StatCard label="Appointments today" value={orgToday ? formatCount(orgToday.appointmentsToday) : "—"} description={orgToday ? undefined : "Couldn't be read"} icon={CalendarDays} />
          <StatCard
            label="Active incidents"
            value={incidentsUnreadable ? "—" : formatCount(incidents.length)}
            description={incidentsUnreadable ? "Couldn't be read" : "Open or acknowledged"}
            tone={incidents.some((incident) => incident.severity === "critical") ? "danger" : incidents.length > 0 ? "warning" : "neutral"}
            icon={ShieldAlert}
          />
          <StatCard
            label="AI escalations waiting"
            value={escalationCount === null ? "—" : formatCount(escalationCount)}
            description={escalationCount === null ? "Couldn't be read" : escalationCount > 0 ? "AI paused until a human replies" : "None waiting"}
            tone={escalationCount !== null && escalationCount > 0 ? "warning" : "neutral"}
            icon={MessageSquare}
          />
        </StatGrid>

        {clientNeedsAttention.length > 0 ? (
          <Panel>
            <NeedsAttention items={clientNeedsAttention} />
          </Panel>
        ) : null}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:gap-8">
          <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
            <SectionCard title="Live activity" description="The latest events in this client's workspace." icon={Activity}>
              {dashboardData.recentActivity.length === 0 ? (
                <SectionEmpty
                  title="No activity yet for this client."
                  description={
                    dashboardData.partialData
                      ? "Some activity sources couldn't be read, so this may not be a confirmed empty feed."
                      : "New leads, appointments and changes appear here as they happen."
                  }
                />
              ) : (
                <>
                  <ul className="divide-y divide-line">
                    {dashboardData.recentActivity.slice(0, 5).map((item) => (
                      <li key={item.id} className="flex items-start justify-between gap-4 py-2.5">
                        <span className="min-w-0 break-words text-sm text-ink-2">{item.message}</span>
                        <span className="shrink-0 text-xs tabular-nums text-ink-3">{formatRelativeTime(item.timestamp)}</span>
                      </li>
                    ))}
                  </ul>
                  {dashboardData.partialData ? <p className={`mt-2 ${metaClass}`}>Some activity sources couldn&apos;t be read, so this list may be incomplete.</p> : null}
                </>
              )}
            </SectionCard>

            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <SectionCard title="Automation" description="Workflow executions." icon={Workflow}>
                <MetricList>
                  {/* Phase 2K: unreadable execution counts show as Unavailable, never as zeros. Stuck has its own read. */}
                  {org.automationFailed ? (
                    <>
                      {["Executions", "Completed", "Failed", "Running"].map((label) => (
                        <Row key={label} label={label} value="Unavailable" tone="warning" />
                      ))}
                    </>
                  ) : (
                    <>
                      <Row label="Executions" value={formatCount(m.automationMetrics.workflowExecutions)} />
                      <Row label="Completed" value={formatCount(m.automationMetrics.successfulWorkflowExecutions)} tone={m.automationMetrics.successfulWorkflowExecutions > 0 ? "success" : "default"} />
                      <Row label="Failed" value={formatCount(m.automationMetrics.failedWorkflowExecutions)} tone={m.automationMetrics.failedWorkflowExecutions > 0 ? "danger" : "default"} />
                      <Row label="Running" value={formatCount(m.automationMetrics.runningWorkflowExecutions)} />
                    </>
                  )}
                  <Row label="Stuck" value={formatCount(orgHealth.stuckExecutionCount)} tone={orgHealth.stuckExecutionCount > 0 ? "warning" : "default"} />
                  {org.automationFailed ? <Row label="Success rate" value="Unavailable" tone="warning" /> : <Row label="Success rate" value={formatRate(m.automationMetrics.automationSuccessRate)} />}
                </MetricList>
              </SectionCard>

              <SectionCard title="Communication" description="Messages sent and received." icon={MessageSquare}>
                <MetricList>
                  {/* Phase 2J: unreadable message counts show as Unavailable, never as zeros. */}
                  {org.communicationFailed ? (
                    <>
                      {["Inbound", "Outbound", "Delivered", "Failed", "Undelivered", "Queued"].map((label) => (
                        <Row key={label} label={label} value="Unavailable" tone="warning" />
                      ))}
                    </>
                  ) : (
                    <>
                      <Row label="Inbound" value={formatCount(m.communicationMetrics.inboundMessages)} />
                      <Row label="Outbound" value={formatCount(m.communicationMetrics.outboundMessages)} />
                      <Row label="Delivered" value={formatCount(org.messagesByStatus.delivered ?? 0)} />
                      <Row label="Failed" value={formatCount(org.messagesByStatus.failed ?? 0)} tone={(org.messagesByStatus.failed ?? 0) > 0 ? "danger" : "default"} />
                      <Row label="Undelivered" value={formatCount(org.messagesByStatus.undelivered ?? 0)} tone={(org.messagesByStatus.undelivered ?? 0) > 0 ? "warning" : "default"} />
                      <Row label="Queued" value={formatCount(org.messagesByStatus.queued ?? 0)} />
                    </>
                  )}
                  {escalationCount === null ? (
                    <Row label="AI escalations waiting" value="Unavailable" tone="warning" />
                  ) : (
                    <Row
                      label="AI escalations waiting"
                      value={escalationCount > 0 ? formatCount(escalationCount) : "None"}
                      tone={escalationCount > 0 ? "warning" : "default"}
                      description={escalationCount > 0 ? "AI is paused on these conversations until a human replies." : undefined}
                    />
                  )}
                </MetricList>
              </SectionCard>
            </div>

            {/* Automations - real, per-automation operational state (excludes the
                internal safe-AI safety layer, which is never independently
                triggered). Never invents an automation that isn't in
                AUTOMATION_CATALOG. */}
            <SectionCard title="Automations" description="Each automation's current health." icon={Bot}>
              <AutomationsTable automations={automations.automations} />
            </SectionCard>

            <SectionCard
              title="Active incidents"
              description="Open or acknowledged operational incidents."
              icon={ShieldAlert}
              action={<span className={`shrink-0 text-right ${metaClass}`}>{incidentsUnreadable ? "Unavailable" : `${incidents.length} open or acknowledged`}</span>}
            >
              <IncidentsTable incidents={incidents} unavailable={orgHealth.incidentsUnavailable} />
            </SectionCard>

            {/* Operational detail - business/estimate/job/appointment figures, grouped as reference rows inside one card. */}
            <SectionCard title="Business performance" description="Pipeline, estimates, jobs and appointments." icon={ChartColumn}>
              <div className="grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2">
                <MetricList label="Business">
                  <Row label="Leads" value={formatCount(m.leadMetrics.totalLeads)} />
                  <Row label="Open opportunities" value={formatCount(m.pipelineMetrics.openOpportunityCount)} />
                  <Row label="Pipeline value" value={formatCurrency(m.pipelineMetrics.pipelineValue)} />
                  <Row label="Contracted job value" value={formatCurrency(m.jobMetrics.contractedJobValue)} />
                </MetricList>
                <MetricList label="Estimates">
                  <Row label="Sent" value={formatCount(m.estimateMetrics.sentEstimates)} />
                  <Row label="Accepted" value={formatCount(m.estimateMetrics.acceptedEstimates)} tone="success" />
                  <Row label="Declined" value={formatCount(m.estimateMetrics.declinedEstimates)} />
                  <Row label="Acceptance rate" value={formatRate(m.estimateMetrics.estimateAcceptanceRate)} />
                </MetricList>
                <MetricList label="Jobs">
                  <Row label="Scheduled" value={formatCount(m.jobMetrics.scheduledJobs)} />
                  <Row label="In progress" value={formatCount(m.jobMetrics.inProgressJobs)} />
                  <Row label="Completed" value={formatCount(m.jobMetrics.completedJobs)} tone="success" />
                  <Row label="Cancelled" value={formatCount(m.jobMetrics.cancelledJobs)} />
                  <Row label="Completion rate" value={formatRate(m.jobMetrics.jobCompletionRate)} />
                </MetricList>
                <MetricList label="Appointments">
                  <Row label="Total" value={formatCount(m.appointmentMetrics.totalAppointments)} />
                  <Row label="Completed" value={formatCount(m.appointmentMetrics.completedAppointments)} tone="success" />
                  <Row label="Cancelled" value={formatCount(m.appointmentMetrics.cancelledAppointments)} />
                  <Row label="No-show" value={formatCount(m.appointmentMetrics.noShowAppointments)} />
                  <Row label="No-show rate" value={formatRate(m.appointmentMetrics.appointmentNoShowRate)} />
                </MetricList>
              </div>
            </SectionCard>

            {/* Phase 3E: a failed AI read keeps the section, marked Unavailable - never hidden as if there were no AI activity. */}
            <SectionCard title="AI activity" description="AI interactions recorded for this client." icon={Sparkles}>
              {aiUnavailable ? (
                <MetricList>
                  <Row label="Total interactions" value="Unavailable" tone="warning" />
                </MetricList>
              ) : Object.keys(org.aiInteractionsByType).length > 0 ? (
                <MetricList>
                  <Row label="Total interactions" value={formatCount(m.aiMetrics.aiInteractions)} />
                  {m.aiMetrics.totalTokensUsed !== null ? (
                    <Row
                      label="Tokens used"
                      value={formatCount(m.aiMetrics.totalTokensUsed)}
                      description={`${m.aiMetrics.interactionsWithUsageData} of ${m.aiMetrics.aiInteractions} interactions`}
                    />
                  ) : null}
                  {Object.entries(org.aiInteractionsByType)
                    .sort(([, a], [, b]) => b - a)
                    .map(([type, count]) => (
                      <Row key={type} label={type} value={formatCount(count)} />
                    ))}
                </MetricList>
              ) : (
                <SectionEmpty title="No AI activity recorded for this client yet." description="Interactions appear here once the AI handles one of this client's conversations." />
              )}
            </SectionCard>
          </div>

          <div className="flex min-w-0 flex-col gap-6">
            <SectionCard title="Client" icon={Building}>
              <dl className="space-y-3">
                <Fact label="Owner / contact">{profile?.owner_name ?? "Not set"}</Fact>
                <Fact label="Trade">{profile?.trade ?? "Not set"}</Fact>
                <Fact label="Service area">{serviceAreas.length > 0 ? serviceAreas.map((a) => a.name).join(", ") : "Not set"}</Fact>
              </dl>
            </SectionCard>

            <SectionCard title="Setup" description="Billing and configuration status." icon={Settings2}>
              <MetricList>
                <Row
                  label="Payment status"
                  value={PAYMENT_STATUS_LABEL[orgHealth.paymentStatus] ?? orgHealth.paymentStatus}
                  tone={PAYMENT_STATUS_TONE[orgHealth.paymentStatus] ?? "default"}
                />
                <Row label="Business hours" value={readiness.items.find((i) => i.key === "hours")?.complete ? "Configured" : "Not configured"} />
                <Row label="SMS" value={readiness.items.find((i) => i.key === "sms")?.complete ? "Configured" : "Not configured"} />
                <Row label="Lead capture" value={readiness.items.find((i) => i.key === "leadCapture")?.complete ? "Ready" : "Unavailable"} />
                <Row label="AI review" value={readiness.items.find((i) => i.key === "ai")?.complete ? "Reviewed" : "Not reviewed"} />
                <Row label="AI appointment booking" value={readinessStateLabel(bookingState)} tone={bookingState === "not_ready" ? "warning" : "default"} />
                <Row label="Google Calendar sync" value={readinessStateLabel(calendarState)} tone={calendarState === "not_ready" ? "warning" : "default"} />
                {orgHealth.calendarStatus === "error" ? (
                  <Row label="Calendar connection" value="Disconnected" tone="danger" description={orgHealth.calendarLastError ?? undefined} />
                ) : null}
                <Row label="Automation mode" value={readiness.automationMode === "live" ? "Live" : "Test"} tone={readiness.automationMode === "live" ? "success" : "default"} />
              </MetricList>
            </SectionCard>

            {/* Readiness - what's still blocking Go Live, if anything. */}
            <SectionCard title="Readiness" description="What is still needed before Go Live." icon={ListChecks}>
              {missingItems.length === 0 ? (
                <p className="flex items-center gap-2 text-sm text-accent-text">
                  <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
                  Everything required is complete.
                </p>
              ) : (
                <ul className="divide-y divide-line" aria-label="Incomplete setup items">
                  {missingItems.map((item) => (
                    <li key={item.key} className="flex items-center gap-2.5 py-2">
                      <Circle className="h-3.5 w-3.5 shrink-0 text-ink-4" aria-hidden />
                      <span className="text-sm text-ink-2">{item.label}</span>
                    </li>
                  ))}
                </ul>
              )}
              {readiness.status !== "live" ? (
                <p className={`mt-3 ${metaClass}`}>Go Live is blocked until business profile, business hours, and SMS routing are all configured.</p>
              ) : null}
            </SectionCard>

            {/* Test - the real, most recent onboarding test-lead outcome. */}
            <SectionCard title="Test lead" description="The most recent onboarding test." icon={FlaskConical}>
              {testLeadOutcome && testOutcome ? (
                <div className="space-y-2">
                  <StatusLabel tone={testOutcome.tone}>{testOutcome.label}</StatusLabel>
                  <p className="text-sm text-ink-2">{testOutcome.detail}</p>
                  <p className={metaClass}>Last run {new Date(testLeadOutcome.createdAt).toLocaleString()}.</p>
                </div>
              ) : (
                <SectionEmpty title="No test has been attempted yet." description="A test lead is sent during onboarding to confirm the automation responds." />
              )}
            </SectionCard>

            <Panel>
              <h2 className={`flex items-center gap-2 ${subsectionTitleClass}`}>
                <Info className="h-4 w-4 shrink-0 text-ink-3" aria-hidden />
                Data quality
              </h2>
              <ul className="mt-3 space-y-2 text-xs text-ink-3">
                <DataQualityNote>No payment infrastructure exists - every value figure is quoted/contracted, never confirmed collected money.</DataQualityNote>
                <DataQualityNote>leads.source is not standardized - source counts, where shown, are never ranked or labeled as best/worst.</DataQualityNote>
                <DataQualityNote>No stage-transition history exists - rates are current-state or activity-count metrics, never true historical conversion rates.</DataQualityNote>
                {aiUnavailable ? (
                  <DataQualityNote>AI data temporarily unavailable - AI counts and token usage could not be read for this client.</DataQualityNote>
                ) : metrics.dataQuality.aiTokenUsageUnavailable ? (
                  <DataQualityNote>AI token usage unavailable - not populated by any automation path yet.</DataQualityNote>
                ) : null}
              </ul>
              <p className={`mt-4 border-t border-line pt-3 ${metaClass}`}>
                <Link href="/today" className="inline-flex min-h-11 items-center font-medium text-ink-2 hover:text-ink sm:min-h-0">
                  Back to Trackpr
                </Link>
              </p>
            </Panel>
          </div>
        </div>
      </div>
    </div>
  );
}

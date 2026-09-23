import type { ReactNode } from "react";
import { sectionLabelClass, metaClass, statLabelClass, statValueClass } from "@/lib/ui/typography";
import { StatGrid, StatCard } from "@/lib/ui/stat-card";
import { formatCurrency } from "@/lib/dashboard/format";
import type { BusinessMetricsSnapshot } from "@/lib/bi/types";
import { formatRate, formatComparisonBadge } from "./bi-format";
import { BarList } from "./bar-list";

/**
 * The Analytics page's genuine business-performance breakdown - reads
 * BusinessMetricsSnapshot (lib/bi/metrics.ts's getBusinessMetricsSnapshot,
 * the exact same function the Dashboard calls via
 * lib/dashboard/business-metrics.ts's getDashboardBusinessMetrics) and
 * calculates nothing itself, matching KeyMetrics's own discipline
 * (app/(app)/dashboard/_components/key-metrics.tsx). This is a second,
 * wider READ of the same BI layer at a caller-selected period (see
 * range-tabs.tsx), not a second computation path - no query or aggregation
 * logic is duplicated here.
 *
 * Ordered roughly by business relevance per the product brief: leads/
 * pipeline, estimates, jobs, appointments, follow-up, communication, AI
 * activity, automation, data quality. Each section is a flush stat strip
 * (matching LeadsSummary/ActivitySummaryCards/KeyMetrics) with a BarList only
 * where a category breakdown has enough buckets that a bare number list
 * would be hard to compare at a glance - never a fabricated or decorative
 * chart.
 */

type Stat = { key: string; label: string; value: string; detail?: string | null };

function StatRow({ stats }: { stats: Stat[] }) {
  return (
    <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-4">
      {stats.map((stat) => (
        <div key={stat.key}>
          <dt className={statLabelClass}>{stat.label}</dt>
          <dd className={statValueClass}>{stat.value}</dd>
          {stat.detail ? <p className="mt-0.5 text-xs text-slate-500">{stat.detail}</p> : null}
        </div>
      ))}
    </dl>
  );
}

/**
 * Deliberately no border-t of its own - the caller (activity/page.tsx) wraps
 * every Section in a single `divide-y` container so a divider appears
 * BETWEEN sections but never redundantly right under the "Business
 * performance" period-picker header above the first one.
 */
function Section({
  label,
  children,
  note,
}: {
  label: string;
  children: ReactNode;
  note?: string;
}) {
  return (
    <div className="pt-8 first:pt-6">
      <p className={sectionLabelClass}>{label}</p>
      {children}
      {note ? <p className={`mt-4 ${metaClass}`}>{note}</p> : null}
    </div>
  );
}

export function LeadsPipelineSection({ snapshot }: { snapshot: BusinessMetricsSnapshot }) {
  const { leadMetrics, pipelineMetrics, comparisons } = snapshot;

  const stageBreakdown = [
    { key: "new", label: "New", value: leadMetrics.newLeads },
    { key: "contacted", label: "Contacted", value: leadMetrics.contactedLeads },
    { key: "qualified", label: "Qualified", value: leadMetrics.qualifiedLeads },
    { key: "appointment", label: "Appointment stage", value: leadMetrics.appointmentStageLeads },
    { key: "estimate", label: "Estimate stage", value: leadMetrics.estimateStageLeads },
    { key: "won", label: "Won", value: leadMetrics.wonLeads },
    { key: "lost", label: "Lost", value: leadMetrics.lostLeads },
  ];

  const sourceEntries = Object.entries(leadMetrics.sourceCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8)
    .map(([source, count]) => ({ key: source, label: source, value: count }));

  return (
    <Section
      label="Leads & pipeline"
      note="Pipeline and average pipeline value are manually entered estimates on the lead, not revenue - Trackpr does not track collected payments."
    >
      <div className="mt-3">
        <StatGrid columns={5}>
          <StatCard label="Leads" value={String(comparisons.leadCount.current)} description={formatComparisonBadge(comparisons.leadCount)} />
          <StatCard label="Open opportunities" value={String(pipelineMetrics.openOpportunityCount)} />
          <StatCard label="Pipeline value" value={formatCurrency(pipelineMetrics.pipelineValue)} />
          <StatCard
            label="Avg. opportunity value"
            value={pipelineMetrics.averagePipelineValue === null ? "Not enough data yet" : formatCurrency(pipelineMetrics.averagePipelineValue)}
          />
          <StatCard label="Lost rate" value={formatRate(leadMetrics.lostRate)} />
        </StatGrid>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div>
          <p className="text-xs font-medium text-slate-700">Lead stage</p>
          <div className="mt-3">
            <BarList items={stageBreakdown} />
          </div>
        </div>

        {sourceEntries.length > 0 ? (
          <div>
            <p className="text-xs font-medium text-slate-700">Lead sources</p>
            <div className="mt-3">
              <BarList items={sourceEntries} />
            </div>
            <p className="mt-2 text-xs text-slate-400">
              Source is free-text and not standardized - shown for visibility only, never ranked by performance.
            </p>
          </div>
        ) : null}
      </div>

      <div className="mt-6">
        <p className="text-xs font-medium text-slate-700">Temperature</p>
        <dl className="mt-2 flex flex-wrap gap-x-8 gap-y-2">
          <div>
            <dt className="text-xs text-slate-500">Hot</dt>
            <dd className="text-sm font-semibold tabular-nums text-slate-900">{leadMetrics.hotLeads}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Warm</dt>
            <dd className="text-sm font-semibold tabular-nums text-slate-900">{leadMetrics.warmLeads}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Cold</dt>
            <dd className="text-sm font-semibold tabular-nums text-slate-900">{leadMetrics.coldLeads}</dd>
          </div>
        </dl>
      </div>
    </Section>
  );
}

export function EstimatesSection({ snapshot }: { snapshot: BusinessMetricsSnapshot }) {
  const { estimateMetrics, comparisons } = snapshot;

  const statusBreakdown = [
    { key: "draft", label: "Draft", value: estimateMetrics.draftEstimates },
    { key: "sent", label: "Sent", value: estimateMetrics.sentEstimates },
    { key: "accepted", label: "Accepted", value: estimateMetrics.acceptedEstimates },
    { key: "declined", label: "Declined", value: estimateMetrics.declinedEstimates },
    { key: "cancelled", label: "Cancelled", value: estimateMetrics.cancelledEstimates },
    { key: "expired", label: "Expired", value: estimateMetrics.expiredEstimates },
  ];

  return (
    <Section label="Estimates" note="Estimate value is a quoted total, not revenue.">
      <StatRow
        stats={[
          { key: "estimates", label: "Estimates", value: String(comparisons.estimateCount.current), detail: formatComparisonBadge(comparisons.estimateCount) },
          { key: "estimate-value", label: "Estimate value", value: formatCurrency(estimateMetrics.estimateValue) },
          {
            key: "avg-estimate-value",
            label: "Avg. estimate value",
            value: estimateMetrics.averageEstimateValue === null ? "Not enough data yet" : formatCurrency(estimateMetrics.averageEstimateValue),
          },
          { key: "acceptance-rate", label: "Acceptance rate", value: formatRate(estimateMetrics.estimateAcceptanceRate) },
          { key: "estimate-to-job-rate", label: "Estimate → job rate", value: formatRate(estimateMetrics.estimateToJobRate) },
        ]}
      />

      <div className="mt-6 max-w-md">
        <BarList items={statusBreakdown} />
      </div>
    </Section>
  );
}

export function JobsSection({ snapshot }: { snapshot: BusinessMetricsSnapshot }) {
  const { jobMetrics, comparisons } = snapshot;

  const statusBreakdown = [
    { key: "scheduled", label: "Scheduled", value: jobMetrics.scheduledJobs },
    { key: "in-progress", label: "In progress", value: jobMetrics.inProgressJobs },
    { key: "completed", label: "Completed", value: jobMetrics.completedJobs },
    { key: "cancelled", label: "Cancelled", value: jobMetrics.cancelledJobs },
  ];

  return (
    <Section label="Jobs" note="Contracted job value is a quoted/contracted figure - Trackpr has no payment infrastructure, so this is never collected revenue.">
      <StatRow
        stats={[
          { key: "jobs", label: "Jobs", value: String(comparisons.jobCount.current), detail: formatComparisonBadge(comparisons.jobCount) },
          { key: "contracted-value", label: "Contracted job value", value: formatCurrency(jobMetrics.contractedJobValue) },
          {
            key: "avg-contracted-value",
            label: "Avg. contracted value",
            value: jobMetrics.averageContractedJobValue === null ? "Not enough data yet" : formatCurrency(jobMetrics.averageContractedJobValue),
          },
          { key: "completion-rate", label: "Completion rate", value: formatRate(jobMetrics.jobCompletionRate) },
        ]}
      />

      <div className="mt-6 max-w-md">
        <BarList items={statusBreakdown} />
      </div>
    </Section>
  );
}

export function AppointmentsSection({ snapshot }: { snapshot: BusinessMetricsSnapshot }) {
  const { appointmentMetrics } = snapshot;

  return (
    <Section label="Appointments">
      <StatRow
        stats={[
          { key: "total", label: "Total", value: String(appointmentMetrics.totalAppointments) },
          { key: "scheduled", label: "Scheduled", value: String(appointmentMetrics.scheduledAppointments) },
          { key: "confirmed", label: "Confirmed", value: String(appointmentMetrics.confirmedAppointments) },
          { key: "completed", label: "Completed", value: String(appointmentMetrics.completedAppointments) },
          { key: "cancelled", label: "Cancelled", value: String(appointmentMetrics.cancelledAppointments) },
          { key: "no-show", label: "No-show", value: String(appointmentMetrics.noShowAppointments) },
          { key: "no-show-rate", label: "No-show rate", value: formatRate(appointmentMetrics.appointmentNoShowRate) },
        ]}
      />
    </Section>
  );
}

export function FollowUpSection({ snapshot }: { snapshot: BusinessMetricsSnapshot }) {
  const { followUpMetrics } = snapshot;

  return (
    <Section label="Follow-up automation" note="Activity counts only - not a claim that a follow-up touch caused any change in leads, jobs, or pipeline value.">
      <StatRow
        stats={[
          { key: "lost-nurture", label: "Lost-lead nurture", value: String(followUpMetrics.lostLeadNurtureEvents) },
          { key: "reactivation", label: "Reactivation", value: String(followUpMetrics.reactivationEvents) },
          { key: "appointment-reminders", label: "Appointment reminders", value: String(followUpMetrics.appointmentReminderEvents) },
          { key: "estimate-followups", label: "Estimate follow-ups", value: String(followUpMetrics.estimateFollowUpEvents) },
          { key: "job-followups", label: "Post-job follow-ups", value: String(followUpMetrics.postJobFollowUpEvents) },
          { key: "leads-touched", label: "Leads touched by automation", value: String(followUpMetrics.leadsTouchedByAutomation) },
        ]}
      />
    </Section>
  );
}

export function CommunicationSection({ snapshot }: { snapshot: BusinessMetricsSnapshot }) {
  const { communicationMetrics } = snapshot;

  return (
    <Section label="Communication">
      <StatRow
        stats={[
          { key: "inbound", label: "Inbound messages", value: String(communicationMetrics.inboundMessages) },
          { key: "outbound", label: "Outbound messages", value: String(communicationMetrics.outboundMessages) },
          { key: "customer-replies", label: "Customer replies", value: String(communicationMetrics.customerReplies) },
          { key: "opened", label: "Conversations opened", value: String(communicationMetrics.conversationsOpened) },
          { key: "closed", label: "Conversations closed", value: String(communicationMetrics.conversationsClosed) },
          { key: "opt-outs", label: "Opted-out contacts", value: String(communicationMetrics.optOutCount) },
        ]}
      />

      <div className="mt-6">
        <p className="text-xs font-medium text-slate-700">Outbound sent by</p>
        <dl className="mt-2 flex flex-wrap gap-x-8 gap-y-2">
          <div>
            <dt className="text-xs text-slate-500">AI</dt>
            <dd className="text-sm font-semibold tabular-nums text-slate-900">{communicationMetrics.aiOutboundMessages}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Your team</dt>
            <dd className="text-sm font-semibold tabular-nums text-slate-900">{communicationMetrics.userOutboundMessages}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">System</dt>
            <dd className="text-sm font-semibold tabular-nums text-slate-900">{communicationMetrics.systemOutboundMessages}</dd>
          </div>
        </dl>
      </div>
    </Section>
  );
}

export function AiActivitySection({ snapshot }: { snapshot: BusinessMetricsSnapshot }) {
  const { aiMetrics } = snapshot;

  return (
    <Section label="AI activity">
      <StatRow
        stats={[
          { key: "interactions", label: "AI interactions", value: String(aiMetrics.aiInteractions) },
          { key: "outbound-interactions", label: "Recommended sending", value: String(aiMetrics.aiOutboundInteractions) },
          { key: "customer-reply", label: "Customer-reply responses", value: String(aiMetrics.customerReplyAiInteractions) },
          { key: "needs-human", label: "Flagged for a human", value: String(aiMetrics.aiNeedsHumanCount) },
        ]}
      />
    </Section>
  );
}

export function AutomationSection({ snapshot }: { snapshot: BusinessMetricsSnapshot }) {
  const { automationMetrics } = snapshot;

  return (
    <Section label="Automation health">
      <div>
        <p className="text-xs font-medium text-slate-700">Automation events</p>
        <StatRow
          stats={[
            { key: "events", label: "Total", value: String(automationMetrics.automationEvents) },
            { key: "completed-events", label: "Completed", value: String(automationMetrics.completedAutomationEvents) },
            { key: "failed-events", label: "Failed", value: String(automationMetrics.failedAutomationEvents) },
            { key: "pending-events", label: "Pending", value: String(automationMetrics.pendingAutomationEvents) },
          ]}
        />
      </div>

      <div className="mt-6">
        <p className="text-xs font-medium text-slate-700">Workflow executions</p>
        <StatRow
          stats={[
            { key: "executions", label: "Total", value: String(automationMetrics.workflowExecutions) },
            { key: "successful", label: "Successful", value: String(automationMetrics.successfulWorkflowExecutions) },
            { key: "failed", label: "Failed", value: String(automationMetrics.failedWorkflowExecutions) },
            { key: "running", label: "Running", value: String(automationMetrics.runningWorkflowExecutions) },
            { key: "success-rate", label: "Success rate", value: formatRate(automationMetrics.automationSuccessRate) },
          ]}
        />
      </div>
    </Section>
  );
}

export function DataQualitySection({ snapshot }: { snapshot: BusinessMetricsSnapshot }) {
  return (
    <Section label="Data quality notes">
      <ul className="mt-3 space-y-1.5 text-xs text-slate-500">
        {snapshot.dataQuality.notes.map((note) => (
          <li key={note} className="flex gap-2">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-300" aria-hidden />
            {note}
          </li>
        ))}
      </ul>
    </Section>
  );
}

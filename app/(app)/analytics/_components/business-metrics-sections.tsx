import type { ReactNode } from "react";
import { sectionLabelClass, metaClass, statLabelClass, statValueClass } from "@/lib/ui/typography";
import { StatGrid, StatCard } from "@/lib/ui/stat-card";
import { formatCurrency } from "@/lib/dashboard/format";
import type { BusinessMetricsSnapshot } from "@/lib/bi/types";
import type { RepeatCustomerSummary } from "@/lib/customers/lifecycle";
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
 * Trackpr 2.0 Phase 5: reframed into named groups (see analytics/page.tsx)
 * telling a coherent revenue story - business at a glance, revenue pipeline
 * (leads/estimates/jobs/appointments), conversion, where follow-up is
 * leaking, AI & automation, data quality - rather than nine flat sections in
 * an arbitrary row. Every individual Section function below is unchanged in
 * what it reads and computes; only the page-level grouping around them, and
 * two new sections (ConversionSection, RevenueOpportunitySection) built
 * entirely from already-computed snapshot fields, are new. Each section is a
 * flush stat strip (matching LeadsSummary/ActivitySummaryCards/KeyMetrics)
 * with a BarList only where a category breakdown has enough buckets that a
 * bare number list would be hard to compare at a glance - never a fabricated
 * or decorative chart.
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

/**
 * Trackpr 2.0 Phase 5: the page's executive summary - the four numbers that
 * most directly answer "how is the business doing," each already computed
 * and already reliable (comparisons.leadCount, and the two Phase 5 additions
 * to BiEstimateMetrics/BiJobMetrics - acceptedEstimateValue,
 * completedContractedJobValue - both threaded through from an existing
 * lib/bi/queries.ts computation, not a new query). Deliberately keeps
 * "accepted"/"completed" in every label rather than a bare dollar amount -
 * this schema has no payment infrastructure, so every value figure here is
 * still a quoted/contracted amount, never confirmed collected revenue.
 */
export function BusinessAtAGlance({ snapshot }: { snapshot: BusinessMetricsSnapshot }) {
  const { comparisons, estimateMetrics, jobMetrics, leadMetrics } = snapshot;

  return (
    <StatGrid columns={4}>
      <StatCard label="Leads" value={String(comparisons.leadCount.current)} description={formatComparisonBadge(comparisons.leadCount)} />
      <StatCard label="Accepted estimate value" value={formatCurrency(estimateMetrics.acceptedEstimateValue)} description="Quoted work customers said yes to" />
      <StatCard label="Completed job value" value={formatCurrency(jobMetrics.completedContractedJobValue)} description="Contracted value of finished jobs" />
      <StatCard label="Lead → booking rate" value={formatRate(leadMetrics.leadToBookingRate)} description="Leads that got an appointment" />
    </StatGrid>
  );
}

/**
 * Trackpr 2.0 Phase 5: the four conversion rates that already exist, each
 * computed inside its own metric group (leadMetrics.leadToBookingRate,
 * estimateMetrics.estimateAcceptanceRate, estimateMetrics.estimateToJobRate,
 * jobMetrics.jobCompletionRate) but previously scattered across four
 * separate sections with no single place to read the funnel end to end.
 * Nothing here is recomputed - every rate is read as-is from the snapshot.
 * Appointment -> estimate conversion is deliberately not included: no
 * existing query reliably answers "did this specific appointment lead to an
 * estimate," and inventing one is out of scope for a reframe.
 */
export function ConversionSection({ snapshot }: { snapshot: BusinessMetricsSnapshot }) {
  const { leadMetrics, estimateMetrics, jobMetrics } = snapshot;

  return (
    <Section label="Conversion" note="Each rate is a current-state ratio over real records, not a time-based or causal claim - see each section's own definition above.">
      <StatRow
        stats={[
          { key: "lead-booking", label: "Lead → booking", value: formatRate(leadMetrics.leadToBookingRate), detail: "Leads with a real appointment" },
          { key: "estimate-acceptance", label: "Estimate acceptance", value: formatRate(estimateMetrics.estimateAcceptanceRate), detail: "Accepted vs. accepted + declined" },
          { key: "estimate-job", label: "Estimate → job", value: formatRate(estimateMetrics.estimateToJobRate), detail: "Jobs per accepted estimate" },
          { key: "job-completion", label: "Job completion", value: formatRate(jobMetrics.jobCompletionRate), detail: "Completed vs. completed + cancelled" },
        ]}
      />
    </Section>
  );
}

/**
 * Trackpr 2.0 Phase 5: surfaces BiRevenueOpportunity (lib/bi/types.ts),
 * already computed by getBusinessMetricsSnapshot for every caller but
 * previously only ever rendered on the Dashboard (business-glance.tsx) -
 * never on the Analytics page itself, despite this being exactly "where is
 * follow-up leaking" (real, quoted work with no decision yet, and real
 * leads/visits that stalled before the next real step). Same fields, same
 * captions as the Dashboard's own rendering, for consistency.
 */
export function RevenueOpportunitySection({ snapshot }: { snapshot: BusinessMetricsSnapshot }) {
  const { revenueOpportunity } = snapshot;

  return (
    <Section label="Where follow-up is leaking" note="Real opportunity, not guaranteed revenue or a close probability.">
      <StatRow
        stats={[
          { key: "recoverable", label: "Recoverable estimate value", value: formatCurrency(revenueOpportunity.recoverableEstimateValue), detail: "Open + expired, not yet declined" },
          { key: "qualified-no-appt", label: "Qualified leads, no appointment", value: String(revenueOpportunity.qualifiedLeadsWithoutAppointment) },
          { key: "completed-no-estimate", label: "Completed visits, no estimate", value: String(revenueOpportunity.completedAppointmentsWithoutEstimate) },
        ]}
      />
    </Section>
  );
}

/**
 * Pass 3 (Revenue Intelligence Foundation), Part 9: reconnects
 * ReviewReferralMetrics - real, already-computed by
 * lib/bi/queries.ts's getReviewReferralMetrics and threaded onto the
 * current BusinessMetricsSnapshot by lib/bi/metrics.ts, but previously only
 * ever reachable through the superseded Phase 5.1 BusinessIntelligenceSnapshot
 * type that nothing in the app calls anymore - this is its first live UI
 * surface. Same range-scoped semantics as every other section on this page
 * ("how many review/referral requests were created and resolved in this
 * window"), unlike RepeatCustomerSection below.
 */
export function ReviewReferralSection({ snapshot }: { snapshot: BusinessMetricsSnapshot }) {
  const { reviewReferralMetrics } = snapshot;

  return (
    <Section label="Reviews &amp; referrals" note="Response/completion counts reflect an explicit contractor confirmation, not an automated inference.">
      <StatRow
        stats={[
          { key: "review-response", label: "Review response rate", value: formatRate(reviewReferralMetrics.reviewResponseRate), detail: `${reviewReferralMetrics.reviewsRequested} requested` },
          { key: "review-completion", label: "Review completion rate", value: formatRate(reviewReferralMetrics.reviewCompletionRate), detail: `${reviewReferralMetrics.reviewsCompleted} completed` },
          { key: "referral-response", label: "Referral response rate", value: formatRate(reviewReferralMetrics.referralResponseRate), detail: `${reviewReferralMetrics.referralsRequested} requested` },
          { key: "referral-conversion", label: "Referral conversion rate", value: formatRate(reviewReferralMetrics.referralConversionRate), detail: `${reviewReferralMetrics.referralsConverted} converted` },
        ]}
      />
    </Section>
  );
}

/**
 * Pass 3, Part 9: repeat-customer + known completed-job value, sourced from
 * lib/customers/lifecycle.ts's getRepeatCustomerSummary - deliberately a
 * separate prop from `snapshot`, not a BusinessMetricsSnapshot field,
 * because (like revenueOpportunity) "has this customer come back, ever" is
 * a current-state fact, not scoped to whatever period the page's range
 * tabs have selected. No fabricated CLV formula - only the real underlying
 * counts/sums this schema can actually support.
 */
export function RepeatCustomerSection({ summary }: { summary: RepeatCustomerSummary }) {
  return (
    <Section label="Repeat customers" note="Completed job value is the contracted amount, not collected revenue - no payment ledger exists.">
      <StatRow
        stats={[
          { key: "repeat-count", label: "Repeat customers", value: String(summary.repeatCustomerCount), detail: `of ${summary.customersWithCompletedJob} with a completed job` },
          { key: "repeat-rate", label: "Repeat customer rate", value: formatRate(summary.repeatCustomerRate) },
          { key: "completed-jobs", label: "Completed jobs", value: String(summary.completedJobCount) },
          { key: "known-value", label: "Known completed job value", value: formatCurrency(summary.knownCompletedJobValue), detail: summary.averageKnownCompletedJobValue != null ? `${formatCurrency(summary.averageKnownCompletedJobValue)} average` : undefined },
        ]}
      />
    </Section>
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
          { key: "accepted-estimate-value", label: "Accepted estimate value", value: formatCurrency(estimateMetrics.acceptedEstimateValue) },
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
          { key: "completed-value", label: "Completed job value", value: formatCurrency(jobMetrics.completedContractedJobValue) },
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

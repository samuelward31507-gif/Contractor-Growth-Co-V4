import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { formatCurrency } from "@/lib/dashboard/format";
import { formatMoney } from "@/lib/invoices/domain";
import { SANCTIONED_COLLECTED_REVENUE_DEFINITION } from "@/lib/bi/billing";
import type { BusinessMetricsSnapshot, PeriodComparison } from "@/lib/bi/types";
import type { RepeatCustomerSummary } from "@/lib/customers/lifecycle";
import { formatRate, formatComparisonBadge, formatDuration, ownerDataNotes } from "./bi-format";
import { BarList } from "./bar-list";
import { BreakdownGrid, Panel, PanelBlock, PanelBody, PanelNote, PrimaryMetrics, SecondaryMetrics, scopeLabel, type Metric } from "./metric-panel";
import type { OpportunityOutcomeGroup } from "@/lib/bi/metrics";
import type { OutcomeMetrics } from "@/lib/bi/outcome-metrics";
import type { RevenueAttribution } from "@/lib/bi/revenue-attribution";
import { withCollected, type CashAttribution } from "@/lib/bi/cash-attribution";
import type { BiAppointmentMetrics } from "@/lib/bi/types";
import { metaClass } from "@/lib/ui/typography";

/**
 * Analytics' business-performance panels - each reads
 * BusinessMetricsSnapshot (lib/bi/metrics.ts's getBusinessMetricsSnapshot)
 * and calculates nothing itself; every rate, comparison and total is read
 * as-is. Each figure appears once on the page, in the panel that owns it,
 * and every panel's header states the time scope its numbers cover:
 *   - the selected period (Collected, Invoiced, leads, estimates, jobs...);
 *   - "As of today" for current-state balances and leaks;
 *   - "All time" for repeat customers.
 * Where a single figure's scope differs from its panel's, its own detail or
 * block label says so. Detailed definitions live once, in
 * CalculationsPanel, instead of under every section.
 */

const count = (n: number, singular: string, plural: string) => `${n} ${n === 1 ? singular : plural}`;

/** A previous-period comparison as a metric detail, colored by direction - or the fallback when there is no comparison. */
function compared(comparison: PeriodComparison, fallback?: string | null): Pick<Metric, "detail" | "tone"> {
  const badge = formatComparisonBadge(comparison);
  if (!badge) return { detail: fallback ?? null };
  return { detail: badge, tone: comparison.change != null && comparison.change > 0 ? "positive" : comparison.change != null && comparison.change < 0 ? "negative" : undefined };
}

function ViewLink({ href, children }: { href: string; children: string }) {
  return (
    <Link href={href} className="inline-flex min-h-11 items-center gap-1 self-start rounded-md text-[13px] font-medium text-ink-2 transition-colors hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0">
      {children}
      <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
    </Link>
  );
}

// ---------------------------------------------------------------------------
// 1. Revenue & payments
// ---------------------------------------------------------------------------

/**
 * The invoice/payment ledger - snapshot.billingMetrics (lib/bi/billing.ts).
 * Collected and Invoiced are period totals (received_at / issued_at in
 * range); Outstanding and Overdue are balances as of today and say so;
 * days to payment is always paired with the count of invoices it was
 * measured over; reversals are shown separately so net Collected stays
 * transparent.
 */
export function RevenuePaymentsPanel({ snapshot }: { snapshot: BusinessMetricsSnapshot }) {
  const { billingMetrics, comparisons, dataQuality, period, invoiceAging } = snapshot;
  const scope = scopeLabel(period.label);

  if (dataQuality.collectedRevenueUnavailable) {
    return (
      <Panel id="revenue" title="Revenue & payments" scope={scope}>
        <p className="px-4 py-4 text-sm text-ink-3 sm:px-5">The invoice and payment ledger could not be read for this period. Nothing is estimated in its place.</p>
      </Panel>
    );
  }

  const days = billingMetrics.averageDaysToPayment === null ? null : Math.round(billingMetrics.averageDaysToPayment);

  return (
    <Panel id="revenue" title="Revenue & payments" scope={scope}>
      <PrimaryMetrics
        metrics={[
          { key: "collected", label: "Collected", value: formatMoney(billingMetrics.collectedValue), ...compared(comparisons.collectedValue, `${count(billingMetrics.paymentsReceived, "payment", "payments")} received`) },
          { key: "invoiced", label: "Invoiced", value: formatMoney(billingMetrics.invoicedValue), ...compared(comparisons.invoicedValue, `${count(billingMetrics.invoicesIssued, "invoice", "invoices")} issued`) },
          { key: "outstanding", label: "Outstanding", value: formatMoney(billingMetrics.outstandingValue), detail: `${count(billingMetrics.outstandingInvoices, "open invoice", "open invoices")} · as of today` },
          {
            key: "overdue",
            label: "Overdue",
            value: formatMoney(billingMetrics.overdueValue),
            detail: `${count(billingMetrics.overdueInvoices, "invoice", "invoices")} past due · as of today`,
            tone: billingMetrics.overdueInvoices > 0 ? "attention" : undefined,
          },
        ]}
      />
      <PanelBody>
        <SecondaryMetrics
          metrics={[
            { key: "days-to-payment", label: "Avg. days to payment", value: days === null ? "Not enough data yet" : `${days} ${days === 1 ? "day" : "days"}`, detail: `Based on ${count(billingMetrics.invoicesPaid, "invoice", "invoices")} paid` },
            { key: "reversed", label: "Reversed", value: formatMoney(billingMetrics.reversedValue), detail: `${count(billingMetrics.reversalCount, "reversal", "reversals")} · already subtracted from Collected` },
            { key: "payments", label: "Payments received", value: String(billingMetrics.paymentsReceived) },
            { key: "issued", label: "Invoices issued", value: String(billingMetrics.invoicesIssued) },
            { key: "paid", label: "Invoices paid", value: String(billingMetrics.invoicesPaid) },
          ]}
        />
        <PanelBlock label="Unpaid by age" scope="As of today">
          <SecondaryMetrics
            metrics={invoiceAging.map((bucket) => ({
              key: `aging-${bucket.key}`,
              label: bucket.key === "current" ? "Current" : `${bucket.label} past due`,
              value: formatMoney(bucket.value),
              detail: count(bucket.count, "invoice", "invoices"),
              tone: bucket.key !== "current" && bucket.count > 0 ? "attention" : undefined,
            }))}
          />
        </PanelBlock>
        <PanelNote>{SANCTIONED_COLLECTED_REVENUE_DEFINITION} Invoiced is money asked for, not received.</PanelNote>
      </PanelBody>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 3. Leads & conversion
// ---------------------------------------------------------------------------

/**
 * Lead volume and the conversion rates end to end - each rate read as-is
 * from its own metric group - plus the historical funnel (real,
 * timestamped lead.stage_changed events). Timing averages are never shown
 * bare: each carries its own coverage ("N of M leads with recorded
 * history"). The day-by-day chart is passed in as `trend`.
 */
export function LeadsConversionPanel({ snapshot, outcomes, trend }: { snapshot: BusinessMetricsSnapshot; outcomes: OutcomeMetrics; trend: ReactNode }) {
  const { estimateMetrics, jobMetrics, leadStageFunnel, comparisons, period } = snapshot;
  const { transitions, timing } = leadStageFunnel;

  return (
    <Panel id="leads" title="Leads & conversion" scope={scopeLabel(period.label)}>
      <PrimaryMetrics
        metrics={[
          { key: "leads", label: "Leads", value: String(comparisons.leadCount.current), ...compared(comparisons.leadCount) },
          { key: "lead-booking", label: "Lead → booking", value: formatRate(outcomes.leadToBookingRate), detail: `${outcomes.leadsWithActiveBooking} of ${outcomes.leadsInRange} leads · not cancelled or no-show` },
          { key: "estimate-acceptance", label: "Estimate acceptance", value: formatRate(outcomes.estimateAcceptanceRate), detail: `${outcomes.acceptedEstimates} of ${outcomes.acceptedEstimates + outcomes.declinedEstimates} decided in the period` },
          { key: "job-completion", label: "Job completion", value: formatRate(jobMetrics.jobCompletionRate), detail: "Jobs created in the period · completed vs. completed + cancelled" },
        ]}
      />
      <PanelBody>
        <SecondaryMetrics
          metrics={[
            { key: "estimate-job", label: "Estimate → job", value: formatRate(estimateMetrics.estimateToJobRate), detail: "Accepted estimates that became a job" },
            { key: "to-qualified", label: "Leads → Qualified", value: String(transitions.leadsTransitionedToQualified), ...compared(comparisons.leadsTransitionedToQualified) },
            { key: "to-won", label: "Leads → Won", value: String(transitions.leadsTransitionedToWon), ...compared(comparisons.leadsTransitionedToWon) },
            { key: "time-to-qualified", label: "Avg. time to qualified", value: formatDuration(timing.averageTimeToQualifiedMs), detail: `${timing.leadsWithQualifiedTiming} of ${timing.leadsInRange} leads with history` },
            { key: "time-to-won", label: "Avg. time to won", value: formatDuration(timing.averageTimeToWonMs), detail: `${timing.leadsWithWonTiming} of ${timing.leadsInRange} leads with history` },
          ]}
        />
        {trend}
      </PanelBody>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 4. Pipeline & follow-up leaks
// ---------------------------------------------------------------------------

/**
 * What is open right now: open leads and their entered value (unbounded -
 * "what's open" doesn't care when the lead was created) and
 * BiRevenueOpportunity's real, quoted work that may be slipping away. The
 * per-item next actions live in Today's queue - this links there rather
 * than inventing a second recommendation surface. Lost rate and the
 * stage/source/temperature breakdowns cover leads created in the selected
 * period, and are labeled that way.
 */
export function PipelineLeaksPanel({ snapshot, outcomes }: { snapshot: BusinessMetricsSnapshot; outcomes: OpportunityOutcomeGroup[] }) {
  const { leadMetrics, pipelineMetrics, revenueOpportunity, estimateAging, period } = snapshot;
  const hasOpenItems = revenueOpportunity.qualifiedLeadsWithoutAppointment > 0 || revenueOpportunity.completedAppointmentsWithoutEstimate > 0 || revenueOpportunity.recoverableEstimateValue > 0;
  const periodScope = scopeLabel(period.label);

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
    .map(([source, value]) => ({ key: source, label: source, value }));

  return (
    <Panel id="pipeline" title="Pipeline & follow-up leaks" scope="As of today">
      <PrimaryMetrics
        metrics={[
          { key: "open-leads", label: "Open leads", value: String(pipelineMetrics.openOpportunityCount) },
          { key: "open-lead-value", label: "Open lead value", value: formatCurrency(pipelineMetrics.pipelineValue), detail: "Entered on each open lead" },
          { key: "avg-open-lead-value", label: "Avg. open lead value", value: pipelineMetrics.averagePipelineValue === null ? "Not enough data yet" : formatCurrency(pipelineMetrics.averagePipelineValue) },
          { key: "recoverable", label: "Recoverable estimate value", value: formatCurrency(revenueOpportunity.recoverableEstimateValue), detail: "Open + expired, not yet declined" },
        ]}
      />
      <PanelBody>
        <SecondaryMetrics
          metrics={[
            { key: "qualified-no-appt", label: "Qualified, no appointment", value: String(revenueOpportunity.qualifiedLeadsWithoutAppointment) },
            { key: "completed-no-estimate", label: "Visits, no estimate", value: String(revenueOpportunity.completedAppointmentsWithoutEstimate) },
            { key: "lost-rate", label: "Lost rate", value: formatRate(leadMetrics.lostRate), detail: `Leads created · ${periodScope}` },
            { key: "declined-value", label: "Declined estimate value · All time", value: formatCurrency(revenueOpportunity.lostEstimateValue), detail: "Quoted work customers turned down" },
          ]}
        />
        <PanelBlock label="Estimates awaiting a decision" scope="By days since sent · as of today">
          <SecondaryMetrics
            metrics={[
              ...estimateAging.buckets
                .filter((bucket) => bucket.key !== "undated" || bucket.count > 0)
                .map((bucket) => ({ key: `estimate-age-${bucket.key}`, label: bucket.label, value: formatCurrency(bucket.value), detail: count(bucket.count, "estimate", "estimates") })),
              {
                key: "past-expiry",
                label: "Past their expiry date",
                value: String(estimateAging.pastExpiryCount),
                detail: `${formatCurrency(estimateAging.pastExpiryValue)} quoted`,
                tone: estimateAging.pastExpiryCount > 0 ? "attention" : undefined,
              },
            ]}
          />
        </PanelBlock>
        <PanelBlock label={`Closed opportunities · ${periodScope}`}>
          <SecondaryMetrics metrics={outcomes.map((group) => ({ key: `outcome-${group.key}`, label: group.label, value: String(group.count), detail: `${formatCurrency(group.value)} estimated` }))} />
          <p className={`mt-3 ${metaClass}`}>Dated when Trackpr noticed the change. &ldquo;No longer applies&rdquo; means the condition stopped holding - not proof the work or money was recovered.</p>
        </PanelBlock>
        <BreakdownGrid>
          <PanelBlock label="Lead stage" scope={`Leads created · ${periodScope}`}>
            <BarList items={stageBreakdown} />
          </PanelBlock>
          {sourceEntries.length > 0 ? (
            <PanelBlock label="Lead sources" scope={`Leads created · ${periodScope}`}>
              <BarList items={sourceEntries} />
            </PanelBlock>
          ) : null}
          <PanelBlock label="Temperature" scope={`Leads created · ${periodScope}`}>
            <BarList
              items={[
                { key: "hot", label: "Hot", value: leadMetrics.hotLeads },
                { key: "warm", label: "Warm", value: leadMetrics.warmLeads },
                { key: "cold", label: "Cold", value: leadMetrics.coldLeads },
              ]}
            />
          </PanelBlock>
        </BreakdownGrid>
        {hasOpenItems ? <ViewLink href="/today?view=by-type">Review in Today</ViewLink> : null}
      </PanelBody>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 5. Estimates & jobs
// ---------------------------------------------------------------------------

/**
 * Estimate and job volume and value for the period. The conversion rates
 * between them live once, in Leads & conversion, rather than repeating here.
 */
export function EstimatesJobsPanel({ snapshot, jobLeadLinkage, attribution, outcomes, cash }: { snapshot: BusinessMetricsSnapshot; jobLeadLinkage: { linked: number; total: number }; attribution: RevenueAttribution; outcomes: OutcomeMetrics; cash: CashAttribution }) {
  const { estimateMetrics, jobMetrics, comparisons, period } = snapshot;
  const periodScope = scopeLabel(period.label);
  const { conversion } = attribution;

  return (
    <Panel id="estimates-jobs" title="Estimates & jobs" scope={scopeLabel(period.label)}>
      <PrimaryMetrics
        metrics={[
          { key: "estimates", label: "Estimates", value: String(comparisons.estimateCount.current), ...compared(comparisons.estimateCount) },
          { key: "accepted-estimate-value", label: "Accepted estimate value", value: formatCurrency(estimateMetrics.acceptedEstimateValue), detail: "Quoted work customers said yes to" },
          { key: "jobs", label: "Jobs", value: String(comparisons.jobCount.current), ...compared(comparisons.jobCount) },
          { key: "completed-value", label: "Completed job value", value: formatCurrency(outcomes.completedJobValue), detail: `${count(outcomes.completedJobs, "job", "jobs")} completed in the period` },
        ]}
      />
      <PanelBody>
        <SecondaryMetrics
          metrics={[
            { key: "estimate-value", label: "Estimate value", value: formatCurrency(estimateMetrics.estimateValue) },
            { key: "avg-estimate-value", label: "Avg. estimate value", value: estimateMetrics.averageEstimateValue === null ? "Not enough data yet" : formatCurrency(estimateMetrics.averageEstimateValue) },
            { key: "contracted-value", label: "Contracted job value", value: formatCurrency(jobMetrics.contractedJobValue) },
            { key: "avg-contracted-value", label: "Avg. contracted value", value: jobMetrics.averageContractedJobValue === null ? "Not enough data yet" : formatCurrency(jobMetrics.averageContractedJobValue) },
            { key: "jobs-linked-to-lead", label: "Jobs linked to a lead", value: `${jobLeadLinkage.linked} of ${jobLeadLinkage.total}`, detail: "All time" },
          ]}
        />
        <BreakdownGrid>
          <PanelBlock label="Estimate status" scope="Created in the period">
            <BarList
              items={[
                { key: "draft", label: "Draft", value: estimateMetrics.draftEstimates },
                { key: "sent", label: "Sent", value: estimateMetrics.sentEstimates },
                { key: "accepted", label: "Accepted", value: estimateMetrics.acceptedEstimates },
                { key: "declined", label: "Declined", value: estimateMetrics.declinedEstimates },
                { key: "cancelled", label: "Cancelled", value: estimateMetrics.cancelledEstimates },
                { key: "expired", label: "Expired", value: estimateMetrics.expiredEstimates },
              ]}
            />
          </PanelBlock>
          <PanelBlock label="Job status" scope="Created in the period">
            <BarList
              items={[
                { key: "scheduled", label: "Scheduled", value: jobMetrics.scheduledJobs },
                { key: "in-progress", label: "In progress", value: jobMetrics.inProgressJobs },
                { key: "completed", label: "Completed", value: jobMetrics.completedJobs },
                { key: "cancelled", label: "Cancelled", value: jobMetrics.cancelledJobs },
              ]}
            />
          </PanelBlock>
        </BreakdownGrid>
        <PanelBlock label="Lead → job" scope={`Leads created · ${periodScope}`}>
          <SecondaryMetrics
            metrics={[
              { key: "cohort-leads", label: "New leads", value: String(conversion.leads) },
              { key: "cohort-with-job", label: "Leads with a job", value: String(conversion.leadsWithJob), detail: "Cancelled jobs excluded" },
              { key: "cohort-rate", label: "Lead → job rate", value: formatRate(conversion.jobRate) },
              { key: "cohort-completed", label: "Jobs completed so far", value: String(conversion.completedJobs) },
              { key: "cohort-completed-value", label: "Value completed so far", value: formatCurrency(conversion.completedValue), detail: "Contracted amount" },
            ]}
          />
        </PanelBlock>
        <PanelBlock label="Revenue by source" scope={periodScope}>
          <RevenueBySourceTable attribution={attribution} cash={cash} />
        </PanelBlock>
        <PanelNote>Estimate and job values are quoted or contracted amounts, never collected revenue. Only the Collected column is money received.</PanelNote>
      </PanelBody>
    </Panel>
  );
}

/**
 * Revenue by lead source - one row per source as entered, then Unknown source
 * and No lead linked, so every job and every payment in the period is
 * accounted for. Collected (Phase 2E) is net payments received in the
 * period, by the source of the lead on the job paid for; its total is the
 * Revenue & payments Collected figure. A failed payment read shows no
 * Collected figure at all, never a partial one. Sideways-scrolling on
 * phones, never the page.
 */
function RevenueBySourceTable({ attribution, cash }: { attribution: RevenueAttribution; cash: CashAttribution }) {
  const { rows, totals } = withCollected(attribution, cash);
  const unavailable = <p className={metaClass}>Collected could not be read for this period. Nothing is estimated in its place.</p>;
  if (rows.length === 0) return cash.failed ? unavailable : <p className={metaClass}>No leads, jobs or payments in this period.</p>;
  const cell = "px-3 py-2 text-right tabular-nums";
  const collected = (value: number) => (cash.failed ? "-" : formatMoney(value));
  return (
    <>
      <div className="-mx-1 overflow-x-auto">
        <table className="w-full min-w-[36rem] text-[13px]">
          <thead>
            <tr className="border-b border-line text-xs text-ink-3">
              <th scope="col" className="px-3 py-2 text-left font-normal">Source</th>
              <th scope="col" className={`${cell} font-normal`}>Leads</th>
              <th scope="col" className={`${cell} font-normal`}>Jobs</th>
              <th scope="col" className={`${cell} font-normal`}>Completed</th>
              <th scope="col" className={`${cell} font-normal`}>Completed value</th>
              <th scope="col" className={`${cell} font-normal`}>Collected</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-b border-line">
                <th scope="row" className={`max-w-[12rem] truncate px-3 py-2 text-left font-normal ${row.kind === "source" ? "text-ink" : "text-ink-3"}`}>{row.label}</th>
                <td className={`${cell} text-ink-2`}>{row.leads === null ? "-" : row.leads}</td>
                <td className={`${cell} text-ink-2`}>{row.jobs}</td>
                <td className={`${cell} text-ink-2`}>{row.completedJobs}</td>
                <td className={`${cell} font-medium text-ink`}>{formatCurrency(row.completedValue)}</td>
                <td className={`${cell} font-medium text-ink`}>{collected(row.collected)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="text-ink">
              <th scope="row" className="px-3 py-2 text-left font-medium">Total</th>
              <td className={`${cell} font-medium`}>{totals.leads}</td>
              <td className={`${cell} font-medium`}>{totals.jobs}</td>
              <td className={`${cell} font-medium`}>{totals.completedJobs}</td>
              <td className={`${cell} font-semibold`}>{formatCurrency(totals.completedValue)}</td>
              <td className={`${cell} font-semibold`}>{collected(totals.collected)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {cash.failed ? unavailable : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// 6. Customer response & communication
// ---------------------------------------------------------------------------

/**
 * snapshot.responseTime - "time to first recorded response," never a
 * delivery time: the timestamp is when Trackpr recorded the outbound
 * message, not a guaranteed provider delivery moment. "Never contacted"
 * leads the panel as its most actionable number. With no contacted lead,
 * the averages read "No recorded response yet", never a fabricated 0.
 */
export function ResponseCommunicationPanel({ snapshot }: { snapshot: BusinessMetricsSnapshot }) {
  const { responseTime, communicationMetrics, comparisons, period } = snapshot;
  const hasAnyResponse = responseTime.leadsContacted > 0;

  return (
    <Panel id="response" title="Customer response & communication" scope={scopeLabel(period.label)}>
      <PrimaryMetrics
        metrics={[
          { key: "never-contacted", label: "Never contacted", value: String(responseTime.leadsNeverContacted), detail: `of ${count(responseTime.totalLeadsInPopulation, "lead", "leads")}`, tone: responseTime.leadsNeverContacted > 0 ? "attention" : undefined },
          { key: "contact-rate", label: "Contact rate", value: formatRate(responseTime.contactRate) },
          { key: "avg-response", label: "Avg. time to first response", value: hasAnyResponse ? formatDuration(responseTime.averageResponseTimeMs) : "No recorded response yet" },
          { key: "median-response", label: "Median time to first response", value: hasAnyResponse ? formatDuration(responseTime.medianResponseTimeMs) : "No recorded response yet" },
        ]}
      />
      <PanelBody>
        <SecondaryMetrics
          metrics={[
            { key: "contacted", label: "Contacted", value: String(responseTime.leadsContacted), ...compared(comparisons.leadsContacted) },
            { key: "inbound", label: "Inbound messages", value: String(communicationMetrics.inboundMessages) },
            { key: "outbound", label: "Outbound messages", value: String(communicationMetrics.outboundMessages) },
            { key: "new-open", label: "New conversations · still open", value: String(communicationMetrics.conversationsOpened) },
            { key: "new-closed", label: "New conversations · now closed", value: String(communicationMetrics.conversationsClosed) },
            { key: "opt-outs", label: "New contacts who opted out", value: String(communicationMetrics.optOutCount) },
          ]}
        />
        <BreakdownGrid>
          {hasAnyResponse ? (
            <PanelBlock label="Time to first response">
              <BarList
                items={[
                  { key: "under_1_min", label: "Under 1 min", value: responseTime.bucketCounts.under_1_min },
                  { key: "1_to_5_min", label: "1-5 min", value: responseTime.bucketCounts["1_to_5_min"] },
                  { key: "5_to_15_min", label: "5-15 min", value: responseTime.bucketCounts["5_to_15_min"] },
                  { key: "15_to_60_min", label: "15-60 min", value: responseTime.bucketCounts["15_to_60_min"] },
                  { key: "1_to_24_hours", label: "1-24 hours", value: responseTime.bucketCounts["1_to_24_hours"] },
                  { key: "over_24_hours", label: "Over 24 hours", value: responseTime.bucketCounts.over_24_hours },
                ]}
              />
            </PanelBlock>
          ) : null}
          <PanelBlock label="Outbound sent by">
            <BarList
              items={[
                { key: "ai", label: "AI", value: communicationMetrics.aiOutboundMessages },
                { key: "team", label: "Your team", value: communicationMetrics.userOutboundMessages },
                { key: "system", label: "System", value: communicationMetrics.systemOutboundMessages },
              ]}
            />
          </PanelBlock>
        </BreakdownGrid>
      </PanelBody>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 7. Scheduling
// ---------------------------------------------------------------------------

/**
 * Phase 2A: appointments by when they take place in the period (start_at),
 * from getAppointmentOccurrenceMetrics - not snapshot.appointmentMetrics,
 * which counts by booking date and stays as-is for Agency and the AI.
 */
export function SchedulingPanel({ snapshot, occurrence }: { snapshot: BusinessMetricsSnapshot; occurrence: BiAppointmentMetrics }) {
  const appointmentMetrics = occurrence;
  const { period } = snapshot;

  return (
    <Panel id="scheduling" title="Scheduling" scope={scopeLabel(period.label)}>
      <PrimaryMetrics
        metrics={[
          { key: "total", label: "Appointments", value: String(appointmentMetrics.totalAppointments) },
          { key: "completed", label: "Completed", value: String(appointmentMetrics.completedAppointments) },
          { key: "no-show", label: "No-shows", value: String(appointmentMetrics.noShowAppointments) },
          { key: "no-show-rate", label: "No-show rate", value: formatRate(appointmentMetrics.appointmentNoShowRate) },
        ]}
      />
      <PanelBody>
        <SecondaryMetrics
          metrics={[
            { key: "scheduled", label: "Scheduled", value: String(appointmentMetrics.scheduledAppointments) },
            { key: "confirmed", label: "Confirmed", value: String(appointmentMetrics.confirmedAppointments) },
            { key: "cancelled", label: "Cancelled", value: String(appointmentMetrics.cancelledAppointments) },
          ]}
        />
        <PanelNote>Appointments by the day they take place, not the day they were booked.</PanelNote>
      </PanelBody>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 8. Retention & reputation
// ---------------------------------------------------------------------------

/**
 * Review/referral request outcomes for the period, then repeat customers -
 * deliberately all time (getRepeatCustomerSummary is not range-scoped:
 * "has this customer come back, ever" isn't a date-range question), so that
 * block carries its own "All time" scope.
 */
export function RetentionPanel({ snapshot, repeat }: { snapshot: BusinessMetricsSnapshot; repeat: RepeatCustomerSummary }) {
  const { reviewReferralMetrics, period } = snapshot;

  return (
    <Panel id="retention" title="Retention & reputation" scope={scopeLabel(period.label)}>
      <PrimaryMetrics
        metrics={[
          { key: "review-response", label: "Review response rate", value: formatRate(reviewReferralMetrics.reviewResponseRateOfSent), detail: `${reviewReferralMetrics.reviewsWithResponse} of ${reviewReferralMetrics.reviewsSent} sent replied` },
          { key: "review-completion", label: "Review completion rate", value: formatRate(reviewReferralMetrics.reviewCompletionRateOfSent), detail: `${reviewReferralMetrics.reviewsCompleted} completed · ${reviewReferralMetrics.reviewsSent} sent` },
          { key: "referral-response", label: "Referral response rate", value: formatRate(reviewReferralMetrics.referralResponseRateOfSent), detail: `${reviewReferralMetrics.referralsWithResponse} of ${reviewReferralMetrics.referralsSent} sent replied` },
          { key: "referral-conversion", label: "Referral conversion rate", value: formatRate(reviewReferralMetrics.referralConversionRateOfSent), detail: `${reviewReferralMetrics.referralsConverted} converted · ${reviewReferralMetrics.referralsSent} sent` },
        ]}
      />
      <PanelBody>
        <PanelBlock label="Repeat customers" scope="All time">
          <SecondaryMetrics
            metrics={[
              { key: "repeat-count", label: "Repeat customers", value: String(repeat.repeatCustomerCount), detail: `of ${repeat.customersWithCompletedJob} with a completed job` },
              { key: "repeat-rate", label: "Repeat customer rate", value: formatRate(repeat.repeatCustomerRate) },
              { key: "completed-jobs", label: "Completed jobs", value: String(repeat.completedJobCount) },
              { key: "known-value", label: "Known completed job value", value: formatCurrency(repeat.knownCompletedJobValue), detail: repeat.averageKnownCompletedJobValue != null ? `${formatCurrency(repeat.averageKnownCompletedJobValue)} average` : undefined },
              {
                key: "additional-jobs",
                label: "Jobs from repeat customers",
                value: String(repeat.additionalCompletedJobCount),
                detail: repeat.additionalCompletedJobKnownValue > 0 ? `${formatCurrency(repeat.additionalCompletedJobKnownValue)} known value` : "Never counts a first job",
              },
            ]}
          />
        </PanelBlock>
      </PanelBody>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 9. Trackpr automation
// ---------------------------------------------------------------------------

/**
 * What the AI and the follow-up automations did in the period - activity
 * counts only. Automation health (events, workflow executions, success
 * rate) belongs to /automations and is linked, not repeated.
 */
export function AutomationPanel({ snapshot }: { snapshot: BusinessMetricsSnapshot }) {
  const { aiMetrics, followUpMetrics, period } = snapshot;

  return (
    <Panel id="automation" title="Trackpr automation" scope={scopeLabel(period.label)}>
      <PrimaryMetrics
        metrics={[
          { key: "interactions", label: "AI interactions", value: String(aiMetrics.customerAiInteractions) },
          { key: "customer-reply", label: "Customer replies answered", value: String(aiMetrics.customerReplyAiInteractions) },
          { key: "outbound-interactions", label: "Messages recommended", value: String(aiMetrics.aiOutboundInteractions) },
          { key: "needs-human", label: "Handed to you", value: String(aiMetrics.aiNeedsHumanCount) },
        ]}
      />
      <PanelBody>
        <SecondaryMetrics
          metrics={[
            { key: "lost-nurture", label: "Lost-lead nurture", value: String(followUpMetrics.lostLeadNurtureEvents) },
            { key: "reactivation", label: "Reactivation", value: String(followUpMetrics.reactivationEvents) },
            { key: "appointment-reminders", label: "Appointment reminders", value: String(followUpMetrics.appointmentReminderEvents) },
            { key: "estimate-followups", label: "Estimate follow-ups", value: String(followUpMetrics.estimateFollowUpEvents) },
            { key: "job-followups", label: "Post-job follow-ups", value: String(followUpMetrics.postJobFollowUpEvents) },
            { key: "leads-touched", label: "Leads touched", value: String(followUpMetrics.leadsTouchedByAutomation) },
          ]}
        />
        <ViewLink href="/automations">Automation health in Automations</ViewLink>
      </PanelBody>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// How these numbers are calculated
// ---------------------------------------------------------------------------

const DEFINITIONS: { term: string; definition: string }[] = [
  { term: "Periods", definition: "Every period uses your business's own timezone and calendar days. Comparisons are calendar periods too: this month to date against the same days of last month, last month against the month before." },
  { term: "Collected", definition: `${SANCTIONED_COLLECTED_REVENUE_DEFINITION} Counted by the date the payment was received, within the selected period.` },
  { term: "Invoiced", definition: "Issued invoices dated within the selected period - money asked for, not received." },
  { term: "Outstanding and Overdue", definition: "Open invoice balances as of today, whatever period is selected. Overdue is judged against today's date in your business's timezone." },
  { term: "Avg. days to payment", definition: "Issue date to the payment that settled the invoice, over invoices fully paid in the period." },
  { term: "Conversion rates", definition: "Ratios over real records, not time-based or causal claims. Lead → booking: of the leads created in the selected period, those with at least one appointment that wasn't cancelled and wasn't a no-show, whenever booked. Estimate acceptance: accepted vs. accepted + declined, counted by the date the customer answered. Estimate → job: accepted estimates that became a job. Job completion: of the jobs created in the selected period, completed vs. completed + cancelled - by creation date, because a cancellation date isn't recorded." },
  { term: "Leads → Qualified / Won and timing", definition: "Based on real, timestamped stage-change events. Timing averages only cover leads with a recorded transition - each shows its own coverage." },
  { term: "Open leads and open lead value", definition: "Leads in an open stage right now, and the estimated value entered on each - a manual estimate, not revenue." },
  { term: "Recoverable estimate value", definition: "Open and expired estimates not yet declined - real opportunity, never guaranteed revenue or a close probability." },
  { term: "Lead sources", definition: "Free text, not standardized - shown for visibility only, never ranked by performance." },
  { term: "Jobs linked to a lead", definition: "Every job you have, all time, that has the lead it came from recorded on it. Jobs created from an estimate take the estimate's lead automatically. Unlinked jobs can't be traced back to a lead source, so this shows how complete your revenue attribution can be." },
  { term: "Revenue by source", definition: "Leads: leads created in the selected period, by the source entered on each lead (as written - sources are not standardized). Jobs: jobs created in the period, not counting cancelled ones. Completed and completed value: jobs marked complete in the period, by the date they were completed, with the contracted amount entered on the job - not payments collected. A job counts toward the source of the lead it is linked to; a lead with no source shows as Unknown source, and a job with no linked lead shows as No lead linked, so no job value is left out. Collected: payments received in the period, net of reversals, each counted toward the source of the lead on the job it pays for - whenever that lead or job was created, so a source can show collected money with no leads or jobs in the period. The Collected total is the same amount as Collected under Revenue & payments." },
  { term: "Lead → job", definition: "Of the leads created in the selected period, how many have at least one job that isn't cancelled, whenever that job was created. Jobs and value completed so far come from those same leads, whenever completed. A lead with several jobs counts once toward the rate." },
  { term: "Completed job value", definition: "Jobs marked complete in the selected period, by the date they were completed, with the contracted amount entered on each job - the same jobs and total as Completed value in Revenue by source. Not payments collected." },
  { term: "Estimate and job values", definition: "Quoted or contracted amounts. Only customer payments recorded in Trackpr count as collected." },
  { term: "New conversations and opt-outs", definition: "Conversations started in the selected period, counted by whether they are still open or now closed - not opened or closed during it. New contacts who opted out are contacts added in the period who have since opted out." },
  { term: "Scheduling", definition: "Appointments by the day they take place in the selected period, not the day they were booked." },
  { term: "Unpaid by age", definition: "Open invoice balances as of today, by whole days past the due date. Current means not yet due, due today, or no due date." },
  { term: "Estimates awaiting a decision", definition: "Estimates still out, by days since they were sent, as of today. Past their expiry date means still awaiting a decision after the date they were quoted to hold." },
  { term: "Declined estimate value", definition: "Quoted value of every estimate a customer turned down, all time - lost work, not period revenue." },
  { term: "Closed opportunities", definition: "Follow-up opportunities that closed in the selected period, dated when Trackpr noticed. Marked lost means the lead was lost; no longer applies means the condition stopped holding, which is not proof the work or money was recovered; dismissed is your own call." },
  { term: "Time to first response", definition: "From lead creation to the first outbound message Trackpr recorded as sent or delivered - not a provider delivery timestamp, and never a claim about when the customer saw it." },
  { term: "Reviews and referrals", definition: "Requests sent in the selected period (never ones that failed to send). A response is a recorded customer reply - a request that replied and was later completed or converted still counts; one completed without a recorded reply does not. Completion and conversion are confirmed by you, not inferred." },
  { term: "Repeat customers", definition: "All time, whatever period is selected. Completed job value is the contracted amount, not collected revenue." },
  { term: "Automation", definition: "Activity counts only - not a claim that a follow-up caused any change in leads, jobs or value. Messages recommended counts what the AI suggested sending, before Trackpr's own send checks." },
  { term: "Observations", definition: "Generated on request from the last 30 days, whatever period is selected above." },
];

/** Every definition the page used to repeat under each section, once, collapsed - plus this period's data-quality notes, in owner-facing language (ownerDataNotes), never the snapshot's raw internal notes. */
export function CalculationsPanel({ snapshot }: { snapshot: BusinessMetricsSnapshot }) {
  const dataNotes = ownerDataNotes(snapshot);
  return (
    <details className="group rounded-lg border border-line bg-surface">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-ink-2 hover:text-ink sm:px-5 [&::-webkit-details-marker]:hidden">
        How these numbers are calculated
        <span className="text-xs text-ink-3 group-open:hidden">Show</span>
        <span className="hidden text-xs text-ink-3 group-open:inline">Hide</span>
      </summary>
      <div className="border-t border-line px-4 py-4 sm:px-5">
        <dl className="grid grid-cols-1 gap-x-8 gap-y-3 lg:grid-cols-2">
          {DEFINITIONS.map((item) => (
            <div key={item.term}>
              <dt className="text-xs font-medium text-ink-2">{item.term}</dt>
              <dd className="mt-0.5 text-xs leading-5 text-ink-3">{item.definition}</dd>
            </div>
          ))}
        </dl>
        {dataNotes.length > 0 ? (
          <div className="mt-4 border-t border-line pt-3">
            <p className="text-xs font-medium text-ink-2">About this period&apos;s data</p>
            <ul className="mt-2 space-y-1.5 text-xs text-ink-3">
              {dataNotes.map((note) => (
                <li key={note} className="flex gap-2">
                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-line-strong" aria-hidden />
                  {note}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </details>
  );
}

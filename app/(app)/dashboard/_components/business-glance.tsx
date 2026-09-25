import { sectionLabelClass, metaClass } from "@/lib/ui/typography";
import { formatCurrency } from "@/lib/dashboard/format";
import type { OverviewMetrics } from "@/lib/dashboard/queries";
import type { BusinessMetricsSnapshot } from "@/lib/bi/types";
import type { OpportunitySummary } from "@/lib/opportunities/queries";
import type { RepeatCustomerSummary, DormantCustomersValueSummary } from "@/lib/customers/lifecycle";
import { formatComparisonBadge, formatRate } from "./period-comparison-format";

/**
 * Dashboard composition redesign: the reference-number rail that replaces
 * the old OverviewStrip + KeyMetrics full-width StatGrid sections. Those two
 * boxed-card grids gave every number on the page the exact same visual
 * weight, which is what made the dashboard read as a stack of interchangeable
 * admin-template sections rather than a designed page. Here the same real
 * numbers (nothing recalculated, nothing invented - see the two source
 * queries) are compressed into a compact label/value list inside the one
 * contained panel on the page, so they read as reference detail supporting
 * the page's real leads - the hero pipeline-value figure in the header and
 * the Needs Attention / Pipeline flow in the main column.
 *
 * Deliberately kept as two clearly-labeled groups rather than one merged
 * list: "Right now" (OverviewMetrics - live current-state counts) and "Last
 * 30 days" (BusinessMetricsSnapshot - a period aggregate). Their similarly-
 * named fields (e.g. open opportunities) are computed differently and would
 * misrepresent the business if silently combined into one number.
 */
function Row({ label, value, description }: { label: string; value: string; description?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <span className="text-sm text-slate-600">{label}</span>
      <span className="text-right">
        <span className="text-sm font-semibold tabular-nums text-slate-900">{value}</span>
        {description ? <span className="ml-1.5 text-xs text-slate-400">{description}</span> : null}
      </span>
    </div>
  );
}

export function BusinessGlance({
  overview,
  snapshot,
  opportunitySummary,
  repeatCustomerSummary,
  dormantCustomerCount,
  dormantCustomersValue,
}: {
  overview: OverviewMetrics;
  snapshot: BusinessMetricsSnapshot;
  /** Pass 3 (Revenue Intelligence Foundation): the unified, all-5-type opportunity count from the opportunities table - distinct from snapshot.revenueOpportunity below, which only reflects 2 of those 5 types (a byproduct of the pre-existing Growth System Completion Pass 2 calculation, kept as-is rather than merged). */
  opportunitySummary: OpportunitySummary;
  /** Pass 4 P1-B: org-wide repeat-customer + "additional job" figures - all-time, not scoped to "Last 30 days" above (see lib/customers/lifecycle.ts's own header for why). */
  repeatCustomerSummary: RepeatCustomerSummary;
  /** Count of contacts with a currently-open dormant_customer opportunity - read directly from the page's own already-fetched opportunities, never re-detected here. */
  dormantCustomerCount: number;
  dormantCustomersValue: DormantCustomersValueSummary;
}) {
  return (
    <div>
      <p className={sectionLabelClass}>Right now</p>
      <div className="mt-1.5 divide-y divide-slate-100">
        <Row label="New leads" value={String(overview.newLeads)} />
        <Row label="Open opportunities" value={String(overview.openOpportunities)} />
        <Row label="Upcoming appointments" value={String(overview.upcomingAppointments)} />
        <Row label="Estimates pending" value={String(overview.pendingEstimates)} />
      </div>

      <p className={`mt-5 ${sectionLabelClass}`}>Last 30 days</p>
      <div className="mt-1.5 divide-y divide-slate-100">
        <Row label="Leads" value={String(snapshot.comparisons.leadCount.current)} description={formatComparisonBadge(snapshot.comparisons.leadCount) ?? undefined} />
        <Row
          label="Estimates"
          value={String(snapshot.comparisons.estimateCount.current)}
          description={`Accept rate ${formatRate(snapshot.estimateMetrics.estimateAcceptanceRate)}`}
        />
        <Row label="Jobs" value={String(snapshot.comparisons.jobCount.current)} description={formatComparisonBadge(snapshot.comparisons.jobCount) ?? undefined} />
        <Row label="Contracted job value" value={formatCurrency(snapshot.jobMetrics.contractedJobValue)} />
        <Row label="Lead → booking rate" value={formatRate(snapshot.leadMetrics.leadToBookingRate)} description="Leads that got an appointment" />
        <Row label="Review rate" value={formatRate(snapshot.reviewReferralMetrics.reviewResponseRate)} description={`${snapshot.reviewReferralMetrics.reviewsRequested} requested`} />
        <Row label="Referral rate" value={formatRate(snapshot.reviewReferralMetrics.referralResponseRate)} description={`${snapshot.reviewReferralMetrics.referralsRequested} requested`} />
      </div>
      <p className={`mt-3 ${metaClass}`}>Quoted amounts, not collected payments.</p>

      <p className={`mt-5 ${sectionLabelClass}`}>Opportunities</p>
      <div className="mt-1.5 divide-y divide-slate-100">
        <Row
          label="Open opportunities"
          value={String(opportunitySummary.count)}
          description={opportunitySummary.knownEstimatedValue > 0 ? `${formatCurrency(opportunitySummary.knownEstimatedValue)} known value` : undefined}
        />
        {opportunitySummary.unknownValueCount > 0 ? (
          <Row label="With unknown value" value={String(opportunitySummary.unknownValueCount)} description="Not guessed, not shown as $0" />
        ) : null}
        <Row label="Recoverable estimate value" value={formatCurrency(snapshot.revenueOpportunity.recoverableEstimateValue)} description="Open + expired, not yet declined" />
        <Row label="Qualified leads, no appointment" value={String(snapshot.revenueOpportunity.qualifiedLeadsWithoutAppointment)} />
        <Row label="Completed visits, no estimate" value={String(snapshot.revenueOpportunity.completedAppointmentsWithoutEstimate)} />
      </div>
      <p className={`mt-3 ${metaClass}`}>Real opportunity, not guaranteed revenue or a close probability.</p>

      <p className={`mt-5 ${sectionLabelClass}`}>Customers</p>
      <div className="mt-1.5 divide-y divide-slate-100">
        <Row
          label="Dormant customers"
          value={String(dormantCustomerCount)}
          description={dormantCustomersValue.knownValue > 0 ? `${formatCurrency(dormantCustomersValue.knownValue)} known value` : undefined}
        />
        {dormantCustomersValue.unknownValueCount > 0 ? (
          <Row label="...with unknown value" value={String(dormantCustomersValue.unknownValueCount)} description="Not guessed, not shown as $0" />
        ) : null}
        <Row label="Repeat customers" value={String(repeatCustomerSummary.repeatCustomerCount)} description={`${formatRate(repeatCustomerSummary.repeatCustomerRate)} of customers with a completed job`} />
        <Row
          label="Additional jobs from repeat customers"
          value={String(repeatCustomerSummary.additionalCompletedJobCount)}
          description={repeatCustomerSummary.additionalCompletedJobKnownValue > 0 ? `${formatCurrency(repeatCustomerSummary.additionalCompletedJobKnownValue)} known value` : undefined}
        />
      </div>
      <p className={`mt-3 ${metaClass}`}>All-time - who keeps coming back, and who may be worth reaching out to.</p>
    </div>
  );
}

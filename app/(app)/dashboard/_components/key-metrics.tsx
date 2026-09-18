import { sectionLabelClass, metaClass } from "@/lib/ui/typography";
import { formatCurrency } from "@/lib/dashboard/format";
import type { BusinessMetricsSnapshot, PeriodComparison } from "@/lib/bi/types";

/**
 * Phase 5.4 - reads Phase 5.2's BusinessMetricsSnapshot only; calculates
 * nothing itself. Every value below is the exact field Phase 5.2 computed -
 * no arithmetic happens in this component beyond formatting for display.
 *
 * "Leads" (not "New Leads") is used deliberately: Phase 5.2's only
 * lead-related period comparison (comparisons.leadCount) measures ALL leads
 * created in the period, not specifically leads currently in the "new"
 * status - labeling it "New Leads" while showing a total-leads-created
 * comparison would misrepresent what the number means. The existing
 * dashboard's own "New leads" stat (current status count, untouched by this
 * phase) already covers that separate, current-state meaning - see
 * OverviewStrip.
 */

export function formatComparisonBadge(comparison: PeriodComparison): string | null {
  // No defined previous period (e.g. an open-ended range) - Phase 5.2
  // returns previous: null in that case; showing nothing is correct here,
  // never a fabricated comparison.
  if (comparison.previous === null) return null;

  if (comparison.percentageChange === null) {
    // previous was 0 - a percentage is undefined, not "0%" or "100%". Show
    // the raw count change instead, which is still a real, non-misleading
    // number.
    if (comparison.change === null || comparison.change === 0) return null;
    const sign = comparison.change > 0 ? "+" : "";
    return `${sign}${comparison.change} vs previous period`;
  }

  const rounded = Math.round(comparison.percentageChange);
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${rounded}% vs previous period`;
}

export function formatRate(rate: number | null): string {
  if (rate === null) return "Not enough data yet";
  return `${Math.round(rate)}%`;
}

type Stat = {
  key: string;
  label: string;
  value: string;
  comparison?: string | null;
  detail?: string;
};

export function KeyMetrics({ snapshot }: { snapshot: BusinessMetricsSnapshot }) {
  const stats: Stat[] = [
    {
      key: "leads",
      label: "Leads",
      value: String(snapshot.comparisons.leadCount.current),
      comparison: formatComparisonBadge(snapshot.comparisons.leadCount),
    },
    {
      key: "open-opportunities",
      label: "Open opportunities",
      value: String(snapshot.pipelineMetrics.openOpportunityCount),
    },
    {
      key: "pipeline-value",
      label: "Pipeline value",
      value: formatCurrency(snapshot.pipelineMetrics.pipelineValue),
    },
    {
      key: "estimates",
      label: "Estimates",
      value: String(snapshot.comparisons.estimateCount.current),
      comparison: formatComparisonBadge(snapshot.comparisons.estimateCount),
      detail: `Acceptance rate: ${formatRate(snapshot.estimateMetrics.estimateAcceptanceRate)}`,
    },
    {
      key: "jobs",
      label: "Jobs",
      value: String(snapshot.comparisons.jobCount.current),
      comparison: formatComparisonBadge(snapshot.comparisons.jobCount),
    },
    {
      key: "contracted-job-value",
      label: "Contracted job value",
      value: formatCurrency(snapshot.jobMetrics.contractedJobValue),
    },
  ];

  return (
    <div className="border-t border-slate-200 pt-8">
      <p className={sectionLabelClass}>Key metrics · last 30 days</p>
      <dl className="mt-3 grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3 lg:grid-cols-6">
        {stats.map((stat) => (
          <div key={stat.key}>
            <dt className="text-xs text-slate-500">{stat.label}</dt>
            <dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-slate-900">{stat.value}</dd>
            {stat.comparison ? <p className="mt-0.5 text-xs text-slate-500">{stat.comparison}</p> : null}
            {stat.detail ? <p className="mt-0.5 text-xs text-slate-500">{stat.detail}</p> : null}
          </div>
        ))}
      </dl>
      <p className={`mt-4 ${metaClass}`}>
        Pipeline, estimate, and job values shown here are quoted amounts, not collected payments - Trackpr does not yet track payment data.
      </p>
    </div>
  );
}

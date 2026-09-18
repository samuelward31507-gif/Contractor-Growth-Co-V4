import { sectionLabelClass, metaClass } from "@/lib/ui/typography";
import { formatCurrency } from "@/lib/dashboard/format";
import { formatRate, formatCount } from "./format";
import { StatGrid, type Stat } from "./stat-grid";
import type { AgencyBusinessSummary } from "@/lib/agency/queries";

/**
 * Agency-wide totals - straight reuse of AgencyBusinessSummary's own field
 * names, never relabeled. Pipeline/estimate/job values are quoted or
 * contracted figures, exactly as lib/bi/types.ts documents them - never
 * "revenue."
 */
export function OverviewCards({ summary }: { summary: AgencyBusinessSummary }) {
  const stats: Stat[] = [
    { key: "organizations", label: "Organizations", value: formatCount(summary.organizationCount) },
    { key: "leads", label: "Leads", value: formatCount(summary.totalLeads) },
    { key: "open-opportunities", label: "Open opportunities", value: formatCount(summary.openOpportunityCount) },
    { key: "pipeline-value", label: "Pipeline value", value: formatCurrency(summary.pipelineValue) },
    { key: "estimates", label: "Estimates", value: formatCount(summary.totalEstimates) },
    { key: "estimate-acceptance-rate", label: "Estimate acceptance rate", value: formatRate(summary.estimateAcceptanceRate) },
    { key: "jobs", label: "Jobs", value: formatCount(summary.totalJobs) },
    { key: "contracted-job-value", label: "Contracted job value", value: formatCurrency(summary.contractedJobValue) },
  ];

  return (
    <div className="border-t border-slate-200 pt-8">
      <p className={sectionLabelClass}>Agency overview</p>
      <div className="mt-3">
        <StatGrid stats={stats} />
      </div>
      <p className={`mt-4 ${metaClass}`}>
        Pipeline, estimate, and job values shown here are quoted or contracted amounts, not collected payments - Trackpr does not track payment data.
      </p>
    </div>
  );
}

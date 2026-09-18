import { Building2, Users, Target, Wallet, FileText, Percent, Briefcase, Banknote } from "lucide-react";
import { formatCurrency } from "@/lib/dashboard/format";
import { formatRate, formatCount } from "./format";
import { StatGrid, type Stat } from "./stat-grid";
import { SectionCard } from "./section-card";
import type { AgencyBusinessSummary } from "@/lib/agency/queries";

/**
 * Agency-wide totals - straight reuse of AgencyBusinessSummary's own field
 * names, never relabeled. Pipeline/estimate/job values are quoted or
 * contracted figures, exactly as lib/bi/types.ts documents them - never
 * "revenue."
 */
export function OverviewCards({ summary }: { summary: AgencyBusinessSummary }) {
  const stats: Stat[] = [
    { key: "organizations", label: "Organizations", value: formatCount(summary.organizationCount), icon: Building2 },
    { key: "leads", label: "Leads", value: formatCount(summary.totalLeads), icon: Users },
    { key: "open-opportunities", label: "Open opportunities", value: formatCount(summary.openOpportunityCount), icon: Target },
    { key: "pipeline-value", label: "Pipeline value", value: formatCurrency(summary.pipelineValue), icon: Wallet },
    { key: "estimates", label: "Estimates", value: formatCount(summary.totalEstimates), icon: FileText },
    { key: "estimate-acceptance-rate", label: "Estimate acceptance rate", value: formatRate(summary.estimateAcceptanceRate), icon: Percent },
    { key: "jobs", label: "Jobs", value: formatCount(summary.totalJobs), icon: Briefcase },
    { key: "contracted-job-value", label: "Contracted job value", value: formatCurrency(summary.contractedJobValue), icon: Banknote },
  ];

  return (
    <SectionCard title="Agency overview" icon={Building2}>
      <StatGrid stats={stats} columns="sm:grid-cols-4" />
      <p className="mt-3 text-xs text-slate-400">
        Pipeline, estimate, and job values shown here are quoted or contracted amounts, not collected payments - Trackpr does not track payment data.
      </p>
    </SectionCard>
  );
}

import { formatCount } from "./format";
import type { AutomationMetrics } from "@/lib/bi/types";
import type { AutomationSummary } from "@/lib/automation/queries";

function formatRate(rate: number | null): string {
  if (rate === null) return "Not enough data yet";
  return `${Math.round(rate)}%`;
}

/**
 * Compact summary strip - every number here comes directly from
 * lib/bi/queries.ts's existing getAutomationAndFollowUpMetrics aggregate
 * (last 30 days, org-scoped by RLS) plus the per-automation status this
 * page already computed - nothing is recalculated or fabricated. Success
 * rate is null, not 0%, when there is no completed-or-failed execution to
 * compute it from yet.
 */
export function SummaryCards({ overview, summaries }: { overview: AutomationMetrics; summaries: AutomationSummary[] }) {
  const activeCount = summaries.filter((s) => s.status === "active").length;
  const successRate =
    overview.completedWorkflows + overview.failedWorkflows === 0 ? null : (overview.completedWorkflows / (overview.completedWorkflows + overview.failedWorkflows)) * 100;

  const stats = [
    { key: "active", label: "Active automations", value: formatCount(activeCount) },
    { key: "executions", label: "Recent executions", value: formatCount(overview.totalWorkflowExecutions) },
    { key: "failed", label: "Failed executions", value: formatCount(overview.failedWorkflows), tone: overview.failedWorkflows > 0 ? "text-red-600" : "text-slate-900" },
    { key: "success-rate", label: "Success rate", value: formatRate(successRate) },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {stats.map((stat) => (
        <div key={stat.key} className="rounded-lg border border-slate-200 bg-white px-3.5 py-2.5">
          <p className="text-[10.5px] font-medium uppercase tracking-wide text-slate-500">{stat.label}</p>
          <p className={`mt-1 text-xl font-semibold tracking-tight tabular-nums ${stat.tone ?? "text-slate-900"}`}>{stat.value}</p>
        </div>
      ))}
    </div>
  );
}

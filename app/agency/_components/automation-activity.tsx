import { sectionLabelClass, metaClass } from "@/lib/ui/typography";
import { formatRate, formatCount } from "./format";
import { StatGrid, type Stat } from "./stat-grid";
import type { AgencyBusinessSummary } from "@/lib/agency/queries";

/**
 * Activity counts only - never a claim that automation caused any
 * downstream business outcome (matches the same discipline lib/bi/types.ts
 * already applies to FollowUpMetrics).
 */
export function AutomationActivity({ summary, stuckCount }: { summary: AgencyBusinessSummary; stuckCount: number }) {
  const stats: Stat[] = [
    { key: "workflow-executions", label: "Workflow executions", value: formatCount(summary.workflowExecutions) },
    { key: "completed", label: "Completed", value: formatCount(summary.successfulWorkflowExecutions) },
    { key: "failed", label: "Failed", value: formatCount(summary.failedWorkflowExecutions) },
    { key: "running", label: "Running", value: formatCount(summary.runningWorkflowExecutions) },
    { key: "stuck", label: "Stuck", value: formatCount(stuckCount) },
    { key: "success-rate", label: "Success rate", value: formatRate(summary.automationSuccessRate) },
  ];

  return (
    <div className="border-t border-slate-200 pt-8">
      <p className={sectionLabelClass}>Automation activity</p>
      <div className="mt-3">
        <StatGrid stats={stats} columns="sm:grid-cols-3 lg:grid-cols-6" />
      </div>
      <p className={`mt-4 ${metaClass}`}>Activity counts only - not a claim that automation caused any change in leads, jobs, or pipeline value.</p>
    </div>
  );
}

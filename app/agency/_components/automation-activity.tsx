import { Workflow, CheckCircle2, XCircle, Loader2, AlertTriangle, Percent } from "lucide-react";
import { SectionCard } from "@/lib/ui/section-card";
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
    { key: "workflow-executions", label: "Executions", value: formatCount(summary.workflowExecutions), icon: Workflow },
    { key: "completed", label: "Completed", value: formatCount(summary.successfulWorkflowExecutions), icon: CheckCircle2 },
    { key: "failed", label: "Failed", value: formatCount(summary.failedWorkflowExecutions), icon: XCircle, tone: summary.failedWorkflowExecutions > 0 ? "danger" : "default" },
    { key: "running", label: "Running", value: formatCount(summary.runningWorkflowExecutions), icon: Loader2 },
    { key: "stuck", label: "Stuck", value: formatCount(stuckCount), icon: AlertTriangle, tone: stuckCount > 0 ? "warning" : "default" },
    { key: "success-rate", label: "Success rate", value: formatRate(summary.automationSuccessRate), icon: Percent },
  ];

  return (
    <SectionCard title="Automation activity" icon={Workflow}>
      <StatGrid stats={stats} columns="sm:grid-cols-3 lg:grid-cols-6" />
      <p className="mt-3 text-xs text-slate-400">Activity counts only - not a claim that automation caused any change in leads, jobs, or pipeline value.</p>
    </SectionCard>
  );
}

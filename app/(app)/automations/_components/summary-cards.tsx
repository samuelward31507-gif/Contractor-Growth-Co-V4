import { Zap, AlertTriangle } from "lucide-react";
import { StatGrid, StatCard } from "@/lib/ui/stat-card";
import { formatCount } from "./format";
import type { AutomationMetrics } from "@/lib/bi/types";
import type { AutomationSummary } from "@/lib/automation/queries";

function formatRate(rate: number | null): string {
  if (rate === null) return "Not enough data yet";
  return `${Math.round(rate)}%`;
}

/**
 * Final visual polish pass: StatGrid/StatCard (lib/ui/stat-card.tsx) instead
 * of the old hand-rolled compact card row, matching every other overview row
 * in the app. Every number here still comes directly from
 * lib/bi/queries.ts's existing getAutomationAndFollowUpMetrics aggregate
 * (last 30 days, org-scoped by RLS) plus the per-automation status this page
 * already computed - nothing is recalculated or fabricated. Success rate is
 * "Not enough data yet", not 0%, when there is no completed-or-failed
 * execution to compute it from yet. Active automations gets the one
 * success-tone icon chip when there's actually at least one running -
 * failed executions gets a danger-tone icon chip only when count > 0 (the
 * StatCard contract never recolors the card background or value text
 * itself, only this small chip, so a bad day still reads calm rather than
 * alarming).
 */
export function SummaryCards({ overview, summaries }: { overview: AutomationMetrics; summaries: AutomationSummary[] }) {
  const activeCount = summaries.filter((s) => s.status === "active").length;
  const successRate =
    overview.completedWorkflows + overview.failedWorkflows === 0 ? null : (overview.completedWorkflows / (overview.completedWorkflows + overview.failedWorkflows)) * 100;

  return (
    <StatGrid columns={4}>
      <StatCard label="Active automations" value={formatCount(activeCount)} tone={activeCount > 0 ? "success" : "neutral"} icon={activeCount > 0 ? Zap : undefined} />
      <StatCard label="Recent executions" value={formatCount(overview.totalWorkflowExecutions)} />
      <StatCard
        label="Failed executions"
        value={formatCount(overview.failedWorkflows)}
        tone={overview.failedWorkflows > 0 ? "danger" : "neutral"}
        icon={overview.failedWorkflows > 0 ? AlertTriangle : undefined}
      />
      <StatCard label="Success rate" value={formatRate(successRate)} />
    </StatGrid>
  );
}

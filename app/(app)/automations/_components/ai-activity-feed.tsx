import { CheckCircle2, XCircle, Loader2, CircleSlash, Bot } from "lucide-react";
import { getAutomationForWorkflowName } from "@/lib/automation/catalog";
import { EmptyState } from "@/lib/ui/empty-state";
import { Badge, type BadgeTone } from "@/lib/ui/badge";
import { formatRelativeTime } from "./format";
import type { AutomationExecutionRow, WorkflowExecutionStatus } from "@/lib/automation/queries";

const STATUS_BADGE: Record<WorkflowExecutionStatus, { label: string; tone: BadgeTone; icon: typeof CheckCircle2 }> = {
  completed: { label: "Completed", tone: "success", icon: CheckCircle2 },
  failed: { label: "Failed", tone: "danger", icon: XCircle },
  running: { label: "Running", tone: "info", icon: Loader2 },
  cancelled: { label: "Cancelled", tone: "neutral", icon: CircleSlash },
};

/**
 * Trackpr 2.0 Phase 3: a plain-language "what the AI has been doing" feed,
 * distinct from RecentExecutions' technical per-automation table (workflow
 * name, attempt, retry) used on each automation's own detail page. Reuses
 * getRecentExecutionsForWorkflows exactly as-is, scoped by the caller to
 * getAiAgentWorkflowNames() (ai-agents.tsx) so this only ever shows
 * genuinely AI-drafted work, never the template-only automations. Status
 * labels match execution-row.tsx's own vocabulary (Completed/Failed/
 * Running/Cancelled) rather than a stronger word like "Sent" - a completed
 * execution recorded here went through Safe AI Outbound, but this list does
 * not itself re-derive or assert that a message definitely reached the
 * customer.
 */
export function AiActivityFeed({ executions }: { executions: AutomationExecutionRow[] }) {
  if (executions.length === 0) {
    return (
      <EmptyState
        icon={Bot}
        title="No AI activity yet"
        description="AI-drafted messages will show up here as your agents start handling leads and conversations."
      />
    );
  }

  return (
    <ul className="divide-y divide-slate-100">
      {executions.map((execution) => {
        const definition = getAutomationForWorkflowName(execution.workflowName);
        const statusBadge = STATUS_BADGE[execution.status];
        return (
          <li key={execution.id} className="flex items-center justify-between gap-4 py-2.5">
            <span className="min-w-0 truncate text-sm text-slate-700">{definition?.name ?? execution.workflowName}</span>
            <span className="flex shrink-0 items-center gap-3">
              <Badge tone={statusBadge.tone} icon={statusBadge.icon}>
                {statusBadge.label}
              </Badge>
              <span className="text-xs tabular-nums text-slate-400">{formatRelativeTime(execution.startedAt)}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

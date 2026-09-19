import { CheckCircle2, XCircle, Loader2, CircleSlash } from "lucide-react";
import { formatDateTime, formatDurationMs } from "./format";
import { RetryButton } from "./retry-button";
import { MAX_WORKFLOW_RETRY_ATTEMPTS } from "@/lib/automation/executions";
import type { AutomationExecutionRow, WorkflowExecutionStatus } from "@/lib/automation/queries";

const STATUS_ICON: Record<WorkflowExecutionStatus, typeof CheckCircle2> = {
  completed: CheckCircle2,
  failed: XCircle,
  running: Loader2,
  cancelled: CircleSlash,
};
const STATUS_CLASS: Record<WorkflowExecutionStatus, string> = {
  completed: "text-emerald-600",
  failed: "text-red-600",
  running: "text-slate-400",
  cancelled: "text-slate-400",
};

/**
 * Operational execution log only - workflow name, status, timing, and
 * whether an error was recorded. Never renders customer message bodies,
 * phone numbers, emails, or the raw error_message/metadata columns (see
 * lib/automation/queries.ts's getRecentExecutionsForWorkflows, which never
 * selects or forwards that text client-side to begin with - not merely
 * hidden here).
 */
export function RecentExecutions({ executions }: { executions: AutomationExecutionRow[] }) {
  if (executions.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50/60 px-4 py-6 text-center">
        <p className="text-sm font-medium text-slate-900">No executions yet</p>
        <p className="mt-0.5 text-xs text-slate-500">This automation is configured but hasn&apos;t processed any events yet.</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-[10.5px] font-medium uppercase tracking-wide text-slate-400">
            <th className="py-2 pl-4 pr-4 font-medium">Status</th>
            <th className="py-2 pr-4 font-medium">Started</th>
            <th className="py-2 pr-4 font-medium">Completed</th>
            <th className="py-2 pr-4 font-medium">Duration</th>
            <th className="py-2 pr-4 font-medium">Attempt</th>
            <th className="py-2 pr-4 font-medium">Retry</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {executions.map((execution) => {
            const Icon = STATUS_ICON[execution.status];
            const durationMs = execution.completedAt ? new Date(execution.completedAt).getTime() - new Date(execution.startedAt).getTime() : null;
            // Rendering-only heuristic - the server action independently
            // re-verifies every eligibility rule regardless of this.
            const retryEligible = execution.status === "failed" && execution.attempt < MAX_WORKFLOW_RETRY_ATTEMPTS;
            return (
              <tr key={execution.id}>
                <td className="py-2 pl-4 pr-4">
                  <span className={`inline-flex items-center gap-1.5 font-medium ${STATUS_CLASS[execution.status]}`}>
                    <Icon className="h-3.5 w-3.5" aria-hidden />
                    {execution.status[0].toUpperCase() + execution.status.slice(1)}
                  </span>
                </td>
                <td className="py-2 pr-4 tabular-nums text-slate-700">{formatDateTime(execution.startedAt)}</td>
                <td className="py-2 pr-4 tabular-nums text-slate-700">{execution.completedAt ? formatDateTime(execution.completedAt) : "—"}</td>
                <td className="py-2 pr-4 tabular-nums text-slate-500">{durationMs !== null ? formatDurationMs(durationMs) : "—"}</td>
                <td className="py-2 pr-4 tabular-nums text-slate-500">{execution.attempt}</td>
                <td className="py-2 pr-4">{retryEligible ? <RetryButton executionId={execution.id} /> : <span className="text-xs text-slate-300">—</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";
import { CheckCircle2, XCircle, Loader2, CircleSlash, ChevronRight, ChevronDown } from "lucide-react";
import { formatDateTime, formatDurationMs } from "./format";
import { RetryButton } from "./retry-button";
import { ExecutionDetailView } from "./execution-detail-view";
import { getExecutionDetailAction } from "../actions";
import { MAX_WORKFLOW_RETRY_ATTEMPTS } from "@/lib/automation/executions";
import type { AutomationExecutionRow, WorkflowExecutionStatus, WorkflowExecutionTriggerSource } from "@/lib/automation/queries";
import type { ExecutionDetail } from "@/lib/automation/execution-detail";

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
const TRIGGER_LABEL: Record<WorkflowExecutionTriggerSource, string> = {
  event: "Automatic",
  manual: "Manual",
  retry: "Retry",
};

/**
 * One Recent Executions row (Phase F/G) - a client component only because
 * clicking it fetches and expands the Phase F execution detail on demand
 * (getExecutionDetailAction), member-accessible, never fetched eagerly for
 * every row up front. Retry (Phase E) is shown only when both this row
 * looks eligible AND the parent page says this automation supports retry
 * at all (retrySupported, derived from the same SAFE_RETRY_AUTOMATION_IDS
 * allowlist retry-eligibility.ts enforces server-side) - this is a display
 * convenience only; retryExecution's own server-side check remains the real
 * authority regardless of what renders here.
 */
export function ExecutionRow({ execution, retrySupported }: { execution: AutomationExecutionRow; retrySupported: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<ExecutionDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const Icon = STATUS_ICON[execution.status];
  const durationMs = execution.completedAt ? new Date(execution.completedAt).getTime() - new Date(execution.startedAt).getTime() : null;
  // Rendering-only heuristic - retryExecution's own server-side eligibility
  // check (status, parent event state, enabled state, retry ceiling) is the
  // real authority regardless of what this decides to show.
  const retryEligible = retrySupported && execution.status === "failed" && execution.attempt < MAX_WORKFLOW_RETRY_ATTEMPTS;

  function toggle() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (!detail && !detailError) {
      startTransition(async () => {
        const result = await getExecutionDetailAction(execution.id);
        if (!result.ok) {
          setDetailError(result.error);
          return;
        }
        setDetail(result.detail);
      });
    }
  }

  return (
    <>
      <tr className="cursor-pointer hover:bg-slate-50" onClick={toggle}>
        <td className="py-2 pl-4 pr-2">
          {expanded ? <ChevronDown className="h-3.5 w-3.5 text-slate-400" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5 text-slate-400" aria-hidden />}
        </td>
        <td className="py-2 pr-4">
          <span className={`inline-flex items-center gap-1.5 font-medium ${STATUS_CLASS[execution.status]}`}>
            <Icon className="h-3.5 w-3.5" aria-hidden />
            {execution.status[0].toUpperCase() + execution.status.slice(1)}
          </span>
        </td>
        <td className="py-2 pr-4 text-slate-600">{TRIGGER_LABEL[execution.triggerSource]}</td>
        <td className="py-2 pr-4 tabular-nums text-slate-700">{formatDateTime(execution.startedAt)}</td>
        <td className="py-2 pr-4 tabular-nums text-slate-700">{execution.completedAt ? formatDateTime(execution.completedAt) : "—"}</td>
        <td className="py-2 pr-4 tabular-nums text-slate-500">{durationMs !== null ? formatDurationMs(durationMs) : "—"}</td>
        <td className="py-2 pr-4 tabular-nums text-slate-500">{execution.attempt}</td>
        <td className="py-2 pr-4" onClick={(e) => e.stopPropagation()}>
          {retryEligible ? <RetryButton executionId={execution.id} /> : <span className="text-xs text-slate-300">—</span>}
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={8} className="p-0">
            {isPending ? (
              <p className="border-t border-slate-100 px-4 py-4 text-xs text-slate-400">Loading details…</p>
            ) : detailError ? (
              <p className="border-t border-slate-100 px-4 py-4 text-xs text-red-600">{detailError}</p>
            ) : detail ? (
              <ExecutionDetailView detail={detail} />
            ) : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

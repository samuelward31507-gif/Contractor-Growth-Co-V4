"use client";

import { useId, useState, useTransition } from "react";
import { CheckCircle2, XCircle, Loader2, CircleSlash, ChevronRight, ChevronDown } from "lucide-react";
import { formatDateTime, formatDurationMs } from "./format";
import { RetryButton } from "./retry-button";
import { ExecutionDetailView } from "./execution-detail-view";
import { getExecutionDetailAction } from "../actions";
import { Badge, type BadgeTone } from "@/lib/ui/badge";
import { MAX_WORKFLOW_RETRY_ATTEMPTS } from "@/lib/automation/executions";
import type { AutomationExecutionRow, WorkflowExecutionStatus, WorkflowExecutionTriggerSource } from "@/lib/automation/queries";
import type { ExecutionDetail } from "@/lib/automation/execution-detail";

const STATUS_BADGE: Record<WorkflowExecutionStatus, { label: string; tone: BadgeTone; icon: typeof CheckCircle2 }> = {
  completed: { label: "Completed", tone: "success", icon: CheckCircle2 },
  failed: { label: "Failed", tone: "danger", icon: XCircle },
  running: { label: "Running", tone: "info", icon: Loader2 },
  cancelled: { label: "Cancelled", tone: "neutral", icon: CircleSlash },
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
  const detailId = useId();

  const statusBadge = STATUS_BADGE[execution.status];
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
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggle();
            }}
            aria-expanded={expanded}
            aria-controls={detailId}
            aria-label={expanded ? "Hide execution details" : "Show execution details"}
            className="flex h-6 w-6 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/10"
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
          </button>
        </td>
        <td className="py-2 pr-4">
          <Badge tone={statusBadge.tone} icon={statusBadge.icon}>
            {statusBadge.label}
          </Badge>
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
        <tr id={detailId}>
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

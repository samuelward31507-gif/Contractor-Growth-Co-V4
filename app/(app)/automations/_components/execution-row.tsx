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
 *
 * Trackpr 2.0, Phase 3H: rebuilt from a `<tr>`/`<td>` row (whose expand
 * toggle had to live on a small nested icon-button using
 * `stopPropagation()` to escape a click handler on the row's own `<tr>`) to
 * a single real `<button>` covering the whole expandable header - a plain
 * a11y improvement (no nested interactive elements, no synthetic click
 * plumbing) alongside the layout change, with the exact same
 * aria-expanded/aria-controls contract preserved. Retry remains an
 * independent sibling control, never nested inside the toggle button.
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
    <li>
      <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={expanded}
          aria-controls={detailId}
          className="group flex min-w-0 flex-1 items-start gap-3 rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/10"
        >
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-slate-400 group-hover:text-slate-600">
            {expanded ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={statusBadge.tone} icon={statusBadge.icon}>
                {statusBadge.label}
              </Badge>
              <span className="text-xs text-slate-500">{TRIGGER_LABEL[execution.triggerSource]}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-slate-500">
              <span>Started {formatDateTime(execution.startedAt)}</span>
              <span>{execution.completedAt ? `Completed ${formatDateTime(execution.completedAt)}` : "In progress"}</span>
              {durationMs !== null ? <span>{formatDurationMs(durationMs)}</span> : null}
              <span>Attempt {execution.attempt}</span>
            </div>
          </div>
        </button>

        <div className="shrink-0 self-start sm:pl-3">{retryEligible ? <RetryButton executionId={execution.id} /> : null}</div>
      </div>

      {expanded ? (
        <div id={detailId}>
          {isPending ? (
            <p className="border-t border-slate-100 px-4 py-4 text-xs text-slate-400">Loading details…</p>
          ) : detailError ? (
            <p className="border-t border-slate-100 px-4 py-4 text-xs text-danger-text">{detailError}</p>
          ) : detail ? (
            <ExecutionDetailView detail={detail} />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

"use client";

import { useState, useTransition } from "react";
import { retryExecution } from "../actions";

/**
 * Retry (Phase E) - only ever rendered by RecentExecutions for a row whose
 * status is "failed" and whose attempt is below MAX_WORKFLOW_RETRY_ATTEMPTS
 * (a client-side rendering heuristic only). The server action independently
 * re-verifies every eligibility rule (status, parent event, enabled state,
 * retry ceiling) regardless of what this component decided to render.
 */
export function RetryButton({ executionId }: { executionId: string }) {
  const [isPending, startTransition] = useTransition();
  const [state, setState] = useState<"idle" | "confirm" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  function handleClick() {
    if (state !== "confirm") {
      setState("confirm");
      return;
    }

    startTransition(async () => {
      const result = await retryExecution(executionId);
      if (result.error) {
        setState("error");
        setMessage(result.error);
        return;
      }
      setState("done");
      setMessage(result.auditWarning ?? "Retry started.");
    });
  }

  if (state === "done") {
    return <span className="text-xs text-emerald-700">{message}</span>;
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={isPending}
        className={
          state === "confirm"
            ? "rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-900/10 disabled:cursor-not-allowed disabled:opacity-40"
            : "rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/10 disabled:cursor-not-allowed disabled:opacity-40"
        }
      >
        {isPending ? "Retrying…" : state === "confirm" ? "Confirm retry?" : "Retry"}
      </button>
      {state === "error" && message ? <span className="text-xs text-red-600">{message}</span> : null}
    </div>
  );
}

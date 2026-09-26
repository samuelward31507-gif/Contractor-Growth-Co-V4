"use client";

import { useState, useTransition } from "react";
import { markReviewCompleted, markReviewDeclined } from "../../jobs/actions";

/**
 * Trackpr 2.0, Phase 3G: the exact same review-resolution Server Actions
 * app/(app)/jobs/[id]/_components/review-referral-panel.tsx already calls -
 * reused directly, not reimplemented. Mirrors
 * app/(app)/dashboard/_components/dismiss-opportunity-button.tsx's own
 * shape (a plain button that calls the action, then swaps to a static
 * label on success) rather than review-referral-panel's router.refresh()
 * pattern, since a Growth row - unlike the job detail page - doesn't need
 * the rest of the page to re-render to stay correct.
 */
export function ReviewQuickActions({ jobId }: { jobId: string }) {
  const [isPending, startTransition] = useTransition();
  const [resolved, setResolved] = useState<"completed" | "declined" | null>(null);
  const [error, setError] = useState<string | null>(null);

  function resolve(action: "completed" | "declined") {
    startTransition(async () => {
      const result = action === "completed" ? await markReviewCompleted(jobId) : await markReviewDeclined(jobId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setResolved(action);
    });
  }

  if (resolved) {
    return <span className="text-xs font-medium text-slate-500">{resolved === "completed" ? "Marked left" : "Marked declined"}</span>;
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => resolve("completed")}
          disabled={isPending}
          className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Mark left
        </button>
        <button
          type="button"
          onClick={() => resolve("declined")}
          disabled={isPending}
          className="rounded-lg px-2.5 py-1 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Mark declined
        </button>
      </div>
      {error ? <span className="text-xs text-danger-text">{error}</span> : null}
    </div>
  );
}

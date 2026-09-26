"use client";

import { useState, useTransition } from "react";
import { markReferralConverted, markReferralDeclined } from "../../jobs/actions";

/**
 * Trackpr 2.0, Phase 3G: reuses markReferralConverted/markReferralDeclined
 * exactly as app/(app)/jobs/[id]/_components/review-referral-panel.tsx
 * already does. That panel also offers picking a specific lead or creating
 * one from scratch inline (a multi-field sub-form) before marking a
 * referral converted - deliberately not duplicated here. A Growth row that
 * already knows which lead a referral produced (see referredLeadId in the
 * parent list) has nothing left to pick; one that doesn't yet can still be
 * marked converted with no lead attached, and the fuller lead-linking flow
 * remains on the job's own detail page (linked from every row) rather than
 * being rebuilt a second time here.
 */
export function ReferralQuickActions({ jobId }: { jobId: string }) {
  const [isPending, startTransition] = useTransition();
  const [resolved, setResolved] = useState<"converted" | "declined" | null>(null);
  const [error, setError] = useState<string | null>(null);

  function resolve(action: "converted" | "declined") {
    startTransition(async () => {
      const result = action === "converted" ? await markReferralConverted(jobId, null) : await markReferralDeclined(jobId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setResolved(action);
    });
  }

  if (resolved) {
    return <span className="text-xs font-medium text-slate-500">{resolved === "converted" ? "Marked converted" : "Marked declined"}</span>;
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => resolve("converted")}
          disabled={isPending}
          className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Mark converted
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

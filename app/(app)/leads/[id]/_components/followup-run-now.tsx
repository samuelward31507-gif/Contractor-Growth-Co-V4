"use client";

import { useActionState } from "react";
import { FlaskConical } from "lucide-react";
import { Badge } from "@/lib/ui/badge";
import { errorBannerClass, secondaryButtonAutoClass, successBannerClass } from "@/lib/ui/form";
import { runFollowupNow, type RunFollowupNowState } from "../../actions";

const initialState: RunFollowupNowState = {};

/**
 * P0 A4: TEST-mode-only view of this lead's follow-up, rendered by the lead
 * page only on a non-production deployment, for an org owner/admin, while
 * the organization is in TEST mode (runFollowupNow re-checks all three).
 * "Run now" runs the same dispatcher, with every check, just without
 * waiting for the due time.
 */
export function FollowupRunNow({
  followupId,
  stateLabel,
  touchesUsed,
  touchesTotal,
  nextActionLabel,
  reason,
  canRun,
}: {
  followupId: string;
  stateLabel: string;
  touchesUsed: number;
  touchesTotal: number;
  nextActionLabel: string | null;
  reason: string | null;
  canRun: boolean;
}) {
  const [state, formAction, isPending] = useActionState(runFollowupNow, initialState);
  return (
    <details className="rounded-lg border border-line bg-canvas px-4 py-3">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium text-ink-3">
        <FlaskConical className="h-3.5 w-3.5 shrink-0" aria-hidden />
        Follow-up: {stateLabel} · {touchesUsed} of {touchesTotal} touches
        <Badge tone="warning">TEST mode</Badge>
      </summary>
      <form action={formAction} className="mt-3 space-y-2">
        {state.error ? <p className={errorBannerClass} role="alert">{state.error}</p> : null}
        {state.result ? <p className={successBannerClass} role="status">{state.result}</p> : null}
        <input type="hidden" name="followupId" value={followupId} />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-ink-3">
            {nextActionLabel ?? (reason ? `Reason: ${reason}` : "No further touches.")} Run now uses the same checks as a scheduled run;
            nothing is sent while the organization is in TEST mode.
          </p>
          {canRun ? (
            <button type="submit" disabled={isPending} className={`shrink-0 ${secondaryButtonAutoClass}`}>
              {isPending ? "Running…" : "Run now"}
            </button>
          ) : null}
        </div>
      </form>
    </details>
  );
}

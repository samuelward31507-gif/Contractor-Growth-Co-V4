"use client";

import { useActionState } from "react";
import { FlaskConical } from "lucide-react";
import { Badge } from "@/lib/ui/badge";
import { errorBannerClass, secondaryButtonAutoClass, successBannerClass } from "@/lib/ui/form";
import { runLeadTouchNow, type RunLeadTouchNowState } from "../../actions";

const initialState: RunLeadTouchNowState = {};

const LABELS = {
  "lost-lead-nurture": { title: "Lost-lead nurture", button: "Run nurture now" },
  "lead-reactivation": { title: "Lead reactivation", button: "Run reactivation now" },
} as const;

/**
 * P0-B B2.8f: TEST-mode-only control under a lead on its person page
 * (app/(app)/people/[id]), shown only on a non-production deployment, for an
 * org owner/admin, while the organization is in TEST mode - the same three
 * conditions as the A4 follow-up panel (runLeadTouchNow re-checks all
 * three). It evaluates the lead's next nurture or reactivation touch now,
 * with every check, just without waiting for the cadence.
 */
export function LeadTouchRunNow({ leadId, automation }: { leadId: string; automation: keyof typeof LABELS }) {
  const [state, formAction, isPending] = useActionState(runLeadTouchNow, initialState);
  const label = LABELS[automation];
  return (
    <details className="rounded-lg border border-line bg-canvas px-4 py-3">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium text-ink-3">
        <FlaskConical className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {label.title}
        <Badge tone="warning">TEST mode</Badge>
      </summary>
      <form action={formAction} className="mt-3 space-y-2">
        {state.error ? <p className={errorBannerClass} role="alert">{state.error}</p> : null}
        {state.result ? <p className={successBannerClass} role="status">{state.result}</p> : null}
        <input type="hidden" name="leadId" value={leadId} />
        <input type="hidden" name="automation" value={automation} />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-ink-3">
            TEST only. Runs the next touch now with the same checks as a scheduled run; nothing is sent while the organization is in TEST mode.
          </p>
          <button type="submit" disabled={isPending} className={`shrink-0 ${secondaryButtonAutoClass}`}>
            {isPending ? "Running…" : label.button}
          </button>
        </div>
      </form>
    </details>
  );
}

"use client";

import { useActionState } from "react";
import { CheckCircle2, AlertTriangle, Loader2, Send } from "lucide-react";
import { subsectionTitleClass, metaClass, detailLabelClass, detailValueClass } from "@/lib/ui/typography";
import { sendTestLead, type TestLeadState } from "./actions";
import type { TestLeadOutcome } from "@/lib/onboarding/readiness";

const initialState: TestLeadState = {};

/**
 * First Client Onboarding V1, Step 6 (Test Mode). Business-language only
 * (Phase 8) - no mention of n8n, webhooks, automation event ids, or HTTP
 * status codes anywhere in this component; the agency's own org detail
 * page is where that technical detail belongs. Never claims success it
 * hasn't verified: the three real outcomes (still in progress, safely held
 * back by Test mode, or the automation service temporarily unavailable)
 * are each shown as what they actually are, sourced from
 * getLatestTestLeadOutcome's real read of workflow_executions - nothing
 * here is invented or optimistic.
 */
export function TestLeadPanel({ outcome, canEdit }: { outcome: TestLeadOutcome | null; canEdit: boolean }) {
  const [state, formAction, isPending] = useActionState(sendTestLead, initialState);

  return (
    <section>
      <h2 className={subsectionTitleClass}>Test your lead response</h2>
      <p className={`mt-1 ${metaClass}`}>
        Send a safe test lead through your real system — no real text message will be sent while you&apos;re in Test mode.
      </p>

      {canEdit ? (
        <form action={formAction} className="mt-4">
          <button
            type="submit"
            disabled={isPending}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3.5 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Send className="h-4 w-4 shrink-0" aria-hidden />
            {isPending ? "Sending…" : "Send test lead"}
          </button>
        </form>
      ) : null}
      {state.error ? <p className="mt-2 text-xs text-red-600">{state.error}</p> : null}

      {outcome ? (
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50/60 px-4 py-3">
          <p className={detailLabelClass}>Last test — {new Date(outcome.createdAt).toLocaleString()}</p>
          <TestLeadResult outcome={outcome} />
        </div>
      ) : null}
    </section>
  );
}

function TestLeadResult({ outcome }: { outcome: TestLeadOutcome }) {
  if (outcome.executionStatus === null || outcome.executionStatus === "running") {
    return (
      <p className={`mt-1 flex items-center gap-1.5 ${detailValueClass}`}>
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-slate-400" aria-hidden />
        Checking your automated response — refresh this page in a few seconds.
      </p>
    );
  }

  if (outcome.blockedReason === "organization_not_live") {
    return (
      <p className={`mt-1 flex items-center gap-1.5 text-emerald-700`}>
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
        Your lead was captured and your automated response was drafted correctly — it was safely held back because
        you&apos;re still in Test mode. This is exactly what should happen.
      </p>
    );
  }

  if (outcome.executionStatus === "completed" && !outcome.blockedReason) {
    return (
      <p className={`mt-1 flex items-center gap-1.5 text-emerald-700`}>
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
        Your lead was captured and your system responded correctly.
      </p>
    );
  }

  if (outcome.executionStatus === "completed" && outcome.blockedReason) {
    return (
      <p className={`mt-1 flex items-center gap-1.5 ${detailValueClass}`}>
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />
        Your lead was captured. The automated response was held back ({outcome.blockedReason.replace(/_/g, " ")}).
      </p>
    );
  }

  return (
    <p className={`mt-1 flex items-center gap-1.5 ${detailValueClass}`}>
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />
      Your lead was captured, but we couldn&apos;t confirm the automated response was sent — the automation service is
      temporarily unavailable. This has been logged for review; no message was sent to anyone.
    </p>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Pencil } from "lucide-react";
import { errorBannerClass } from "@/lib/ui/form";
import type { Contact } from "@/lib/contacts/queries";
import type { Lead } from "@/lib/leads/queries";
import type { Estimate } from "@/lib/estimates/queries";
import { EstimateDialog } from "../../_components/estimate-dialog";
import { cancelEstimate, markEstimateAccepted, markEstimateDeclined, sendEstimate } from "../../actions";

const primaryBtn =
  "inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400";
const secondaryBtn =
  "inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3.5 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const dangerBtn =
  "inline-flex items-center gap-2 rounded-lg border border-red-200 px-3.5 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50";

type ConfirmKind = "decline" | "cancel";

const CONFIRM_COPY: Record<ConfirmKind, { title: string; body: string; confirmLabel: string }> = {
  decline: {
    title: "Decline this estimate?",
    body: "This marks the estimate as declined. This cannot be undone from here.",
    confirmLabel: "Decline Estimate",
  },
  cancel: {
    title: "Cancel this estimate?",
    body: "This withdraws the estimate and stops any pending follow-ups. This cannot be undone from here.",
    confirmLabel: "Cancel Estimate",
  },
};

/**
 * Every button here maps to exactly one existing action in ../../actions -
 * no new state-machine logic lives on the client. Which buttons render at
 * all is derived purely from estimate.status: the server-side .eq()/.in()
 * guards in each action remain the sole authority over whether a
 * transition actually succeeds - this only decides what's worth offering.
 */
export function EstimateActions({
  estimate,
  contacts,
  leads,
}: {
  estimate: Estimate;
  contacts: Contact[];
  leads: Lead[];
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [confirming, setConfirming] = useState<ConfirmKind | null>(null);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "Something went wrong.");
        return;
      }
      setConfirming(null);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {estimate.status === "draft" ? (
          <>
            <button type="button" onClick={() => setEditOpen(true)} className={secondaryBtn}>
              <Pencil aria-hidden className="h-4 w-4" />
              Edit
            </button>
            <button type="button" disabled={isPending} onClick={() => run(() => sendEstimate(estimate.id))} className={primaryBtn}>
              {isPending ? "Sending…" : "Send Estimate"}
            </button>
            <button type="button" disabled={isPending} onClick={() => setConfirming("cancel")} className={dangerBtn}>
              Cancel
            </button>
          </>
        ) : null}

        {estimate.status === "sent" ? (
          <>
            <button
              type="button"
              disabled={isPending}
              onClick={() => run(() => markEstimateAccepted(estimate.id))}
              className={primaryBtn}
            >
              {isPending ? "Saving…" : "Mark Accepted"}
            </button>
            <button type="button" disabled={isPending} onClick={() => setConfirming("decline")} className={secondaryBtn}>
              Mark Declined
            </button>
            <button type="button" disabled={isPending} onClick={() => setConfirming("cancel")} className={dangerBtn}>
              Cancel
            </button>
          </>
        ) : null}
      </div>

      {error ? <p className={errorBannerClass}>{error}</p> : null}

      {editOpen ? (
        <EstimateDialog
          mode="edit"
          estimate={estimate}
          contacts={contacts}
          leads={leads}
          onClose={() => {
            setEditOpen(false);
            router.refresh();
          }}
        />
      ) : null}

      {confirming ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close"
            className="absolute inset-0 bg-slate-900/40"
            onClick={() => setConfirming(null)}
          />
          <div className="relative w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
            <h2 className="text-lg font-semibold tracking-tight text-slate-900">{CONFIRM_COPY[confirming].title}</h2>
            <p className="mt-2 text-sm text-slate-500">{CONFIRM_COPY[confirming].body}</p>
            <div className="mt-5 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setConfirming(null)}
                className="rounded-lg px-3.5 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100"
              >
                Never mind
              </button>
              <button
                type="button"
                disabled={isPending}
                onClick={() =>
                  run(() =>
                    confirming === "decline" ? markEstimateDeclined(estimate.id) : cancelEstimate(estimate.id),
                  )
                }
                className="inline-flex items-center justify-center rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-red-300"
              >
                {isPending ? "Saving…" : CONFIRM_COPY[confirming].confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

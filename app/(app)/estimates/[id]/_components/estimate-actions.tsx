"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Pencil } from "lucide-react";
import {
  destructiveButtonAutoClass,
  destructiveGhostButtonAutoClass,
  errorBannerClass,
  ghostButtonClass,
  primaryButtonAutoClass,
  secondaryButtonAutoClass,
  successBannerClass,
} from "@/lib/ui/form";
import { Dialog, DialogDescription, DialogFooter, DialogTitle } from "@/lib/ui/dialog";
import type { Contact } from "@/lib/contacts/queries";
import type { Lead } from "@/lib/leads/queries";
import type { Estimate } from "@/lib/estimates/queries";
import { EstimateDialog } from "../../_components/estimate-dialog";
import { cancelEstimate, createJobFromAcceptedEstimate, markEstimateAccepted, markEstimateDeclined, sendEstimate } from "../../actions";

const primaryBtn = primaryButtonAutoClass;
const secondaryBtn = secondaryButtonAutoClass;
const dangerBtn = destructiveGhostButtonAutoClass;

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
  hasJob = false,
}: {
  estimate: Estimate;
  contacts: Contact[];
  leads: Lead[];
  /** Final Batch 3: an accepted estimate with no job offers "Create Job" (the existing estimate -> job path). */
  hasJob?: boolean;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [confirming, setConfirming] = useState<ConfirmKind | null>(null);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Final Batch 3: the truthful result of Send Estimate - whether the customer
  // was actually texted, never a blanket "sent" (see sendEstimate).
  const [sendNotice, setSendNotice] = useState<{ texted: boolean; message: string } | null>(null);
  const router = useRouter();

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    setSendNotice(null);
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

  function send() {
    setError(null);
    setSendNotice(null);
    startTransition(async () => {
      const result = await sendEstimate(estimate.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSendNotice(result.delivery);
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
            <button type="button" disabled={isPending} onClick={send} className={primaryBtn}>
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
        {estimate.status === "accepted" && !hasJob ? (
          <button type="button" disabled={isPending} onClick={() => run(() => createJobFromAcceptedEstimate(estimate.id))} className={primaryBtn}>
            {isPending ? "Creating…" : "Create Job"}
          </button>
        ) : null}
      </div>

      {error ? <p className={errorBannerClass} role="alert">{error}</p> : null}
      {sendNotice ? (
        <p className={sendNotice.texted ? successBannerClass : errorBannerClass} role={sendNotice.texted ? "status" : "alert"}>
          {sendNotice.message}
        </p>
      ) : null}

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
        <Dialog onClose={() => setConfirming(null)} labelledBy="estimate-confirm-title">
          <DialogTitle id="estimate-confirm-title">{CONFIRM_COPY[confirming].title}</DialogTitle>
          <DialogDescription>{CONFIRM_COPY[confirming].body}</DialogDescription>
          <DialogFooter>
            <button type="button" onClick={() => setConfirming(null)} className={ghostButtonClass}>
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
              className={destructiveButtonAutoClass}
            >
              {isPending ? "Saving…" : CONFIRM_COPY[confirming].confirmLabel}
            </button>
          </DialogFooter>
        </Dialog>
      ) : null}
    </div>
  );
}

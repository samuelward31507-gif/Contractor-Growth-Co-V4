"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  destructiveButtonAutoClass,
  destructiveGhostButtonAutoClass,
  errorBannerClass,
  ghostButtonClass,
  primaryButtonAutoClass,
  secondaryButtonAutoClass,
} from "@/lib/ui/form";
import { Dialog, DialogDescription, DialogFooter, DialogTitle } from "@/lib/ui/dialog";
import type { Job } from "@/lib/jobs/queries";
import { markJobCancelled, markJobCompleted, markJobStarted } from "../../actions";

const primaryBtn = primaryButtonAutoClass;
const secondaryBtn = secondaryButtonAutoClass;
const dangerBtn = destructiveGhostButtonAutoClass;

type ConfirmKind = "complete" | "cancel";

const CONFIRM_COPY: Record<ConfirmKind, { title: string; body: string; confirmLabel: string }> = {
  complete: {
    title: "Mark this job complete?",
    body: "This sends the customer's post-job follow-up (thank-you, and a review/referral ask if configured). This cannot be undone from here.",
    confirmLabel: "Mark Completed",
  },
  cancel: {
    title: "Cancel this job?",
    body: "This marks the job as cancelled. This cannot be undone from here.",
    confirmLabel: "Cancel Job",
  },
};

/**
 * Every button here maps to exactly one existing action in ../../actions -
 * no new state-machine logic lives on the client. Which buttons render at
 * all is derived purely from job.status: the server-side .eq()/.in() guards
 * in each action remain the sole authority over whether a transition
 * actually succeeds - this only decides what's worth offering. Mirrors
 * app/(app)/estimates/[id]/_components/estimate-actions.tsx's shape.
 */
export function JobActions({ job }: { job: Job }) {
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
        {job.status === "scheduled" ? (
          <>
            <button type="button" disabled={isPending} onClick={() => run(() => markJobStarted(job.id))} className={primaryBtn}>
              {isPending ? "Saving…" : "Start Job"}
            </button>
            <button type="button" disabled={isPending} onClick={() => setConfirming("complete")} className={secondaryBtn}>
              Mark Completed
            </button>
            <button type="button" disabled={isPending} onClick={() => setConfirming("cancel")} className={dangerBtn}>
              Cancel
            </button>
          </>
        ) : null}

        {job.status === "in_progress" ? (
          <>
            <button type="button" disabled={isPending} onClick={() => setConfirming("complete")} className={primaryBtn}>
              Mark Completed
            </button>
            <button type="button" disabled={isPending} onClick={() => setConfirming("cancel")} className={dangerBtn}>
              Cancel
            </button>
          </>
        ) : null}
      </div>

      {error ? <p className={errorBannerClass}>{error}</p> : null}

      {confirming ? (
        <Dialog onClose={() => setConfirming(null)} labelledBy="job-confirm-title">
          <DialogTitle id="job-confirm-title">{CONFIRM_COPY[confirming].title}</DialogTitle>
          <DialogDescription>{CONFIRM_COPY[confirming].body}</DialogDescription>
          <DialogFooter>
            <button type="button" onClick={() => setConfirming(null)} className={ghostButtonClass}>
              Never mind
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={() =>
                run(() => (confirming === "complete" ? markJobCompleted(job.id) : markJobCancelled(job.id)))
              }
              className={confirming === "complete" ? primaryButtonAutoClass : destructiveButtonAutoClass}
            >
              {isPending ? "Saving…" : CONFIRM_COPY[confirming].confirmLabel}
            </button>
          </DialogFooter>
        </Dialog>
      ) : null}
    </div>
  );
}

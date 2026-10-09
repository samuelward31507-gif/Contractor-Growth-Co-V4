"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Dialog, DialogFooter, DialogTitle } from "@/lib/ui/dialog";
import { errorBannerClass, ghostButtonClass, inputClass, primaryButtonAutoClass, secondaryButtonAutoClass } from "@/lib/ui/form";
import type { ClientHandoff } from "@/lib/founder/handoff";
import { formatMoney } from "@/lib/founder/format";
import { cancelAgencyClientHandoff, confirmClientHandoff } from "../actions";

/**
 * Review-then-confirm for one prepared handoff. "Review and confirm" opens
 * the snapshot; only the dialog's "Create Agency client" button creates the
 * client (in one database transaction). Cancel needs a reason and keeps the
 * record. The buttons lock while a request runs; a repeat is still safe -
 * the database returns the same client.
 */
export function HandoffControls({ handoff }: { handoff: ClientHandoff }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [reviewing, setReviewing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  function run(action: () => Promise<{ ok: boolean; error?: string }>, done: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "Something went wrong.");
        return;
      }
      done();
      router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      {cancelling ? (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={`cancel-${handoff.id}`} className="sr-only">Why cancel this handoff</label>
          <input id={`cancel-${handoff.id}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Why cancel?" className={`${inputClass} h-9 flex-1 text-sm`} />
          <button type="button" disabled={isPending || !reason.trim()} onClick={() => run(() => cancelAgencyClientHandoff(handoff.id, reason), () => setCancelling(false))} className="min-h-9 rounded-md px-2 text-xs font-semibold text-danger-text hover:bg-danger-muted disabled:opacity-50">
            Cancel handoff
          </button>
          <button type="button" onClick={() => setCancelling(false)} className="min-h-9 rounded-md px-2 text-xs font-medium text-ink-3 hover:bg-inset">
            Keep
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setReviewing(true)} className={primaryButtonAutoClass}>
            Review and confirm
          </button>
          <button type="button" onClick={() => setCancelling(true)} className={secondaryButtonAutoClass}>
            Cancel
          </button>
        </div>
      )}
      {error && !reviewing ? <p role="alert" className="text-xs font-medium text-danger-text">{error}</p> : null}
      {reviewing ? (
        <Dialog onClose={() => setReviewing(false)} labelledBy={`confirm-${handoff.id}-title`} className="max-h-[90vh] max-w-lg overflow-y-auto">
          <DialogTitle id={`confirm-${handoff.id}-title`}>Create Agency client: {handoff.clientName}</DialogTitle>
          <div className="mt-4 space-y-4">
            {error ? (
              <p className={errorBannerClass} role="alert">
                {error}
              </p>
            ) : null}
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-lg bg-inset/60 p-3 text-sm">
              <dt className="text-ink-3">Decision-maker</dt>
              <dd className="text-ink">{handoff.contactName}</dd>
              <dt className="text-ink-3">Contact</dt>
              <dd className="break-words text-ink">{[handoff.contactEmail, handoff.contactPhone].filter(Boolean).join(" · ")}</dd>
              <dt className="text-ink-3">Setup fee</dt>
              <dd className="text-ink">{formatMoney(handoff.setupFee, handoff.currency)}</dd>
              <dt className="text-ink-3">Monthly fee</dt>
              <dd className="text-ink">{formatMoney(handoff.monthlyFee, handoff.currency)}/mo</dd>
            </dl>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-3">Agreed scope</p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-ink-2">{handoff.scope}</p>
            </div>
            <p className="text-xs text-ink-3">
              This creates the Agency client record with onboarding not started. It doesn&rsquo;t create or change a Trackpr account, charge anything or contact the client. Fees are the agreed terms, not payments received.
            </p>
            <DialogFooter>
              <button type="button" onClick={() => setReviewing(false)} className={ghostButtonClass}>Back</button>
              <button type="button" disabled={isPending} onClick={() => run(() => confirmClientHandoff(handoff.id), () => setReviewing(false))} className={primaryButtonAutoClass}>
                {isPending ? "Creating…" : "Create Agency client"}
              </button>
            </DialogFooter>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

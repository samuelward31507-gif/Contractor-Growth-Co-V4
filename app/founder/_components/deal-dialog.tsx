"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Dialog, DialogFooter, DialogTitle } from "@/lib/ui/dialog";
import { errorBannerClass, ghostButtonClass, inputClass, labelClass, primaryButtonAutoClass } from "@/lib/ui/form";
import { DEAL_STAGES, DEAL_STAGE_LABELS, toLocalInputValue, type DealStage, type FounderDeal } from "@/lib/founder/model";
import { createFounderDeal, updateFounderDeal } from "../actions";

/** Create or edit a deal. Won asks for the amount and date; lost for an optional reason. */
export function DealDialog({ deal, timeZone, todayKey, onClose }: { deal?: FounderDeal; timeZone: string; todayKey: string; onClose: () => void }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<DealStage>(deal?.stage ?? "lead");

  function submit(formData: FormData) {
    const fields = Object.fromEntries(formData.entries());
    setError(null);
    startTransition(async () => {
      const result = deal ? await updateFounderDeal(deal.id, fields) : await createFounderDeal(fields);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
      onClose();
    });
  }

  return (
    <Dialog onClose={onClose} labelledBy="founder-deal-title" className="max-h-[90vh] max-w-lg overflow-y-auto">
      <DialogTitle id="founder-deal-title">{deal ? "Edit deal" : "New deal"}</DialogTitle>
      <form action={submit} className="mt-4 space-y-4">
        {error ? (
          <p className={errorBannerClass} role="alert">
            {error}
          </p>
        ) : null}
        <div className="space-y-1.5">
          <label htmlFor="deal-name" className={labelClass}>Company / deal</label>
          <input id="deal-name" name="name" required maxLength={200} defaultValue={deal?.name ?? ""} className={inputClass} />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="deal-contact" className={labelClass}>Contact</label>
            <input id="deal-contact" name="contactName" maxLength={200} defaultValue={deal?.contactName ?? ""} className={inputClass} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="deal-email" className={labelClass}>Email</label>
            <input id="deal-email" name="contactEmail" type="email" maxLength={320} defaultValue={deal?.contactEmail ?? ""} className={inputClass} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label htmlFor="deal-stage" className={labelClass}>Stage</label>
            <select id="deal-stage" name="stage" value={stage} onChange={(e) => setStage(e.target.value as DealStage)} className={inputClass}>
              {DEAL_STAGES.map((s) => (
                <option key={s} value={s}>{DEAL_STAGE_LABELS[s]}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="deal-mrr" className={labelClass}>Expected MRR</label>
            <input id="deal-mrr" name="expectedMrr" inputMode="decimal" defaultValue={deal?.expectedMrr ?? ""} className={inputClass} placeholder="0.00" />
          </div>
        </div>
        {stage === "won" ? (
          <div className="grid grid-cols-2 gap-3 rounded-lg border border-accent-border bg-accent-muted/50 p-3">
            <div className="space-y-1.5">
              <label htmlFor="deal-won-amount" className={labelClass}>Won amount</label>
              <input id="deal-won-amount" name="wonAmount" required inputMode="decimal" defaultValue={deal?.wonAmount ?? deal?.expectedMrr ?? ""} className={inputClass} />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="deal-won-on" className={labelClass}>Won on</label>
              <input id="deal-won-on" name="wonOn" type="date" required defaultValue={deal?.wonOn ?? todayKey} className={inputClass} />
            </div>
          </div>
        ) : null}
        {stage === "lost" ? (
          <div className="space-y-1.5">
            <label htmlFor="deal-lost" className={labelClass}>Why it was lost (optional)</label>
            <input id="deal-lost" name="lostReason" maxLength={500} defaultValue={deal?.lostReason ?? ""} className={inputClass} />
          </div>
        ) : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_200px]">
          <div className="space-y-1.5">
            <label htmlFor="deal-next" className={labelClass}>Next action</label>
            <input id="deal-next" name="nextAction" maxLength={500} defaultValue={deal?.nextAction ?? ""} className={inputClass} placeholder="e.g. Send pricing" />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="deal-next-at" className={labelClass}>Follow up</label>
            <input id="deal-next-at" name="nextActionAt" type="datetime-local" defaultValue={toLocalInputValue(deal?.nextActionAt ?? null, timeZone)} className={inputClass} />
          </div>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="deal-notes" className={labelClass}>Notes</label>
          <textarea id="deal-notes" name="notes" rows={3} maxLength={5000} defaultValue={deal?.notes ?? ""} className={inputClass} />
        </div>
        <DialogFooter>
          <button type="button" onClick={onClose} className={ghostButtonClass}>Cancel</button>
          <button type="submit" disabled={isPending} className={primaryButtonAutoClass}>
            {isPending ? "Saving…" : deal ? "Save deal" : "Add deal"}
          </button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

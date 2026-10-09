"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Dialog, DialogFooter, DialogTitle } from "@/lib/ui/dialog";
import { errorBannerClass, ghostButtonClass, inputClass, labelClass, primaryButtonAutoClass } from "@/lib/ui/form";
import { DEAL_FITS, DEAL_FIT_LABELS, DEAL_SOURCES, DEAL_SOURCE_LABELS, DEAL_STAGE_LABELS, DEFAULT_CURRENCY, OPEN_DEAL_STAGES, toLocalInputValue, type FounderDeal } from "@/lib/founder/model";
import { createFounderDeal, updateFounderDeal } from "../actions";

/**
 * Create or edit a deal's details: who, where they came from, fit, expected
 * terms, the next action. The starting stage is chosen only when creating;
 * after that, stage changes, wins (with agreed terms) and losses (with a
 * reason) are recorded from the deal card so each lands in its history.
 */
export function DealDialog({ deal, timeZone, onClose }: { deal?: FounderDeal; timeZone: string; onClose: () => void }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Made once per open dialog: a double-submit or retry creates one deal.
  const [clientId] = useState(() => crypto.randomUUID());

  function submit(formData: FormData) {
    const fields = Object.fromEntries(formData.entries());
    setError(null);
    startTransition(async () => {
      const result = deal ? await updateFounderDeal(deal.id, { ...fields, expectedUpdatedAt: deal.updatedAt }) : await createFounderDeal({ ...fields, clientId });
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
          <label htmlFor="deal-name" className={labelClass}>Business name</label>
          <input id="deal-name" name="name" required maxLength={200} defaultValue={deal?.name ?? ""} className={inputClass} />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="deal-trade" className={labelClass}>Trade</label>
            <input id="deal-trade" name="trade" maxLength={100} defaultValue={deal?.trade ?? ""} className={inputClass} placeholder="e.g. Roofing" />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="deal-location" className={labelClass}>Location</label>
            <input id="deal-location" name="location" maxLength={200} defaultValue={deal?.location ?? ""} className={inputClass} placeholder="City, state" />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="deal-contact" className={labelClass}>Decision-maker</label>
            <input id="deal-contact" name="contactName" maxLength={200} defaultValue={deal?.contactName ?? ""} className={inputClass} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="deal-phone" className={labelClass}>Phone</label>
            <input id="deal-phone" name="contactPhone" type="tel" maxLength={40} defaultValue={deal?.contactPhone ?? ""} className={inputClass} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="deal-email" className={labelClass}>Email</label>
            <input id="deal-email" name="contactEmail" type="email" maxLength={320} defaultValue={deal?.contactEmail ?? ""} className={inputClass} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="deal-website" className={labelClass}>Website</label>
            <input id="deal-website" name="website" maxLength={300} defaultValue={deal?.website ?? ""} className={inputClass} />
          </div>
        </div>
        <div className={`grid grid-cols-1 gap-3 ${deal ? "sm:grid-cols-2" : "sm:grid-cols-3"}`}>
          {deal ? null : (
            <div className="space-y-1.5">
              <label htmlFor="deal-stage" className={labelClass}>Starting stage</label>
              <select id="deal-stage" name="stage" defaultValue="identified" className={inputClass}>
                {OPEN_DEAL_STAGES.map((s) => (
                  <option key={s} value={s}>{DEAL_STAGE_LABELS[s]}</option>
                ))}
              </select>
            </div>
          )}
          <div className="space-y-1.5">
            <label htmlFor="deal-source" className={labelClass}>Source</label>
            <select id="deal-source" name="source" defaultValue={deal?.source ?? ""} className={inputClass}>
              <option value="">Not set</option>
              {DEAL_SOURCES.map((s) => (
                <option key={s} value={s}>{DEAL_SOURCE_LABELS[s]}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="deal-fit" className={labelClass}>Fit</label>
            <select id="deal-fit" name="fit" defaultValue={deal?.fit ?? ""} className={inputClass}>
              <option value="">Not assessed</option>
              {DEAL_FITS.map((f) => (
                <option key={f} value={f}>{DEAL_FIT_LABELS[f]}</option>
              ))}
            </select>
          </div>
        </div>
        <fieldset className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_88px] gap-3">
          <legend className="mb-1.5 text-xs text-ink-3">Expected terms - your estimate before it&rsquo;s won</legend>
          <div className="space-y-1.5">
            <label htmlFor="deal-setup" className={labelClass}>Setup fee</label>
            <input id="deal-setup" name="expectedSetupFee" inputMode="decimal" defaultValue={deal?.expectedSetupFee ?? ""} className={inputClass} placeholder="0.00" />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="deal-mrr" className={labelClass}>Monthly fee</label>
            <input id="deal-mrr" name="expectedMrr" inputMode="decimal" defaultValue={deal?.expectedMrr ?? ""} className={inputClass} placeholder="0.00" />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="deal-currency" className={labelClass}>Currency</label>
            <input id="deal-currency" name="currency" maxLength={3} defaultValue={deal?.currency ?? DEFAULT_CURRENCY} className={`${inputClass} uppercase`} />
          </div>
        </fieldset>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_200px]">
          <div className="space-y-1.5">
            <label htmlFor="deal-next" className={labelClass}>Next action</label>
            <input id="deal-next" name="nextAction" maxLength={500} defaultValue={deal?.nextAction ?? ""} className={inputClass} placeholder="e.g. Send intro email" />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="deal-next-at" className={labelClass}>Due</label>
            <input id="deal-next-at" name="nextActionAt" type="datetime-local" defaultValue={toLocalInputValue(deal?.nextActionAt ?? null, timeZone)} className={inputClass} />
          </div>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="deal-notes" className={labelClass}>Research / qualification notes</label>
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

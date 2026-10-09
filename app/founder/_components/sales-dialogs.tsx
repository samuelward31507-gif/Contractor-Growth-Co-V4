"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Dialog, DialogFooter, DialogTitle } from "@/lib/ui/dialog";
import { errorBannerClass, ghostButtonClass, inputClass, labelClass, primaryButtonAutoClass } from "@/lib/ui/form";
import { DEAL_STAGE_LABELS, isOpenDeal, toLocalInputValue, type DealStage, type FounderDeal } from "@/lib/founder/model";
import { ACTIVITY_CHANNELS, ACTIVITY_CHANNEL_LABELS, ACTIVITY_KIND_LABELS, EVIDENCE_KINDS, suggestedStage, type EvidenceKind } from "@/lib/founder/sales";
import { changeFounderDealStage, logFounderDealActivity } from "../actions";

/**
 * Win, loss and reopen dialog. A win records the agreed setup and monthly
 * fees (contracted - not a payment), a loss its reason. The request id is
 * made once per open dialog, so a double-submit or retry records once; the
 * deal's loaded version guards against a change made elsewhere meanwhile.
 */
export function StageChangeDialog({ deal, toStage, todayKey, onClose }: { deal: FounderDeal; toStage: DealStage; todayKey: string; onClose: () => void }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [requestId] = useState(() => crypto.randomUUID());
  const reopening = !isOpenDeal(deal);
  const title = toStage === "won" ? `Mark ${deal.name} won` : toStage === "lost" ? `Mark ${deal.name} lost` : reopening ? `Reopen ${deal.name}` : `Move ${deal.name} to ${DEAL_STAGE_LABELS[toStage]}`;

  function submit(formData: FormData) {
    const fields = Object.fromEntries(formData.entries());
    setError(null);
    startTransition(async () => {
      const result = await changeFounderDealStage(deal.id, { ...fields, toStage, requestId, expectedUpdatedAt: deal.updatedAt });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
      onClose();
    });
  }

  return (
    <Dialog onClose={onClose} labelledBy="stage-change-title" className="max-w-md">
      <DialogTitle id="stage-change-title">{title}</DialogTitle>
      <form action={submit} className="mt-4 space-y-4">
        {error ? (
          <p className={errorBannerClass} role="alert">
            {error}
          </p>
        ) : null}
        {toStage === "won" ? (
          <>
            <p className="text-xs text-ink-3">Record the terms that were agreed. This is contracted revenue, not a payment - nothing here marks money as received.</p>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_80px] gap-3">
              <div className="space-y-1.5">
                <label htmlFor="won-setup" className={labelClass}>Setup fee</label>
                <input id="won-setup" name="setupFee" required inputMode="decimal" defaultValue={deal.expectedSetupFee ?? ""} className={inputClass} />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="won-monthly" className={labelClass}>Monthly fee</label>
                <input id="won-monthly" name="monthlyFee" required inputMode="decimal" defaultValue={deal.expectedMrr ?? ""} className={inputClass} />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="won-currency" className={labelClass}>Currency</label>
                <input id="won-currency" name="currency" required maxLength={3} defaultValue={deal.currency} className={`${inputClass} uppercase`} />
              </div>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="won-on" className={labelClass}>Won on</label>
              <input id="won-on" name="wonOn" type="date" required max={todayKey} defaultValue={todayKey} className={inputClass} />
            </div>
          </>
        ) : null}
        <div className="space-y-1.5">
          <label htmlFor="stage-reason" className={labelClass}>{toStage === "lost" ? "Why it was lost" : "Note (optional)"}</label>
          <input id="stage-reason" name="reason" required={toStage === "lost"} maxLength={500} className={inputClass} placeholder={toStage === "lost" ? "e.g. Went with a cheaper option" : ""} />
        </div>
        <DialogFooter>
          <button type="button" onClick={onClose} className={ghostButtonClass}>Cancel</button>
          <button type="submit" disabled={isPending} className={primaryButtonAutoClass}>
            {isPending ? "Saving…" : toStage === "won" ? "Record win" : toStage === "lost" ? "Record loss" : "Save"}
          </button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/**
 * Log something that already happened - outreach, a reply, a meeting, a
 * proposal. When it suggests the next stage, the deal can move there in the
 * same save (one checkbox, on by default, always visible).
 */
export function LogActivityDialog({ deal, timeZone, nowIso, defaultKind = "outreach", onClose }: { deal: FounderDeal; timeZone: string; nowIso: string; defaultKind?: EvidenceKind; onClose: () => void }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [requestId] = useState(() => crypto.randomUUID());
  const [kind, setKind] = useState<EvidenceKind>(defaultKind);
  const suggestion = suggestedStage(kind, deal.stage);
  const nowLocal = toLocalInputValue(nowIso, timeZone);

  function submit(formData: FormData) {
    const fields = Object.fromEntries(formData.entries());
    setError(null);
    startTransition(async () => {
      const result = await logFounderDealActivity(deal.id, { ...fields, requestId, expectedUpdatedAt: deal.updatedAt });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
      onClose();
    });
  }

  return (
    <Dialog onClose={onClose} labelledBy="log-activity-title" className="max-h-[90vh] max-w-md overflow-y-auto">
      <DialogTitle id="log-activity-title">Log activity · {deal.name}</DialogTitle>
      <form action={submit} className="mt-4 space-y-4">
        {error ? (
          <p className={errorBannerClass} role="alert">
            {error}
          </p>
        ) : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="act-kind" className={labelClass}>What happened</label>
            <select id="act-kind" name="kind" value={kind} onChange={(e) => setKind(e.target.value as EvidenceKind)} className={inputClass}>
              {EVIDENCE_KINDS.map((k) => (
                <option key={k} value={k}>{ACTIVITY_KIND_LABELS[k]}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="act-channel" className={labelClass}>Channel</label>
            <select id="act-channel" name="channel" defaultValue="" className={inputClass}>
              <option value="">Not set</option>
              {ACTIVITY_CHANNELS.map((c) => (
                <option key={c} value={c}>{ACTIVITY_CHANNEL_LABELS[c]}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="act-when" className={labelClass}>When it happened</label>
          <input id="act-when" name="occurredAt" type="datetime-local" required max={nowLocal} defaultValue={nowLocal} className={inputClass} />
        </div>
        {kind === "meeting_booked" ? (
          <div className="space-y-1.5">
            <label htmlFor="act-scheduled" className={labelClass}>Meeting time (optional)</label>
            <input id="act-scheduled" name="scheduledFor" type="datetime-local" className={inputClass} />
          </div>
        ) : null}
        <div className="space-y-1.5">
          <label htmlFor="act-summary" className={labelClass}>Summary (optional)</label>
          <textarea id="act-summary" name="summary" rows={2} maxLength={1000} className={inputClass} />
        </div>
        {suggestion ? (
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input type="checkbox" name="advance" defaultChecked className="h-4 w-4 rounded border-line" />
            Also move the deal to {DEAL_STAGE_LABELS[suggestion]}
          </label>
        ) : null}
        <DialogFooter>
          <button type="button" onClick={onClose} className={ghostButtonClass}>Cancel</button>
          <button type="submit" disabled={isPending} className={primaryButtonAutoClass}>
            {isPending ? "Saving…" : "Log it"}
          </button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

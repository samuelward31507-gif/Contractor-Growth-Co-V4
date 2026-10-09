"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Dialog, DialogFooter, DialogTitle } from "@/lib/ui/dialog";
import { errorBannerClass, ghostButtonClass, inputClass, labelClass, primaryButtonAutoClass } from "@/lib/ui/form";
import { ITEM_KINDS, ITEM_KIND_LABELS, PRIORITIES, PRIORITY_LABELS, SCHEDULED_KINDS, toLocalInputValue, type FounderItem, type ItemKind } from "@/lib/founder/model";
import { createFounderItem, updateFounderItem } from "../actions";

export type DealOption = { id: string; name: string };

/** Create or edit a task, follow-up, deadline, event or meeting. Times are entered in the founder's own zone. */
export function ItemDialog({
  item,
  defaultKind = "task",
  deals,
  timeZone,
  onClose,
}: {
  item?: FounderItem;
  defaultKind?: ItemKind;
  deals: DealOption[];
  timeZone: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<ItemKind>(item?.kind ?? defaultKind);
  const scheduled = SCHEDULED_KINDS.includes(kind);

  function submit(formData: FormData) {
    const fields = Object.fromEntries(formData.entries());
    setError(null);
    startTransition(async () => {
      const result = item ? await updateFounderItem(item.id, fields) : await createFounderItem(fields);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
      onClose();
    });
  }

  return (
    <Dialog onClose={onClose} labelledBy="founder-item-title" className="max-h-[90vh] max-w-lg overflow-y-auto">
      <DialogTitle id="founder-item-title">{item ? "Edit item" : "New item"}</DialogTitle>
      <form action={submit} className="mt-4 space-y-4">
        {error ? (
          <p className={errorBannerClass} role="alert">
            {error}
          </p>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label htmlFor="item-kind" className={labelClass}>Type</label>
            <select id="item-kind" name="kind" value={kind} onChange={(e) => setKind(e.target.value as ItemKind)} className={inputClass}>
              {ITEM_KINDS.map((k) => (
                <option key={k} value={k}>{ITEM_KIND_LABELS[k]}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="item-priority" className={labelClass}>Priority</label>
            <select id="item-priority" name="priority" defaultValue={item?.priority ?? "medium"} className={inputClass}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="item-title" className={labelClass}>Title</label>
          <input id="item-title" name="title" required maxLength={300} defaultValue={item?.title ?? ""} className={inputClass} placeholder={scheduled ? "e.g. Demo with Acme Roofing" : "e.g. Send proposal to Acme"} />
        </div>
        {scheduled ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="item-starts" className={labelClass}>Starts</label>
              <input id="item-starts" name="startsAt" type="datetime-local" required defaultValue={toLocalInputValue(item?.startsAt ?? null, timeZone)} className={inputClass} />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="item-ends" className={labelClass}>Ends (optional)</label>
              <input id="item-ends" name="endsAt" type="datetime-local" defaultValue={toLocalInputValue(item?.endsAt ?? null, timeZone)} className={inputClass} />
            </div>
          </div>
        ) : (
          <div className="space-y-1.5">
            <label htmlFor="item-due" className={labelClass}>Due (optional)</label>
            <input id="item-due" name="dueAt" type="datetime-local" defaultValue={toLocalInputValue(item?.dueAt ?? null, timeZone)} className={inputClass} />
          </div>
        )}
        {deals.length > 0 ? (
          <div className="space-y-1.5">
            <label htmlFor="item-deal" className={labelClass}>Deal (optional)</label>
            <select id="item-deal" name="dealId" defaultValue={item?.dealId ?? ""} className={inputClass}>
              <option value="">No deal</option>
              {deals.map((deal) => (
                <option key={deal.id} value={deal.id}>{deal.name}</option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="space-y-1.5">
          <label htmlFor="item-notes" className={labelClass}>Notes</label>
          <textarea id="item-notes" name="notes" rows={3} maxLength={5000} defaultValue={item?.notes ?? ""} className={inputClass} />
        </div>
        <p className="text-xs text-ink-3">Times are in {timeZone.replace(/_/g, " ")}.</p>
        <DialogFooter>
          <button type="button" onClick={onClose} className={ghostButtonClass}>Cancel</button>
          <button type="submit" disabled={isPending} className={primaryButtonAutoClass}>
            {isPending ? "Saving…" : item ? "Save changes" : "Add item"}
          </button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

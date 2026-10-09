"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Dialog, DialogFooter, DialogTitle } from "@/lib/ui/dialog";
import { errorBannerClass, ghostButtonClass, inputClass, labelClass, primaryButtonAutoClass } from "@/lib/ui/form";
import { ITEM_KINDS, ITEM_KIND_LABELS, PRIORITIES, PRIORITY_LABELS, SCHEDULED_KINDS, addDaysKey, toLocalInputValue, type FounderItem, type ItemKind } from "@/lib/founder/model";
import { isAllDayEvent, isEndOfDayDue } from "@/lib/founder/calendar";
import { createFounderItem, updateFounderItem } from "../actions";

export type DealOption = { id: string; name: string; /** Won or lost - offered only when the item is already linked to it. */ closed?: boolean };

/** Prefills for a new item: a day (from a calendar click), a deal (from a deal card). */
export type ItemDefaults = { date?: string; dealId?: string };

function newClientId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : "";
}

/**
 * Create or edit a task, follow-up, deadline, event or meeting - also how an
 * item is rescheduled. Times are entered in the founder's own zone; the
 * server re-validates everything (lib/founder/model.ts parseItemInput).
 * A new item carries a client-generated id so a double-submit can't create
 * two; an edit carries the version it was opened at so it can't overwrite
 * a newer change.
 */
export function ItemDialog({
  item,
  defaultKind = "task",
  defaults,
  deals,
  timeZone,
  onClose,
  onSaved,
}: {
  item?: FounderItem;
  defaultKind?: ItemKind;
  defaults?: ItemDefaults;
  deals: DealOption[];
  timeZone: string;
  onClose: () => void;
  onSaved?: (message: string) => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<ItemKind>(item?.kind ?? defaultKind);
  const [allDay, setAllDay] = useState(item ? isAllDayEvent(item, timeZone) : false);
  const [clientId] = useState(newClientId);
  const scheduled = SCHEDULED_KINDS.includes(kind);

  const dealChoices = deals.filter((deal) => !deal.closed || deal.id === (item?.dealId ?? defaults?.dealId));
  const dueLocal = toLocalInputValue(item?.dueAt ?? null, timeZone);
  const dueTimeDefault = item && isEndOfDayDue(item, timeZone) ? "" : dueLocal.slice(11, 16);
  const startLocal = toLocalInputValue(item?.startsAt ?? null, timeZone) || (defaults?.date ? `${defaults.date}T09:00` : "");
  const endLocal = toLocalInputValue(item?.endsAt ?? null, timeZone) || (defaults?.date && !item ? `${defaults.date}T10:00` : "");
  const allDayStart = startLocal.slice(0, 10);
  // An all-day event is stored to the following midnight; the form shows the inclusive last day.
  const allDayEnd = item?.endsAt && isAllDayEvent(item, timeZone) ? addDaysKey(toLocalInputValue(item.endsAt, timeZone).slice(0, 10), -1) : allDayStart;

  function submit(formData: FormData) {
    const fields: Record<string, unknown> = Object.fromEntries(formData.entries());
    if (item && !SCHEDULED_KINDS.includes(kind)) fields.completed = formData.get("completed") === "on";
    setError(null);
    startTransition(async () => {
      const result = item ? await updateFounderItem(item.id, fields) : await createFounderItem(fields);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onSaved?.(item ? "Changes saved." : `${ITEM_KIND_LABELS[kind]} added.`);
      router.refresh();
      onClose();
    });
  }

  return (
    <Dialog onClose={onClose} labelledBy="founder-item-title" className="max-h-[90vh] max-w-lg overflow-y-auto">
      <DialogTitle id="founder-item-title">{item ? `Edit ${ITEM_KIND_LABELS[item.kind].toLowerCase()}` : `New ${ITEM_KIND_LABELS[kind].toLowerCase()}`}</DialogTitle>
      <form action={submit} className="mt-4 space-y-4">
        {item ? <input type="hidden" name="expectedUpdatedAt" value={item.updatedAt} /> : clientId ? <input type="hidden" name="clientId" value={clientId} /> : null}
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
          <fieldset className="space-y-3">
            <legend className="sr-only">When</legend>
            <label className="flex min-h-11 items-center gap-2 text-sm text-ink-2 sm:min-h-0">
              <input type="checkbox" name="allDay" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} className="h-4 w-4 rounded border-line-strong accent-[var(--color-accent)]" />
              All day
            </label>
            {allDay ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label htmlFor="item-start-date" className={labelClass}>First day</label>
                  <input id="item-start-date" name="startDate" type="date" required defaultValue={allDayStart} className={inputClass} />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="item-end-date" className={labelClass}>Last day</label>
                  <input id="item-end-date" name="endDate" type="date" defaultValue={allDayEnd} className={inputClass} />
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label htmlFor="item-starts" className={labelClass}>Starts</label>
                  <input id="item-starts" name="startsAt" type="datetime-local" required defaultValue={startLocal} className={inputClass} />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="item-ends" className={labelClass}>Ends (optional)</label>
                  <input id="item-ends" name="endsAt" type="datetime-local" defaultValue={endLocal} className={inputClass} />
                </div>
              </div>
            )}
          </fieldset>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label htmlFor="item-due-date" className={labelClass}>Due date (optional)</label>
              <input id="item-due-date" name="dueDate" type="date" defaultValue={dueLocal.slice(0, 10) || defaults?.date || ""} className={inputClass} />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="item-due-time" className={labelClass}>Time (optional)</label>
              <input id="item-due-time" name="dueTime" type="time" defaultValue={dueTimeDefault} className={inputClass} />
            </div>
            <p className="col-span-2 -mt-1 text-xs text-ink-3">No time = due by the end of that day. No date = unscheduled.</p>
          </div>
        )}

        {dealChoices.length > 0 ? (
          <div className="space-y-1.5">
            <label htmlFor="item-deal" className={labelClass}>Deal (optional)</label>
            <select id="item-deal" name="dealId" defaultValue={item?.dealId ?? defaults?.dealId ?? ""} className={inputClass}>
              <option value="">No deal</option>
              {dealChoices.map((deal) => (
                <option key={deal.id} value={deal.id}>
                  {deal.name}
                  {deal.closed ? " (closed)" : ""}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="space-y-1.5">
          <label htmlFor="item-notes" className={labelClass}>Notes</label>
          <textarea id="item-notes" name="notes" rows={3} maxLength={5000} defaultValue={item?.notes ?? ""} className={inputClass} />
        </div>
        {item && !scheduled ? (
          <label className="flex min-h-11 items-center gap-2 text-sm text-ink-2 sm:min-h-0">
            <input type="checkbox" name="completed" defaultChecked={item.completedAt != null} className="h-4 w-4 rounded border-line-strong accent-[var(--color-accent)]" />
            Completed
          </label>
        ) : null}
        <p className="text-xs text-ink-3">Times are in {timeZone.replace(/_/g, " ")}.</p>
        <DialogFooter>
          <button type="button" onClick={onClose} className={ghostButtonClass}>Cancel</button>
          <button type="submit" disabled={isPending} className={primaryButtonAutoClass}>
            {isPending ? "Saving…" : item ? "Save changes" : "Add"}
          </button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

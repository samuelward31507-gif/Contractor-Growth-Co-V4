"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Handshake } from "lucide-react";
import { Dialog, DialogFooter, DialogTitle } from "@/lib/ui/dialog";
import { Badge } from "@/lib/ui/badge";
import { destructiveGhostButtonAutoClass, ghostButtonClass, primaryButtonAutoClass, secondaryButtonAutoClass } from "@/lib/ui/form";
import { ITEM_KIND_LABELS, PRIORITY_LABELS, SCHEDULED_KINDS, isOverdue, type FounderItem } from "@/lib/founder/model";
import { KIND_STYLE, isAllDayEvent, isEndOfDayDue } from "@/lib/founder/calendar";
import { formatDateTime, formatDay, formatTime } from "@/lib/founder/format";
import { deleteFounderItem, setFounderItemCompleted } from "../actions";
import { ItemDialog, type DealOption } from "./item-dialog";
import { KindIcon } from "./kind-icon";

/** "Fri, Oct 9, 9:00 AM – 10:00 AM", "Fri, Oct 9 · All day", "Due Fri, Oct 9 (end of day)". */
export function describeItemTime(item: FounderItem, timeZone: string): string {
  if (SCHEDULED_KINDS.includes(item.kind) && item.startsAt) {
    if (isAllDayEvent(item, timeZone)) {
      const lastMoment = new Date(new Date(item.endsAt as string).getTime() - 1).toISOString();
      const first = formatDay(item.startsAt, timeZone);
      const last = formatDay(lastMoment, timeZone);
      return first === last ? `${first} · All day` : `${first} – ${last} · All day`;
    }
    if (!item.endsAt) return formatDateTime(item.startsAt, timeZone);
    const sameDay = formatDay(item.startsAt, timeZone) === formatDay(item.endsAt, timeZone);
    return `${formatDateTime(item.startsAt, timeZone)} – ${sameDay ? formatTime(item.endsAt, timeZone) : formatDateTime(item.endsAt, timeZone)}`;
  }
  if (!item.dueAt) return "No date - unscheduled";
  return isEndOfDayDue(item, timeZone) ? `Due ${formatDay(item.dueAt, timeZone)} (end of day)` : `Due ${formatDateTime(item.dueAt, timeZone)}`;
}

/**
 * An item's details: type, time, priority, notes and its linked deal (a
 * link into the pipeline), with complete / reopen, edit (reschedule) and a
 * two-step delete. Every action is one server action; the page reloads its
 * data afterwards.
 */
export function ItemDetails({
  item,
  deals,
  timeZone,
  nowIso,
  onClose,
  onSaved,
}: {
  item: FounderItem;
  deals: DealOption[];
  timeZone: string;
  nowIso: string;
  onClose: () => void;
  onSaved?: (message: string) => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scheduled = SCHEDULED_KINDS.includes(item.kind);
  const done = item.completedAt != null;
  const deal = item.dealId ? deals.find((d) => d.id === item.dealId) : null;

  function run(action: () => Promise<{ ok: boolean; error?: string }>, message: string) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "Something went wrong.");
        return;
      }
      onSaved?.(message);
      router.refresh();
      onClose();
    });
  }

  if (editing) {
    return <ItemDialog item={item} deals={deals} timeZone={timeZone} onClose={onClose} onSaved={onSaved} />;
  }

  return (
    <Dialog onClose={onClose} labelledBy="founder-item-details-title" className="max-h-[90vh] max-w-md overflow-y-auto">
      <p className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${KIND_STYLE[item.kind].chip}`}>
        <KindIcon kind={item.kind} />
        {ITEM_KIND_LABELS[item.kind]}
      </p>
      <div className="mt-2">
        <DialogTitle id="founder-item-details-title">
          <span className={done ? "text-ink-3 line-through" : ""}>{item.title}</span>
        </DialogTitle>
      </div>
      <dl className="mt-3 space-y-2 text-sm">
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-ink-3">When</dt>
          <dd className="text-ink">{describeItemTime(item, timeZone)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-ink-3">Priority</dt>
          <dd className="flex flex-wrap items-center gap-1.5 text-ink">
            {PRIORITY_LABELS[item.priority]}
            {isOverdue(item, new Date(nowIso)) ? <Badge tone="danger">Overdue</Badge> : null}
            {done ? <Badge tone="success">Completed</Badge> : null}
          </dd>
        </div>
        {item.dealId ? (
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 text-ink-3">Deal</dt>
            <dd>
              {deal ? (
                <Link href={`/founder/deals?deal=${deal.id}`} className="inline-flex items-center gap-1.5 font-medium text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink">
                  <Handshake className="h-3.5 w-3.5" aria-hidden />
                  {deal.name}
                </Link>
              ) : (
                <span className="text-ink-3">Linked deal unavailable</span>
              )}
            </dd>
          </div>
        ) : null}
        {item.notes ? (
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 text-ink-3">Notes</dt>
            <dd className="whitespace-pre-wrap text-ink-2">{item.notes}</dd>
          </div>
        ) : null}
      </dl>
      {error ? (
        <p role="alert" className="mt-3 text-sm font-medium text-danger-text">
          {error}
        </p>
      ) : null}
      <DialogFooter>
        {confirmDelete ? (
          <>
            <span className="mr-auto text-sm text-ink-2">Delete this item?</span>
            <button type="button" onClick={() => setConfirmDelete(false)} className={ghostButtonClass}>Keep</button>
            <button type="button" disabled={isPending} onClick={() => run(() => deleteFounderItem(item.id), "Item deleted.")} className={destructiveGhostButtonAutoClass}>
              Delete
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => setConfirmDelete(true)} className={`mr-auto ${destructiveGhostButtonAutoClass}`}>Delete</button>
            <button type="button" onClick={() => setEditing(true)} className={secondaryButtonAutoClass}>Edit / reschedule</button>
            {!scheduled ? (
              <button type="button" disabled={isPending} onClick={() => run(() => setFounderItemCompleted(item.id, !done), done ? "Reopened." : "Marked complete.")} className={primaryButtonAutoClass}>
                {done ? "Reopen" : "Complete"}
              </button>
            ) : null}
          </>
        )}
      </DialogFooter>
    </Dialog>
  );
}

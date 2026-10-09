"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Check, Pencil, Trash2 } from "lucide-react";
import { Badge } from "@/lib/ui/badge";
import { ITEM_KIND_LABELS, PRIORITY_LABELS, SCHEDULED_KINDS, isOverdue, type FounderItem } from "@/lib/founder/model";
import { formatDateTime, formatTime } from "@/lib/founder/format";
import { deleteFounderItem, setFounderItemCompleted } from "../actions";
import { ItemDialog, type DealOption } from "./item-dialog";

/**
 * A list of tasks and events: complete / reopen, edit, delete. Every control
 * calls one server action; the list re-renders from the server afterwards.
 */
export function ItemList({ items, deals, timeZone, nowIso, timeOnly = false }: { items: FounderItem[]; deals: DealOption[]; timeZone: string; nowIso: string; timeOnly?: boolean }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState<FounderItem | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = new Date(nowIso);
  const dealName = new Map(deals.map((deal) => [deal.id, deal.name]));

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error ?? "Something went wrong.");
      setConfirmDelete(null);
      router.refresh();
    });
  }

  return (
    <div>
      {error ? (
        <p role="alert" className="mb-2 text-sm font-medium text-danger-text">
          {error}
        </p>
      ) : null}
      <ul className="divide-y divide-line">
        {items.map((item) => {
          const done = item.completedAt != null;
          const overdue = isOverdue(item, now);
          const scheduled = SCHEDULED_KINDS.includes(item.kind);
          const when = scheduled ? item.startsAt : item.dueAt;
          return (
            <li key={item.id} className="flex items-start gap-3 py-3">
              {scheduled ? (
                <span aria-hidden className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-info-muted text-[10px] font-semibold text-info-text">
                  {ITEM_KIND_LABELS[item.kind].charAt(0)}
                </span>
              ) : (
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => run(() => setFounderItemCompleted(item.id, !done))}
                  aria-label={done ? `Reopen ${item.title}` : `Complete ${item.title}`}
                  aria-pressed={done}
                  className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 ${done ? "border-accent bg-accent text-white" : "border-line-strong hover:border-accent"}`}
                >
                  {done ? <Check className="h-3.5 w-3.5" aria-hidden /> : null}
                </button>
              )}
              <div className="min-w-0 flex-1">
                <p className={`text-sm font-medium ${done ? "text-ink-3 line-through" : "text-ink"}`}>{item.title}</p>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
                  <span>{ITEM_KIND_LABELS[item.kind]}</span>
                  {when ? (
                    <span className={`tabular-nums ${overdue ? "font-medium text-danger-text" : ""}`}>
                      · {scheduled ? "" : "Due "}
                      {timeOnly ? formatTime(when, timeZone) : formatDateTime(when, timeZone)}
                      {scheduled && item.endsAt ? `–${formatTime(item.endsAt, timeZone)}` : ""}
                    </span>
                  ) : (
                    <span>· No date</span>
                  )}
                  {item.dealId && dealName.get(item.dealId) ? <span>· {dealName.get(item.dealId)}</span> : null}
                  {overdue ? <Badge tone="danger">Overdue</Badge> : null}
                  {item.priority === "high" && !done ? <Badge tone="warning">{PRIORITY_LABELS.high} priority</Badge> : null}
                </div>
                {item.notes ? <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-ink-2">{item.notes}</p> : null}
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                {confirmDelete === item.id ? (
                  <>
                    <button type="button" disabled={isPending} onClick={() => run(() => deleteFounderItem(item.id))} className="min-h-9 rounded-md px-2 text-xs font-semibold text-danger-text hover:bg-danger-muted">
                      Delete
                    </button>
                    <button type="button" onClick={() => setConfirmDelete(null)} className="min-h-9 rounded-md px-2 text-xs font-medium text-ink-3 hover:bg-inset">
                      Keep
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" aria-label={`Edit ${item.title}`} onClick={() => setEditing(item)} className="flex h-9 w-9 items-center justify-center rounded-md text-ink-3 hover:bg-inset hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                      <Pencil className="h-4 w-4" aria-hidden />
                    </button>
                    <button type="button" aria-label={`Delete ${item.title}`} onClick={() => setConfirmDelete(item.id)} className="flex h-9 w-9 items-center justify-center rounded-md text-ink-3 hover:bg-danger-muted hover:text-danger-text focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {editing ? <ItemDialog item={editing} deals={deals} timeZone={timeZone} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

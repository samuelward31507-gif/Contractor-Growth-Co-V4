"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { ArrowDown, ArrowUp, Check, Target, X } from "lucide-react";
import { inputClass, primaryButtonAutoClass, secondaryButtonAutoClass } from "@/lib/ui/form";
import { ITEM_KIND_LABELS, type FounderItem } from "@/lib/founder/model";
import { MAX_DAILY_PRIORITIES } from "@/lib/founder/daily";
import { addFounderPriority, moveFounderPriority, removeFounderPriority, setFounderItemCompleted, setFounderPriority, type FounderActionResult } from "../actions";

const FOCUS = "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
const ICON_BUTTON = `flex h-9 w-9 items-center justify-center rounded-md text-ink-3 hover:bg-inset hover:text-ink disabled:opacity-30 ${FOCUS}`;

function newClientId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : "";
}

/**
 * The day's (up to three) most important outcomes. A priority is an ordinary
 * founder item marked for a day - complete it here, reorder with the arrows,
 * remove the marking (the item stays), add a new one by title or pick an
 * existing open task. Used for today on /founder and for tomorrow in the
 * end-of-day review. Every button is one server action.
 */
export function DailyPriorities({
  dateKey,
  dayLabel,
  priorities,
  candidates,
  available,
}: {
  dateKey: string;
  /** "today" / "tomorrow" - used in copy and labels. */
  dayLabel: string;
  priorities: FounderItem[];
  /** Open tasks, follow-ups and deadlines that could be picked. */
  candidates: FounderItem[];
  /** False when the daily-focus columns don't exist yet. */
  available: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [clientId, setClientId] = useState(newClientId);
  const titleRef = useRef<HTMLInputElement>(null);
  const done = priorities.filter((item) => item.completedAt != null).length;
  const full = priorities.length >= MAX_DAILY_PRIORITIES;

  function run(action: () => Promise<FounderActionResult>, success: string, after?: () => void) {
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setMessage({ tone: "error", text: result.error });
        return;
      }
      after?.();
      setMessage({ tone: "ok", text: success });
      router.refresh();
    });
  }

  if (!available) {
    return (
      <p className="rounded-lg border border-line bg-inset/50 px-3 py-2.5 text-sm text-ink-3">
        Daily priorities aren&rsquo;t enabled on this database yet (it needs the founder_daily_focus update). Everything else on this page works.
      </p>
    );
  }

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs text-ink-3">
          The {MAX_DAILY_PRIORITIES} outcomes that make {dayLabel} a good day.
        </p>
        {priorities.length ? (
          <p className="shrink-0 text-xs font-medium tabular-nums text-ink-2" aria-label={`${done} of ${priorities.length} priorities done`}>
            {done}/{priorities.length} done
          </p>
        ) : null}
      </div>

      {priorities.length ? (
        <ol className="mt-2 divide-y divide-line rounded-lg border border-line">
          {priorities.map((item, index) => {
            const complete = item.completedAt != null;
            return (
              <li key={item.id} className="flex items-center gap-2 px-2 py-1.5 sm:gap-3 sm:px-3">
                <span aria-hidden className="w-4 shrink-0 text-center text-xs font-semibold tabular-nums text-ink-3">{index + 1}</span>
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => run(() => setFounderItemCompleted(item.id, !complete), complete ? "Reopened." : "Done - nice.")}
                  aria-label={complete ? `Reopen ${item.title}` : `Complete ${item.title}`}
                  aria-pressed={complete}
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-colors disabled:opacity-50 ${FOCUS} ${complete ? "border-accent bg-accent text-white" : "border-line-strong hover:border-accent"}`}
                >
                  {complete ? <Check className="h-4 w-4" aria-hidden /> : null}
                </button>
                <div className="min-w-0 flex-1">
                  <p className={`line-clamp-2 break-words text-sm font-medium sm:line-clamp-1 ${complete ? "text-ink-3 line-through" : "text-ink"}`}>{item.title}</p>
                  {item.kind !== "task" ? <p className="text-xs text-ink-3">{ITEM_KIND_LABELS[item.kind]}</p> : null}
                </div>
                <div className="flex shrink-0 items-center">
                  <button type="button" disabled={isPending || index === 0} onClick={() => run(() => moveFounderPriority(item.id, "up"), "Reordered.")} aria-label={`Move ${item.title} up`} className={ICON_BUTTON}>
                    <ArrowUp className="h-4 w-4" aria-hidden />
                  </button>
                  <button type="button" disabled={isPending || index === priorities.length - 1} onClick={() => run(() => moveFounderPriority(item.id, "down"), "Reordered.")} aria-label={`Move ${item.title} down`} className={ICON_BUTTON}>
                    <ArrowDown className="h-4 w-4" aria-hidden />
                  </button>
                  <button type="button" disabled={isPending} onClick={() => run(() => removeFounderPriority(item.id), "Removed from priorities (the item is kept).")} aria-label={`Remove ${item.title} from priorities`} className={ICON_BUTTON}>
                    <X className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="mt-2 flex items-center gap-2.5 rounded-lg border border-dashed border-line-strong px-3 py-3 text-sm text-ink-3">
          <Target className="h-4 w-4 shrink-0" aria-hidden />
          No priorities set for {dayLabel}. Add up to {MAX_DAILY_PRIORITIES} below.
        </div>
      )}

      {!full ? (
        <div className="mt-3 space-y-2">
          <form
            className="flex flex-col gap-2 sm:flex-row"
            action={(formData) => {
              const title = String(formData.get("title") ?? "");
              run(() => addFounderPriority({ title, date: dateKey, clientId }), "Priority added.", () => {
                if (titleRef.current) titleRef.current.value = "";
                setClientId(newClientId());
              });
            }}
          >
            <label htmlFor={`priority-title-${dateKey}`} className="sr-only">New priority for {dayLabel}</label>
            <input ref={titleRef} id={`priority-title-${dateKey}`} name="title" required maxLength={300} placeholder={`Add a priority for ${dayLabel}…`} className={`${inputClass} flex-1`} />
            <button type="submit" disabled={isPending} className={primaryButtonAutoClass}>
              {isPending ? "Saving…" : "Add"}
            </button>
          </form>
          {candidates.length ? (
            <form
              className="flex flex-col gap-2 sm:flex-row"
              action={(formData) => {
                const itemId = String(formData.get("itemId") ?? "");
                if (itemId) run(() => setFounderPriority(itemId, dateKey), "Priority set.");
              }}
            >
              <label htmlFor={`priority-pick-${dateKey}`} className="sr-only">Or pick an existing open item</label>
              <select id={`priority-pick-${dateKey}`} name="itemId" required defaultValue="" className={`${inputClass} flex-1`}>
                <option value="" disabled>
                  Or pick an open task…
                </option>
                {candidates.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                    {item.kind !== "task" ? ` (${ITEM_KIND_LABELS[item.kind]})` : ""}
                  </option>
                ))}
              </select>
              <button type="submit" disabled={isPending} className={secondaryButtonAutoClass}>
                Make priority
              </button>
            </form>
          ) : null}
        </div>
      ) : null}

      {message ? (
        <p role={message.tone === "error" ? "alert" : "status"} className={`mt-2 text-sm ${message.tone === "error" ? "text-danger-text" : "text-accent-text"}`}>
          {message.text}
        </p>
      ) : null}
    </div>
  );
}

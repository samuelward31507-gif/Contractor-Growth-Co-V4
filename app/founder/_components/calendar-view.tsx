"use client";

import Link from "next/link";
import { useState } from "react";
import { CalendarPlus, Inbox } from "lucide-react";
import { SCHEDULED_KINDS, isOverdue, type FounderItem } from "@/lib/founder/model";
import { KIND_STYLE, calendarHref, dayOfWeek, type CalendarView as View } from "@/lib/founder/calendar";
import { formatTime } from "@/lib/founder/format";
import { ItemDialog, type DealOption, type ItemDefaults } from "./item-dialog";
import { ItemDetails, describeItemTime } from "./item-details";
import { KindIcon } from "./kind-icon";

/** One placed item, as computed on the server (lib/founder/calendar.ts placeItems). */
export type DayEntry = { id: string; allDay: boolean; continued: boolean };

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const FOCUS = "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
const dayNumber = (key: string) => Number(key.slice(8, 10));
const longDay = (key: string) => new Date(`${key}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });

/**
 * The interactive part of /founder/calendar. The server decides the range,
 * loads the founder's items and places them on days; this renders the month
 * grid, the week columns or the day agenda, plus the unscheduled list, and
 * owns the dialogs: click an item for its details (complete, edit /
 * reschedule, delete, linked deal), or add an item on a given day.
 */
export function CalendarView({
  view,
  anchor,
  days,
  todayKey,
  entriesByDay,
  items,
  unscheduled,
  deals,
  timeZone,
  nowIso,
}: {
  view: View;
  anchor: string;
  days: string[];
  todayKey: string;
  entriesByDay: Record<string, DayEntry[]>;
  items: FounderItem[];
  unscheduled: FounderItem[];
  deals: DealOption[];
  timeZone: string;
  nowIso: string;
}) {
  const [selected, setSelected] = useState<FounderItem | null>(null);
  const [creating, setCreating] = useState<ItemDefaults | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const byId = new Map([...items, ...unscheduled].map((item) => [item.id, item]));
  const now = new Date(nowIso);
  const anchorMonth = anchor.slice(0, 7);

  /** compact: the month grid's one-line chip. timeLabel: overrides the time line ("No date"), or false to omit it (the day view shows times in its own column). */
  function renderChip(entry: DayEntry, compact = false, timeLabel?: string | false) {
    const item = byId.get(entry.id);
    if (!item) return null;
    const done = item.completedAt != null;
    const overdue = isOverdue(item, now);
    const at = SCHEDULED_KINDS.includes(item.kind) ? item.startsAt : item.dueAt;
    const time = entry.continued ? "cont." : entry.allDay ? null : at ? formatTime(at, timeZone) : null;
    return (
      <button
        type="button"
        onClick={() => setSelected(item)}
        aria-label={`${item.title}, ${describeItemTime(item, timeZone)}${done ? ", completed" : ""}${overdue ? ", overdue" : ""}`}
        className={`w-full min-w-0 rounded-md border px-1.5 text-left text-[12px] leading-tight transition-colors hover:brightness-[0.97] ${compact ? "flex min-h-6 items-center gap-1 py-0.5" : "block min-h-9 py-1.5 sm:min-h-7"} ${KIND_STYLE[item.kind].chip} ${overdue ? "ring-1 ring-danger-text/40" : ""} ${FOCUS}`}
      >
        {compact ? (
          <>
            <KindIcon kind={item.kind} className="h-3 w-3" />
            <span className={`min-w-0 truncate font-medium ${done ? "line-through opacity-60" : ""}`}>{item.title}</span>
            {time ? <span className="ml-auto hidden shrink-0 pl-1 tabular-nums opacity-70 2xl:inline">{time}</span> : null}
          </>
        ) : (
          <>
            {timeLabel === false ? (
              <span className={`flex min-w-0 items-center gap-1 font-medium ${done ? "line-through opacity-60" : ""}`}>
                <KindIcon kind={item.kind} className="h-3 w-3" />
                <span className="truncate">{item.title}</span>
              </span>
            ) : (
              <>
                <span className="flex items-center gap-1 opacity-80">
                  <KindIcon kind={item.kind} className="h-3 w-3" />
                  <span className="tabular-nums">{timeLabel ?? time ?? (entry.allDay ? "All day" : "")}</span>
                </span>
                <span className={`mt-0.5 block truncate font-medium ${done ? "line-through opacity-60" : ""}`}>{item.title}</span>
              </>
            )}
          </>
        )}
      </button>
    );
  }

  function renderAddButton(day: string, label: string) {
    return (
      <button type="button" onClick={() => setCreating({ date: day })} aria-label={label} className={`flex h-7 w-7 items-center justify-center rounded-md text-ink-3 hover:bg-inset hover:text-ink ${FOCUS}`}>
        <CalendarPlus className="h-3.5 w-3.5" aria-hidden />
      </button>
    );
  }

  const dayEntries = (day: string) => entriesByDay[day] ?? [];

  return (
    <div className="flex flex-col gap-6 2xl:flex-row 2xl:items-start">
      <div className="min-w-0 flex-1">
        {flash ? (
          <p role="status" className="mb-3 rounded-lg border border-accent-border bg-accent-muted px-3 py-2 text-sm text-accent-text">
            {flash}
          </p>
        ) : null}

        {view === "month" ? (
          <div className="overflow-hidden rounded-xl border border-line bg-surface">
            <div className="grid grid-cols-7 border-b border-line bg-inset/50 text-center text-[11px] font-medium uppercase tracking-wide text-ink-3" aria-hidden>
              {WEEKDAYS.map((d) => (
                <div key={d} className="py-2">{d}</div>
              ))}
            </div>
            <ol className="grid grid-cols-7" aria-label="Month">
              {days.map((day) => {
                const entries = dayEntries(day);
                const outside = day.slice(0, 7) !== anchorMonth;
                const isToday = day === todayKey;
                return (
                  <li key={day} className={`group min-h-[64px] border-b border-r border-line p-1 sm:min-h-[112px] sm:p-1.5 [&:nth-child(7n)]:border-r-0 ${outside ? "bg-inset/40" : ""}`} aria-label={`${longDay(day)}, ${entries.length} item${entries.length === 1 ? "" : "s"}`}>
                    <div className="flex items-center justify-between">
                      <Link href={calendarHref("day", day)} aria-label={`Open ${longDay(day)}`} className={`flex h-7 min-w-7 items-center justify-center rounded-full px-1 text-xs tabular-nums ${isToday ? "bg-ink font-semibold text-white" : outside ? "text-ink-4" : "text-ink-2 hover:bg-inset"} ${FOCUS}`}>
                        {dayNumber(day)}
                      </Link>
                      <span className="hidden sm:inline sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                        {renderAddButton(day, `Add on ${longDay(day)}`)}
                      </span>
                    </div>
                    {/* Phones: colored dots and a count - tap the day number for its agenda. */}
                    {entries.length ? (
                      <div className="mt-1 flex flex-wrap gap-0.5 sm:hidden" aria-hidden>
                        {entries.slice(0, 4).map((entry) => {
                          const item = byId.get(entry.id);
                          return item ? <span key={entry.id + day} className={`h-1.5 w-1.5 rounded-full ${KIND_STYLE[item.kind].dot}`} /> : null;
                        })}
                      </div>
                    ) : null}
                    <ul className="mt-1 hidden space-y-0.5 sm:block">
                      {entries.slice(0, 3).map((entry) => (
                        <li key={entry.id}>
                          {renderChip(entry, true)}
                        </li>
                      ))}
                    </ul>
                    {entries.length > 3 ? (
                      <Link href={calendarHref("day", day)} className={`mt-0.5 hidden rounded px-1 text-[11px] font-medium text-ink-3 hover:text-ink sm:inline-block ${FOCUS}`}>
                        +{entries.length - 3} more
                      </Link>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </div>
        ) : view === "week" ? (
          <ol className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 xl:gap-2" aria-label="Week">
            {days.map((day) => {
              const entries = dayEntries(day);
              const isToday = day === todayKey;
              return (
                <li key={day} className={`rounded-xl border bg-surface p-2 ${isToday ? "border-ink/40" : "border-line"}`}>
                  <div className="flex items-center justify-between gap-1">
                    <Link href={calendarHref("day", day)} className={`rounded text-xs font-semibold ${isToday ? "text-ink" : "text-ink-2"} hover:underline ${FOCUS}`}>
                      <span className="text-ink-3">{WEEKDAYS[dayOfWeek(day)]}</span> {dayNumber(day)}
                      {isToday ? <span className="ml-1 font-normal text-ink-3">· Today</span> : null}
                    </Link>
                    {renderAddButton(day, `Add on ${longDay(day)}`)}
                  </div>
                  {entries.length ? (
                    <ul className="mt-1.5 space-y-1">
                      {entries.map((entry) => (
                        <li key={entry.id}>
                          {renderChip(entry)}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1.5 text-xs text-ink-4">Nothing scheduled</p>
                  )}
                </li>
              );
            })}
          </ol>
        ) : (
          <section aria-label={longDay(anchor)} className="rounded-xl border border-line bg-surface p-3 sm:p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink">{longDay(anchor)}</h2>
              {renderAddButton(anchor, `Add on ${longDay(anchor)}`)}
            </div>
            {dayEntries(anchor).length ? (
              <ul className="mt-3 divide-y divide-line">
                {dayEntries(anchor).map((entry) => {
                  const item = byId.get(entry.id);
                  if (!item) return null;
                  const at = SCHEDULED_KINDS.includes(item.kind) ? item.startsAt : item.dueAt;
                  return (
                    <li key={entry.id} className="flex items-start gap-3 py-2">
                      <span className="w-16 shrink-0 pt-2 text-right text-xs tabular-nums text-ink-3">{entry.continued ? "Cont." : entry.allDay ? "All day" : at ? formatTime(at, timeZone) : ""}</span>
                      <div className="min-w-0 flex-1">
                        {renderChip(entry, false, false)}
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="mt-6 flex flex-col items-center gap-2 py-8 text-center">
                <p className="text-sm font-medium text-ink">Nothing on this day</p>
                <p className="max-w-xs text-sm text-ink-3">Add a meeting, event or task for this day.</p>
                <button type="button" onClick={() => setCreating({ date: anchor })} className={`mt-1 rounded-md border border-line px-3 py-1.5 text-sm font-medium text-ink-2 hover:bg-inset ${FOCUS}`}>
                  Add item
                </button>
              </div>
            )}
          </section>
        )}

        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3" aria-label="Legend">
          {(["meeting", "event", "task", "deadline", "follow_up"] as const).map((kind) => (
            <li key={kind} className="inline-flex items-center gap-1.5">
              <span className={`inline-flex h-4 w-4 items-center justify-center rounded border ${KIND_STYLE[kind].chip}`}>
                <KindIcon kind={kind} className="h-2.5 w-2.5" />
              </span>
              {kind === "follow_up" ? "Follow-up" : kind.charAt(0).toUpperCase() + kind.slice(1)}
            </li>
          ))}
        </ul>
      </div>

      <aside aria-labelledby="unscheduled-title" className="w-full shrink-0 rounded-xl border border-line bg-surface p-3 2xl:w-72">
        <h2 id="unscheduled-title" className="flex items-center justify-between text-sm font-semibold text-ink">
          Unscheduled
          <span className="text-xs font-normal tabular-nums text-ink-3">{unscheduled.length}</span>
        </h2>
        <p className="mt-0.5 text-xs text-ink-3">Open tasks with no date. Open one to give it a date.</p>
        {unscheduled.length ? (
          <ul className="mt-2 space-y-1">
            {unscheduled.map((item) => (
              <li key={item.id}>
                {renderChip({ id: item.id, allDay: false, continued: false }, false, "No date")}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 flex items-center gap-2 text-xs text-ink-3">
            <Inbox className="h-3.5 w-3.5" aria-hidden />
            Everything open has a date.
          </p>
        )}
      </aside>

      {selected ? <ItemDetails item={selected} deals={deals} timeZone={timeZone} nowIso={nowIso} onClose={() => setSelected(null)} onSaved={setFlash} /> : null}
      {creating ? <ItemDialog defaultKind="meeting" defaults={creating} deals={deals} timeZone={timeZone} onClose={() => setCreating(null)} onSaved={setFlash} /> : null}
    </div>
  );
}

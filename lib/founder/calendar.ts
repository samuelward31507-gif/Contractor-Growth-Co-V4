/**
 * Founder calendar - the pure date logic behind /founder/calendar: which
 * days a month / week / day view shows, how prev / next / Today move, and
 * which day(s) each founder_item lands on. Everything is computed in the
 * founder's own time zone (founder_users.timezone, default America/Denver)
 * using calendar-date keys (YYYY-MM-DD) and DST-correct day boundaries from
 * model.ts, so an item always lands on the local day it belongs to.
 */
import { SCHEDULED_KINDS, addDaysKey, dayRange, isDateKey, itemTime, localDateKey, toLocalInputValue, type FounderItem, type ItemKind } from "./model";

export const CALENDAR_VIEWS = ["month", "week", "day"] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

/** 0 = Sunday. Weeks start on Sunday. */
export function dayOfWeek(key: string): number {
  return new Date(`${key}T12:00:00Z`).getUTCDay();
}

function startOfWeek(key: string): string {
  return addDaysKey(key, -dayOfWeek(key));
}

function monthStart(key: string): string {
  return `${key.slice(0, 7)}-01`;
}

function addMonthsToDay(key: string, months: number): string {
  const [y, m] = key.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  return first.toISOString().slice(0, 10);
}

/** Normalizes ?view= and ?date= - anything invalid falls back to the month view of today. */
export function parseCalendarParams(params: { view?: unknown; date?: unknown }, todayKey: string): { view: CalendarView; anchor: string } {
  const view = (CALENDAR_VIEWS as readonly string[]).includes(String(params.view)) ? (params.view as CalendarView) : "month";
  const anchor = isDateKey(params.date) ? params.date : todayKey;
  return { view, anchor };
}

export type CalendarRange = {
  view: CalendarView;
  anchor: string;
  /** Every day shown, in order (month: whole weeks, Sunday-Saturday). */
  days: string[];
  /** The instant range those days cover in the founder's zone: [start, end). */
  start: Date;
  end: Date;
};

export function calendarRange(view: CalendarView, anchor: string, timeZone: string): CalendarRange {
  let first: string;
  let count: number;
  if (view === "day") {
    first = anchor;
    count = 1;
  } else if (view === "week") {
    first = startOfWeek(anchor);
    count = 7;
  } else {
    const firstOfMonth = monthStart(anchor);
    const lastOfMonth = addDaysKey(addMonthsToDay(firstOfMonth, 1), -1);
    first = startOfWeek(firstOfMonth);
    const last = addDaysKey(lastOfMonth, 6 - dayOfWeek(lastOfMonth));
    count = Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000) + 1;
  }
  const days = Array.from({ length: count }, (_, i) => addDaysKey(first, i));
  return { view, anchor, days, start: dayRange(days[0], timeZone).start, end: dayRange(days[days.length - 1], timeZone).end };
}

/** The anchor one step back (-1) or forward (+1): a month, a week or a day. */
export function shiftAnchor(view: CalendarView, anchor: string, direction: -1 | 1): string {
  if (view === "day") return addDaysKey(anchor, direction);
  if (view === "week") return addDaysKey(anchor, 7 * direction);
  return addMonthsToDay(monthStart(anchor), direction);
}

export function calendarHref(view: CalendarView, anchor: string): string {
  return `/founder/calendar?view=${view}&date=${anchor}`;
}

const fmt = (key: string, options: Intl.DateTimeFormatOptions) => new Date(`${key}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", ...options });

/** "October 2026" / "Oct 4 – 10, 2026" / "Friday, October 9, 2026". */
export function calendarTitle(range: CalendarRange): string {
  if (range.view === "month") return fmt(range.anchor, { month: "long", year: "numeric" });
  if (range.view === "day") return fmt(range.anchor, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const first = range.days[0];
  const last = range.days[range.days.length - 1];
  const sameMonth = first.slice(0, 7) === last.slice(0, 7);
  const sameYear = first.slice(0, 4) === last.slice(0, 4);
  return `${fmt(first, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) })} – ${fmt(last, sameMonth ? { day: "numeric" } : { month: "short", day: "numeric" })}, ${last.slice(0, 4)}`;
}

/** An event stored as local midnight to a later local midnight - entered as all-day. */
export function isAllDayEvent(item: Pick<FounderItem, "kind" | "startsAt" | "endsAt">, timeZone: string): boolean {
  if (!SCHEDULED_KINDS.includes(item.kind) || !item.startsAt || !item.endsAt || item.endsAt <= item.startsAt) return false;
  return toLocalInputValue(item.startsAt, timeZone).endsWith("T00:00") && toLocalInputValue(item.endsAt, timeZone).endsWith("T00:00");
}

/** A task entered with a date and no time is due by the end of that day (stored as 23:59 local). */
export function isEndOfDayDue(item: Pick<FounderItem, "kind" | "dueAt">, timeZone: string): boolean {
  return !SCHEDULED_KINDS.includes(item.kind) && item.dueAt != null && toLocalInputValue(item.dueAt, timeZone).endsWith("T23:59");
}

export type CalendarEntry = {
  item: FounderItem;
  /** No time to show: an all-day event, or a task due "by end of day". */
  allDay: boolean;
  /** A multi-day event continuing from an earlier day. */
  continued: boolean;
};

/**
 * Which local day(s) each item falls on, for the given days. Events and
 * meetings cover every local day from their start to their end (the end
 * instant itself is exclusive); tasks, follow-ups and deadlines land on
 * their due day. Undated items are not placed - the calendar lists them
 * separately. Each day's entries: all-day first, then by time, then title.
 */
export function placeItems(items: FounderItem[], days: string[], timeZone: string): Map<string, CalendarEntry[]> {
  const byDay = new Map<string, CalendarEntry[]>(days.map((day) => [day, []]));
  for (const item of items) {
    const at = itemTime(item);
    if (!at) continue;
    const allDayEvent = isAllDayEvent(item, timeZone);
    const firstDay = localDateKey(new Date(at), timeZone);
    let lastDay = firstDay;
    if (SCHEDULED_KINDS.includes(item.kind) && item.endsAt && item.endsAt > item.startsAt!) {
      lastDay = localDateKey(new Date(new Date(item.endsAt).getTime() - 1), timeZone);
    }
    for (let day = firstDay; day <= lastDay; day = addDaysKey(day, 1)) {
      const list = byDay.get(day);
      if (list) list.push({ item, allDay: allDayEvent || isEndOfDayDue(item, timeZone), continued: day !== firstDay });
    }
  }
  for (const list of byDay.values()) {
    list.sort((a, b) => {
      if (a.allDay !== b.allDay || a.continued !== b.continued) return Number(!(a.allDay || a.continued)) - Number(!(b.allDay || b.continued));
      const ta = itemTime(a.item) ?? "";
      const tb = itemTime(b.item) ?? "";
      return ta < tb ? -1 : ta > tb ? 1 : a.item.title.localeCompare(b.item.title);
    });
  }
  return byDay;
}

/** How each type looks, so meetings, events, tasks, deadlines and follow-ups are told apart by more than color (each also has its own icon and label). */
export const KIND_STYLE: Record<ItemKind, { chip: string; dot: string }> = {
  meeting: { chip: "border-info-border bg-info-muted text-info-text", dot: "bg-info-text" },
  event: { chip: "border-accent-border bg-accent-muted text-accent-text", dot: "bg-accent" },
  task: { chip: "border-line bg-surface text-ink", dot: "bg-ink-3" },
  deadline: { chip: "border-danger-border bg-danger-muted text-danger-text", dot: "bg-danger-text" },
  follow_up: { chip: "border-warning-border bg-warning-muted text-warning-text", dot: "bg-warning-text" },
};

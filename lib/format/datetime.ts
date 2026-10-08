/**
 * Batch 1 (Cinder design foundation): the one date/time presentation path.
 * Every date or time a person reads is rendered in the organization's
 * timezone (UTC when unknown or invalid) - never the server's or the
 * browser's. Display only: nothing here schedules, compares for automation
 * timing, or touches a stored timestamp.
 *
 *   formatDate("…", tz)            -> "Oct 9, 2026"
 *   formatTime("…", tz)            -> "2:00 PM"
 *   formatDateTime("…", tz)        -> "Oct 9, 2026, 2:00 PM"
 *   formatRelativeTime("…")        -> "2 hours ago" / "in 3 days" / "yesterday"
 *   formatCalendarDateTime("…", tz) -> "Today at 2:00 PM" / "Yesterday at 9:15 AM"
 *                                      / "Tomorrow at 2:00 PM" / "Oct 9 at 2:00 PM"
 *   formatCalendarDay("…", tz)     -> "Today" / "Yesterday" / "Tomorrow" / "Oct 9"
 */

export function resolveTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return timeZone;
  } catch {
    return "UTC";
  }
}

function toMs(value: string | number | Date): number {
  return value instanceof Date ? value.getTime() : typeof value === "number" ? value : new Date(value).getTime();
}

function parts(ms: number, timeZone: string): { year: number; month: number; day: number } {
  const out: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(ms)) {
    out[part.type] = part.value;
  }
  return { year: Number(out.year), month: Number(out.month), day: Number(out.day) };
}

/** Whole calendar days from `now` to `value` in `timeZone` (0 = same day, -1 = yesterday, 1 = tomorrow). */
function calendarDayOffset(ms: number, now: number, timeZone: string): number {
  const a = parts(ms, timeZone);
  const b = parts(now, timeZone);
  return Math.round((Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day)) / 86_400_000);
}

export function formatDate(value: string | number | Date, timeZone?: string | null): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: resolveTimeZone(timeZone), month: "short", day: "numeric", year: "numeric" }).format(toMs(value));
}

export function formatTime(value: string | number | Date, timeZone?: string | null): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: resolveTimeZone(timeZone), hour: "numeric", minute: "2-digit" }).format(toMs(value));
}

export function formatDateTime(value: string | number | Date, timeZone?: string | null): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: resolveTimeZone(timeZone), dateStyle: "medium", timeStyle: "short" }).format(toMs(value));
}

/** "Today" / "Yesterday" / "Tomorrow", else "Oct 9" (with the year when it isn't this year). */
export function formatCalendarDay(value: string | number | Date, timeZone?: string | null, now: number = Date.now()): string {
  const zone = resolveTimeZone(timeZone);
  const ms = toMs(value);
  const offset = calendarDayOffset(ms, now, zone);
  if (offset === 0) return "Today";
  if (offset === -1) return "Yesterday";
  if (offset === 1) return "Tomorrow";
  const sameYear = parts(ms, zone).year === parts(now, zone).year;
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(ms);
}

/** "Today at 2:00 PM", "Yesterday at 9:15 AM", "Tomorrow at 2:00 PM", "Oct 9 at 2:00 PM". */
export function formatCalendarDateTime(value: string | number | Date, timeZone?: string | null, now: number = Date.now()): string {
  return `${formatCalendarDay(value, timeZone, now)} at ${formatTime(value, timeZone)}`;
}

const DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: "seconds" },
  { amount: 60, unit: "minutes" },
  { amount: 24, unit: "hours" },
  { amount: 7, unit: "days" },
  { amount: 4.34524, unit: "weeks" },
  { amount: 12, unit: "months" },
  { amount: Number.POSITIVE_INFINITY, unit: "years" },
];

const relativeTimeFormatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "2 hours ago", "in 3 days", "yesterday" - an elapsed duration, so no timezone is involved. */
export function formatRelativeTime(value: string | number | Date, now: number = Date.now()): string {
  let duration = (toMs(value) - now) / 1000;
  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return relativeTimeFormatter.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return relativeTimeFormatter.format(Math.round(duration), "years");
}

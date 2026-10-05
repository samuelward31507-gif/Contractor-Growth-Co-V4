import { zonedWallTimeToUtc } from "@/lib/scheduling/availability";

/**
 * "What day is it, in the organization's timezone?" - sent to n8n with every
 * customer reply so the AI can turn "next Tuesday" / "tomorrow afternoon" /
 * "next week" into the exact booking_intent date_range_start/end the
 * callback's availability check requires. Without it the model has no
 * reference date and (correctly) leaves the range null, which the callback
 * rejects as missing_date_range.
 *
 * The model is never asked to do calendar arithmetic or timezone math: every
 * upcoming local day is listed with its weekday, its Mon-Sun week, its UTC
 * offset and its exact UTC start/end instants. Resolving a phrase is then a
 * lookup, and whatever range comes back is validated by the callback and
 * checked against real availability as before - nothing here books anything.
 */

export const SCHEDULING_CALENDAR_DAYS = 14;

export type SchedulingCalendarDay = {
  /** Organization-local calendar date, YYYY-MM-DD. */
  date: string;
  /** e.g. "Tuesday". */
  weekday: string;
  /** Mon-Sun calendar week relative to today: "this_week" or "next_week" (later days: "later"). */
  week: "this_week" | "next_week" | "later";
  /** The day's local UTC offset, e.g. "-06:00" (per day, so it stays right across a DST change). */
  utc_offset: string;
  /** First instant of the local day, UTC ISO. */
  start: string;
  /** Last instant of the local day (next local midnight minus 1 ms), UTC ISO. */
  end: string;
};

export type SchedulingDateContext = {
  now_iso: string;
  timezone: string;
  today: string;
  today_weekday: string;
  local_time: string;
  utc_offset: string;
  this_week: { start: string; end: string };
  next_week: { start: string; end: string };
  upcoming_days: SchedulingCalendarDay[];
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function localParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

const pad = (value: number) => String(value).padStart(2, "0");

function formatOffset(localMidnight: Date, year: number, month: number, day: number): string {
  const offsetMinutes = Math.round((Date.UTC(year, month - 1, day) - localMidnight.getTime()) / 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

/** Pure - `now` is always injected. An unknown/empty timezone falls back to UTC, matching the contract's own default. */
export function buildSchedulingDateContext(now: Date, timeZone: string | null | undefined): SchedulingDateContext {
  const zone = timeZone && isValidTimeZone(timeZone) ? timeZone : "UTC";
  const today = localParts(now, zone);

  // Plain calendar dates; Date.UTC normalizes month/year rollover.
  const dayAt = (offset: number) => {
    const d = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: d.getUTCDay() };
  };
  const startOf = (offset: number) => {
    const d = dayAt(offset);
    return zonedWallTimeToUtc(d.year, d.month, d.day, 0, zone);
  };

  const todayWeekday = dayAt(0).weekday;
  const daysSinceMonday = (todayWeekday + 6) % 7;
  const nextMondayOffset = 7 - daysSinceMonday;

  const upcoming_days: SchedulingCalendarDay[] = Array.from({ length: SCHEDULING_CALENDAR_DAYS }, (_, offset) => {
    const d = dayAt(offset);
    const start = startOf(offset);
    return {
      date: `${d.year}-${pad(d.month)}-${pad(d.day)}`,
      weekday: WEEKDAYS[d.weekday]!,
      week: offset < nextMondayOffset ? "this_week" : offset < nextMondayOffset + 7 ? "next_week" : "later",
      utc_offset: formatOffset(start, d.year, d.month, d.day),
      start: start.toISOString(),
      end: new Date(startOf(offset + 1).getTime() - 1).toISOString(),
    };
  });

  const todayStart = startOf(0);
  return {
    now_iso: now.toISOString(),
    timezone: zone,
    today: upcoming_days[0]!.date,
    today_weekday: upcoming_days[0]!.weekday,
    local_time: `${pad(today.hour)}:${pad(today.minute)}`,
    utc_offset: formatOffset(todayStart, today.year, today.month, today.day),
    this_week: { start: todayStart.toISOString(), end: new Date(startOf(nextMondayOffset).getTime() - 1).toISOString() },
    next_week: { start: startOf(nextMondayOffset).toISOString(), end: new Date(startOf(nextMondayOffset + 7).getTime() - 1).toISOString() },
    upcoming_days,
  };
}

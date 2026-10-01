import { addDaysToCalendarDate, calendarDateInTimeZone } from "@/lib/invoices/domain";
import { zonedWallTimeToUtc } from "@/lib/scheduling/availability";
import type { DateRangeInput, ResolvedDateRange } from "./types";

/**
 * Organization-calendar date ranges for Analytics. Every boundary is a local
 * midnight in the organization's own timezone, found by calendar-date
 * arithmetic on plain YYYY-MM-DD strings and converted to a UTC instant with
 * zonedWallTimeToUtc - never by adding or subtracting elapsed milliseconds -
 * so a spring-forward day is 23 hours, a fall-back day 25, and a "day" always
 * means the organization's calendar day.
 *
 * Only callers that pass an organization timezone get these ranges (see
 * resolveDateRange in ./queries.ts); every other caller keeps the original
 * server-calendar behavior unchanged.
 */

/** An unknown or empty zone falls back to UTC rather than throwing. */
export function safeTimeZone(timeZone: string): string {
  if (!timeZone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

/** The UTC instant (ISO) of local midnight on calendar date `date` (YYYY-MM-DD) in `timeZone`. */
export function localMidnightIso(date: string, timeZone: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return zonedWallTimeToUtc(year, month, day, 0, timeZone).toISOString();
}

/** YYYY-MM-01 of the month containing `date`, shifted by `months` (negative = earlier). */
export function monthStart(date: string, months = 0): string {
  const [year, month] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + months, 1));
  return shifted.toISOString().slice(0, 10);
}

function dayOfMonth(date: string): number {
  return Number(date.split("-")[2]);
}

function range(label: string, fromDate: string, toDate: string, timeZone: string): ResolvedDateRange {
  return { label, from: localMidnightIso(fromDate, timeZone), to: localMidnightIso(toDate, timeZone) };
}

/**
 * The organization-calendar equivalent of resolveDateRange's presets, with
 * the same labels and the same half-open [from, to) shape:
 *   today        [today, tomorrow)
 *   last7Days    [today - 6, tomorrow)
 *   last30Days   [today - 29, tomorrow)
 *   currentMonth [1st of this month, 1st of next month)
 *   previousMonth[1st of last month, 1st of this month)
 * allTime and custom ranges are returned exactly as resolveDateRange does.
 */
export function resolveOrganizationDateRange(input: DateRangeInput, now: Date, timeZone: string): ResolvedDateRange {
  if (typeof input === "object" && input !== null) return { label: "custom", from: input.from, to: input.to };
  const zone = safeTimeZone(timeZone);
  const today = calendarDateInTimeZone(now, zone);
  const tomorrow = addDaysToCalendarDate(today, 1);

  switch (input) {
    case "today":
      return range("today", today, tomorrow, zone);
    case "last7Days":
      return range("last 7 days", addDaysToCalendarDate(today, -6), tomorrow, zone);
    case "last30Days":
      return range("last 30 days", addDaysToCalendarDate(today, -29), tomorrow, zone);
    case "currentMonth":
      return range("current month", monthStart(today), monthStart(today, 1), zone);
    case "previousMonth":
      return range("previous month", monthStart(today, -1), monthStart(today), zone);
    case "allTime":
    default:
      return { label: "all time", from: null, to: null };
  }
}

/**
 * The calendar-correct comparison period for an organization-calendar range:
 *   today         yesterday
 *   last7Days     the 7 organization days before the current 7
 *   last30Days    the 30 organization days before the current 30
 *   previousMonth the calendar month before it
 *   currentMonth  month-to-date against the same elapsed calendar days of
 *                 last month (e.g. Oct 1-15 vs Sep 1-15), capped at last
 *                 month's length (Mar 1-31 vs all of February)
 * A custom range with both bounds keeps the same-length window before it; an
 * open-ended range (all time) has no comparison.
 */
export function previousOrganizationRange(input: DateRangeInput, current: ResolvedDateRange, now: Date, timeZone: string): ResolvedDateRange | null {
  if (!current.from || !current.to) return null;
  const label = `previous period (${current.label})`;
  if (typeof input === "object" && input !== null) {
    const fromMs = new Date(current.from).getTime();
    const length = new Date(current.to).getTime() - fromMs;
    return { label, from: new Date(fromMs - length).toISOString(), to: new Date(fromMs).toISOString() };
  }
  const zone = safeTimeZone(timeZone);
  const today = calendarDateInTimeZone(now, zone);

  switch (input) {
    case "today":
      return range(label, addDaysToCalendarDate(today, -1), today, zone);
    case "last7Days":
      return range(label, addDaysToCalendarDate(today, -13), addDaysToCalendarDate(today, -6), zone);
    case "last30Days":
      return range(label, addDaysToCalendarDate(today, -59), addDaysToCalendarDate(today, -29), zone);
    case "previousMonth":
      return range(label, monthStart(today, -2), monthStart(today, -1), zone);
    case "currentMonth": {
      const previousStart = monthStart(today, -1);
      const sameElapsedEnd = addDaysToCalendarDate(previousStart, dayOfMonth(today));
      const thisMonthStart = monthStart(today);
      return range(label, previousStart, sameElapsedEnd < thisMonthStart ? sameElapsedEnd : thisMonthStart, zone);
    }
    default:
      return null;
  }
}

/** Whole calendar days from `fromDate` to `toDate` (both YYYY-MM-DD) - DST-free, since no instants are involved. */
export function calendarDaysBetween(fromDate: string, toDate: string): number {
  const [fy, fm, fd] = fromDate.split("-").map(Number);
  const [ty, tm, td] = toDate.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

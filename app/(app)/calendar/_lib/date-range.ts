import { zonedWallTimeToUtc } from "@/lib/scheduling/availability";

/**
 * Pass 2 (Native Calendar System): pure day/week/month range math for the
 * calendar views. Deliberately timezone-safe throughout - every boundary is
 * computed via zonedWallTimeToUtc (the same DST-safe wall-clock -> UTC
 * conversion lib/scheduling/availability.ts and the appointment form
 * already use), never `new Date(dateString)` naive parsing, per this pass's
 * own "do not regress the server-local timezone bug" instruction. No I/O,
 * no wall-clock read (a `today` Date is always passed in) - fully
 * deterministic and unit-testable, matching this codebase's own
 * established pure/impure split (see availability.ts's own module
 * comment).
 */

export type CalendarView = "day" | "week" | "month";

export type DateParts = { year: number; month: number; day: number };

export function parseDateOnly(value: string): DateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

export function formatDateOnly(parts: DateParts): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

/** The organization-local calendar date a given instant falls on - never assumes UTC. Mirrors availability.ts's own localDateParts, intentionally duplicated (a few lines) rather than cross-imported, matching this codebase's established precedent for small pure day-math helpers. */
export function localDateParts(date: Date, timeZone: string): DateParts {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day") };
}

/** 0 = Sunday ... 6 = Saturday. Pure Y/M/D arithmetic rendered in UTC (never the org's own timeZone) so this is never affected by DST - a plain calendar date has one unambiguous weekday. */
function weekdayIndex(parts: DateParts): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(new Date(Date.UTC(parts.year, parts.month - 1, parts.day)));
  const order = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return order.indexOf(name);
}

/** Adds `days` (positive or negative) to a plain Y/M/D, via UTC-midnight arithmetic - never affected by DST since no timezone conversion is involved until the caller converts the result back to an instant. */
export function addDays(parts: DateParts, days: number): DateParts {
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + days * 86_400_000);
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

export type DateRange = { start: Date; end: Date };

/** [start of this org-local calendar day, start of the next). */
export function getDayRange(parts: DateParts, timeZone: string): DateRange {
  const start = zonedWallTimeToUtc(parts.year, parts.month, parts.day, 0, timeZone);
  const end = zonedWallTimeToUtc(...toArgs(addDays(parts, 1)), 0, timeZone);
  return { start, end };
}

/** [start of the Sunday on/before `parts`, start of the following Sunday) - a fixed 7-day window, matching this codebase's Sunday-first business_hours convention (business_hours.day_of_week enumerates Sunday..Saturday). */
export function getWeekRange(parts: DateParts, timeZone: string): DateRange {
  const weekStart = addDays(parts, -weekdayIndex(parts));
  const start = zonedWallTimeToUtc(...toArgs(weekStart), 0, timeZone);
  const end = zonedWallTimeToUtc(...toArgs(addDays(weekStart, 7)), 0, timeZone);
  return { start, end };
}

/** The first day of `parts`'s own calendar week (Sunday-first), as plain Y/M/D - the week view's own day columns are built by addDays(weekStart, 0..6). */
export function getWeekStart(parts: DateParts): DateParts {
  return addDays(parts, -weekdayIndex(parts));
}

export type MonthGrid = {
  /** [start of the month, start of the next month) - the actual calendar month being viewed. */
  monthRange: DateRange;
  /** [start of the padded 6-week grid, end) - always covers whole weeks before/after the month boundary, so a data fetch against this range never misses an appointment shown in a leading/trailing grid cell. */
  gridRange: DateRange;
  /** The 42 (6x7) plain calendar dates the month grid renders, Sunday-first, in order. */
  gridDays: DateParts[];
};

export function getMonthGrid(parts: DateParts, timeZone: string): MonthGrid {
  const monthStart: DateParts = { year: parts.year, month: parts.month, day: 1 };
  const nextMonthStart: DateParts = parts.month === 12 ? { year: parts.year + 1, month: 1, day: 1 } : { year: parts.year, month: parts.month + 1, day: 1 };

  const gridStart = addDays(monthStart, -weekdayIndex(monthStart));
  const gridDays: DateParts[] = [];
  for (let i = 0; i < 42; i++) gridDays.push(addDays(gridStart, i));
  const gridEnd = addDays(gridStart, 42);

  return {
    monthRange: { start: zonedWallTimeToUtc(...toArgs(monthStart), 0, timeZone), end: zonedWallTimeToUtc(...toArgs(nextMonthStart), 0, timeZone) },
    gridRange: { start: zonedWallTimeToUtc(...toArgs(gridStart), 0, timeZone), end: zonedWallTimeToUtc(...toArgs(gridEnd), 0, timeZone) },
    gridDays,
  };
}

function toArgs(parts: DateParts): [number, number, number] {
  return [parts.year, parts.month, parts.day];
}

/** Navigates `parts` one unit of `view` forward (positive) or backward (negative). Week/day step by 7/1 calendar days; month steps by calendar month (not a fixed 30 days), matching ordinary calendar navigation. */
export function navigateDate(parts: DateParts, view: CalendarView, direction: 1 | -1): DateParts {
  if (view === "day") return addDays(parts, direction);
  if (view === "week") return addDays(parts, direction * 7);
  const month = parts.month + direction;
  if (month < 1) return { year: parts.year - 1, month: 12, day: parts.day };
  if (month > 12) return { year: parts.year + 1, month: 1, day: parts.day };
  return { year: parts.year, month, day: parts.day };
}

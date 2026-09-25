/**
 * Pass 2 (Native Calendar System): pure unit tests for the calendar's
 * date-range math (app/(app)/calendar/_lib/date-range.ts) - no I/O, no
 * Supabase, matching this codebase's own established convention for
 * testing deterministic pure logic in isolation (see
 * lib/scheduling/availability.test.ts's own precedent, which this file's
 * DST test case deliberately mirrors).
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/(app)/calendar/_lib/date-range.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  parseDateOnly,
  formatDateOnly,
  addDays,
  getDayRange,
  getWeekRange,
  getWeekStart,
  getMonthGrid,
  navigateDate,
}: typeof import("./date-range") = require("./date-range.ts");

test("parseDateOnly: a valid YYYY-MM-DD string parses correctly", () => {
  assert.deepEqual(parseDateOnly("2027-03-01"), { year: 2027, month: 3, day: 1 });
});

test("parseDateOnly: malformed or out-of-range input returns null, never a guess", () => {
  for (const value of ["2027-3-1", "not-a-date", "2027-13-01", "2027-01-32", ""]) {
    assert.equal(parseDateOnly(value), null, `expected "${value}" to be rejected`);
  }
});

test("formatDateOnly: round-trips through parseDateOnly", () => {
  const parts = parseDateOnly("2027-03-01")!;
  assert.equal(formatDateOnly(parts), "2027-03-01");
});

test("addDays: adds and subtracts across a month boundary", () => {
  assert.deepEqual(addDays({ year: 2027, month: 1, day: 31 }, 1), { year: 2027, month: 2, day: 1 });
  assert.deepEqual(addDays({ year: 2027, month: 2, day: 1 }, -1), { year: 2027, month: 1, day: 31 });
});

test("addDays: adds and subtracts across a year boundary", () => {
  assert.deepEqual(addDays({ year: 2026, month: 12, day: 31 }, 1), { year: 2027, month: 1, day: 1 });
  assert.deepEqual(addDays({ year: 2027, month: 1, day: 1 }, -1), { year: 2026, month: 12, day: 31 });
});

test("getDayRange: UTC organization - a 24-hour window starting at local midnight", () => {
  const range = getDayRange({ year: 2027, month: 3, day: 1 }, "UTC");
  assert.equal(range.start.toISOString(), "2027-03-01T00:00:00.000Z");
  assert.equal(range.end.toISOString(), "2027-03-02T00:00:00.000Z");
});

test("getDayRange: America/Denver (Mountain Time) - local midnight is NOT UTC midnight", () => {
  // 2027-03-01 is well before the March DST change - Denver is MST (UTC-7).
  const range = getDayRange({ year: 2027, month: 3, day: 1 }, "America/Denver");
  assert.equal(range.start.toISOString(), "2027-03-01T07:00:00.000Z");
  assert.equal(range.end.toISOString(), "2027-03-02T07:00:00.000Z");
});

test("getDayRange: DST fall-back boundary - the calendar day spans the actual 25-hour clock day correctly", () => {
  // 2026-11-01 is the real America/Denver fall-back date (MDT -> MST at
  // 2am local) - midnight on the transition day itself is still MDT
  // (UTC-6), since the clocks haven't rolled back yet at that instant; the
  // NEXT calendar day's midnight is fully into MST (UTC-7). This is what
  // proves the conversion re-derives the offset per boundary, not a fixed
  // one - two consecutive local midnights map to a different UTC offset.
  const fallbackDay = getDayRange({ year: 2026, month: 11, day: 1 }, "America/Denver");
  const dayAfter = getDayRange({ year: 2026, month: 11, day: 2 }, "America/Denver");
  assert.equal(fallbackDay.start.toISOString(), "2026-11-01T06:00:00.000Z");
  assert.equal(dayAfter.start.toISOString(), "2026-11-02T07:00:00.000Z");
});

test("getWeekStart: Sunday-first - a Wednesday resolves back to that week's Sunday", () => {
  // 2027-03-03 is a Wednesday (2027-03-01 is a Monday, per this codebase's own established fixture comment elsewhere).
  assert.deepEqual(getWeekStart({ year: 2027, month: 3, day: 3 }), { year: 2027, month: 2, day: 28 });
});

test("getWeekStart: a Sunday resolves to itself", () => {
  assert.deepEqual(getWeekStart({ year: 2027, month: 2, day: 28 }), { year: 2027, month: 2, day: 28 });
});

test("getWeekRange: exactly a 7-day window in UTC", () => {
  const range = getWeekRange({ year: 2027, month: 3, day: 3 }, "UTC");
  assert.equal(range.start.toISOString(), "2027-02-28T00:00:00.000Z");
  assert.equal(range.end.toISOString(), "2027-03-07T00:00:00.000Z");
  assert.equal((range.end.getTime() - range.start.getTime()) / 86_400_000, 7);
});

test("getMonthGrid: always exactly 42 (6x7) days, Sunday-first, covering the whole requested month", () => {
  const grid = getMonthGrid({ year: 2027, month: 3, day: 15 }, "UTC");
  assert.equal(grid.gridDays.length, 42);
  // March 2027's 1st is a Monday, so the grid's leading padding is exactly one day (Feb 28).
  assert.deepEqual(grid.gridDays[0], { year: 2027, month: 2, day: 28 });
  assert.ok(grid.gridDays.some((d) => d.year === 2027 && d.month === 3 && d.day === 1));
  assert.ok(grid.gridDays.some((d) => d.year === 2027 && d.month === 3 && d.day === 31));
  assert.equal(grid.monthRange.start.toISOString(), "2027-03-01T00:00:00.000Z");
  assert.equal(grid.monthRange.end.toISOString(), "2027-04-01T00:00:00.000Z");
});

test("getMonthGrid: the padded grid range fully contains the month range", () => {
  const grid = getMonthGrid({ year: 2027, month: 3, day: 1 }, "UTC");
  assert.ok(grid.gridRange.start.getTime() <= grid.monthRange.start.getTime());
  assert.ok(grid.gridRange.end.getTime() >= grid.monthRange.end.getTime());
});

test("navigateDate: day view steps by exactly one calendar day", () => {
  assert.deepEqual(navigateDate({ year: 2027, month: 3, day: 1 }, "day", 1), { year: 2027, month: 3, day: 2 });
  assert.deepEqual(navigateDate({ year: 2027, month: 3, day: 1 }, "day", -1), { year: 2027, month: 2, day: 28 });
});

test("navigateDate: week view steps by exactly seven calendar days", () => {
  assert.deepEqual(navigateDate({ year: 2027, month: 3, day: 1 }, "week", 1), { year: 2027, month: 3, day: 8 });
});

test("navigateDate: month view steps by calendar month, including year rollover", () => {
  assert.deepEqual(navigateDate({ year: 2027, month: 12, day: 15 }, "month", 1), { year: 2028, month: 1, day: 15 });
  assert.deepEqual(navigateDate({ year: 2027, month: 1, day: 15 }, "month", -1), { year: 2026, month: 12, day: 15 });
});

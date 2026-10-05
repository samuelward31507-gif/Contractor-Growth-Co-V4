/**
 * Relative-date scheduling context sent to n8n with every customer reply.
 * Pure - no network, no database. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/scheduling-date-context.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildSchedulingDateContext, SCHEDULING_CALENDAR_DAYS }: typeof import("./scheduling-date-context") = require("./scheduling-date-context.ts");

// Monday 2026-10-05, 03:31 in Denver (MDT, UTC-6).
const MONDAY_EARLY_UTC = new Date("2026-10-05T09:31:00.000Z");
const DENVER = "America/Denver";

const day = (ctx: ReturnType<typeof buildSchedulingDateContext>, date: string) => ctx.upcoming_days.find((d) => d.date === date)!;

test("today is the organization-local date, weekday and time - not the UTC date", () => {
  // 02:00Z Tuesday is still Monday evening in Denver.
  const ctx = buildSchedulingDateContext(new Date("2026-10-06T02:00:00.000Z"), DENVER);
  assert.equal(ctx.today, "2026-10-05");
  assert.equal(ctx.today_weekday, "Monday");
  assert.equal(ctx.local_time, "20:00");
  assert.equal(ctx.utc_offset, "-06:00");
  assert.equal(ctx.timezone, DENVER);
  assert.equal(ctx.now_iso, "2026-10-06T02:00:00.000Z");
});

test("each upcoming local day carries exact UTC bounds for the whole local day", () => {
  const ctx = buildSchedulingDateContext(MONDAY_EARLY_UTC, DENVER);
  assert.equal(ctx.upcoming_days.length, SCHEDULING_CALENDAR_DAYS);
  assert.deepEqual(ctx.upcoming_days[0], {
    date: "2026-10-05",
    weekday: "Monday",
    week: "this_week",
    utc_offset: "-06:00",
    start: "2026-10-05T06:00:00.000Z",
    end: "2026-10-06T05:59:59.999Z",
  });
});

test("'tomorrow', 'this Friday' and 'next Tuesday' resolve to unambiguous rows (Mon-Sun weeks)", () => {
  const ctx = buildSchedulingDateContext(MONDAY_EARLY_UTC, DENVER);
  // tomorrow
  assert.equal(ctx.upcoming_days[1]!.date, "2026-10-06");
  assert.equal(ctx.upcoming_days[1]!.weekday, "Tuesday");
  // this Friday
  const thisFriday = ctx.upcoming_days.find((d) => d.weekday === "Friday" && d.week === "this_week")!;
  assert.equal(thisFriday.date, "2026-10-09");
  // next Tuesday = Tuesday of next calendar week, not tomorrow
  const nextTuesday = ctx.upcoming_days.find((d) => d.weekday === "Tuesday" && d.week === "next_week")!;
  assert.equal(nextTuesday.date, "2026-10-13");
  assert.equal(nextTuesday.start, "2026-10-13T06:00:00.000Z");
  assert.equal(nextTuesday.end, "2026-10-14T05:59:59.999Z");
});

test("'next week' is next Monday 00:00 through Sunday 23:59:59.999 local", () => {
  const ctx = buildSchedulingDateContext(MONDAY_EARLY_UTC, DENVER);
  assert.deepEqual(ctx.next_week, { start: "2026-10-12T06:00:00.000Z", end: "2026-10-19T05:59:59.999Z" });
  assert.deepEqual(ctx.this_week, { start: "2026-10-05T06:00:00.000Z", end: "2026-10-12T05:59:59.999Z" });
  assert.equal(day(ctx, "2026-10-18").week, "next_week");
  assert.equal(day(ctx, "2026-10-12").week, "next_week");
  assert.equal(day(ctx, "2026-10-11").week, "this_week");
});

test("on a Sunday, 'next week' starts tomorrow and the calendar still covers all of it", () => {
  const ctx = buildSchedulingDateContext(new Date("2026-10-11T18:00:00.000Z"), DENVER);
  assert.equal(ctx.today_weekday, "Sunday");
  assert.equal(ctx.upcoming_days[0]!.week, "this_week");
  assert.equal(ctx.upcoming_days[1]!.week, "next_week");
  assert.equal(ctx.next_week.start, ctx.upcoming_days[1]!.start);
  assert.equal(ctx.next_week.end, ctx.upcoming_days[7]!.end);
});

test("DST: each day keeps its own offset and a 23-hour day across the fall-back change", () => {
  // US DST ends Sunday 2026-11-01.
  const ctx = buildSchedulingDateContext(new Date("2026-10-30T18:00:00.000Z"), DENVER);
  const before = day(ctx, "2026-10-31");
  const changeDay = day(ctx, "2026-11-01");
  const after = day(ctx, "2026-11-02");
  assert.equal(before.utc_offset, "-06:00");
  assert.equal(after.utc_offset, "-07:00");
  assert.equal(changeDay.start, "2026-11-01T06:00:00.000Z");
  assert.equal(changeDay.end, "2026-11-02T06:59:59.999Z");
  assert.equal(after.start, "2026-11-02T07:00:00.000Z");
});

test("month/year rollover and an unknown timezone falling back to UTC", () => {
  const ctx = buildSchedulingDateContext(new Date("2026-12-30T12:00:00.000Z"), "Not/AZone");
  assert.equal(ctx.timezone, "UTC");
  assert.equal(ctx.upcoming_days[2]!.date, "2027-01-01");
  assert.equal(ctx.upcoming_days[2]!.start, "2027-01-01T00:00:00.000Z");
  assert.equal(buildSchedulingDateContext(MONDAY_EARLY_UTC, null).timezone, "UTC");
});

test("the customer-reply contract sends the scheduling context in the organization's timezone", () => {
  const source = readFileSync(path.join(process.cwd(), "lib/automation/customer-reply.ts"), "utf8");
  assert.match(source, /scheduling: buildSchedulingDateContext\(new Date\(\), businessProfile\?\.timezone \?\? "UTC"\)/);
});

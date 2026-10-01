/**
 * Phase 2A: organization-calendar date ranges for Analytics (./date-range.ts)
 * and resolveDateRange's opt-in timezone. Denver (MDT = UTC-6, MST = UTC-7)
 * around a UTC/Denver day split, both 2026 DST transitions, month
 * boundaries, calendar-correct previous periods, and the unchanged
 * no-timezone behavior every other caller relies on.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/bi/date-range.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const dr: typeof import("./date-range") = require(path.join(process.cwd(), "lib/bi/date-range.ts"));
const { resolveDateRange }: typeof import("./queries") = require(path.join(process.cwd(), "lib/bi/queries.ts"));

const DENVER = "America/Denver";
const HOUR = 3_600_000;
const span = (r: { from: string | null; to: string | null }) => [r.from, r.to];
const hours = (r: { from: string | null; to: string | null }) => (new Date(r.to!).getTime() - new Date(r.from!).getTime()) / HOUR;
const z = (s: string) => `${s}.000Z`;

// 2026-10-01T05:30Z is 23:30 MDT on Sep 30 in Denver - already Oct 1 in UTC.
const DENVER_2330 = new Date("2026-10-01T05:30:00Z");

test("Denver at 23:30 MDT: every preset uses Denver's Sep 30, not UTC's Oct 1", () => {
  assert.deepEqual(span(resolveDateRange("today", DENVER_2330, DENVER)), [z("2026-09-30T06:00:00"), z("2026-10-01T06:00:00")]);
  assert.deepEqual(span(resolveDateRange("last7Days", DENVER_2330, DENVER)), [z("2026-09-24T06:00:00"), z("2026-10-01T06:00:00")]);
  assert.deepEqual(span(resolveDateRange("last30Days", DENVER_2330, DENVER)), [z("2026-09-01T06:00:00"), z("2026-10-01T06:00:00")]);
  assert.deepEqual(span(resolveDateRange("currentMonth", DENVER_2330, DENVER)), [z("2026-09-01T06:00:00"), z("2026-10-01T06:00:00")]);
  assert.deepEqual(span(resolveDateRange("previousMonth", DENVER_2330, DENVER)), [z("2026-08-01T06:00:00"), z("2026-09-01T06:00:00")]);
  assert.deepEqual(resolveDateRange("allTime", DENVER_2330, DENVER), { label: "all time", from: null, to: null });
});

test("labels match the original presets, so scope tags and comparisons read the same", () => {
  for (const [preset, label] of [["today", "today"], ["last7Days", "last 7 days"], ["last30Days", "last 30 days"], ["currentMonth", "current month"], ["previousMonth", "previous month"]] as const) {
    assert.equal(resolveDateRange(preset, DENVER_2330, DENVER).label, label);
    assert.equal(resolveDateRange(preset, DENVER_2330).label, label);
  }
});

test("the UTC/Denver midnight boundary is exact: 05:59:59.999Z is still Sep 30, 06:00Z opens Oct 1", () => {
  assert.deepEqual(span(resolveDateRange("today", new Date("2026-10-01T05:59:59.999Z"), DENVER)), [z("2026-09-30T06:00:00"), z("2026-10-01T06:00:00")]);
  assert.deepEqual(span(resolveDateRange("today", new Date("2026-10-01T06:00:00Z"), DENVER)), [z("2026-10-01T06:00:00"), z("2026-10-02T06:00:00")]);
});

test("month boundaries: the last minute of September is September; Oct 1 local midnight starts October", () => {
  assert.deepEqual(span(resolveDateRange("currentMonth", DENVER_2330, DENVER)), [z("2026-09-01T06:00:00"), z("2026-10-01T06:00:00")]);
  const octFirst = new Date("2026-10-01T06:00:00Z");
  assert.deepEqual(span(resolveDateRange("currentMonth", octFirst, DENVER)), [z("2026-10-01T06:00:00"), z("2026-11-01T06:00:00")]);
  assert.deepEqual(span(resolveDateRange("previousMonth", octFirst, DENVER)), [z("2026-09-01T06:00:00"), z("2026-10-01T06:00:00")]);
  assert.deepEqual(span(resolveDateRange("previousMonth", new Date("2026-01-15T18:00:00Z"), DENVER)), [z("2025-12-01T07:00:00"), z("2026-01-01T07:00:00")], "year boundary");
});

test("DST spring-forward (2026-03-08): the day is 23 hours and a 7-day window containing it is 167", () => {
  const day = resolveDateRange("today", new Date("2026-03-08T18:00:00Z"), DENVER);
  assert.deepEqual(span(day), [z("2026-03-08T07:00:00"), z("2026-03-09T06:00:00")]);
  assert.equal(hours(day), 23);
  const week = resolveDateRange("last7Days", new Date("2026-03-10T18:00:00Z"), DENVER);
  assert.deepEqual(span(week), [z("2026-03-04T07:00:00"), z("2026-03-11T06:00:00")]);
  assert.equal(hours(week), 167);
});

test("DST fall-back (2026-11-01): the day is 25 hours and a 7-day window containing it is 169", () => {
  const day = resolveDateRange("today", new Date("2026-11-01T18:00:00Z"), DENVER);
  assert.deepEqual(span(day), [z("2026-11-01T06:00:00"), z("2026-11-02T07:00:00")]);
  assert.equal(hours(day), 25);
  const week = resolveDateRange("last7Days", new Date("2026-11-03T18:00:00Z"), DENVER);
  assert.deepEqual(span(week), [z("2026-10-28T06:00:00"), z("2026-11-04T07:00:00")]);
  assert.equal(hours(week), 169);
});

test("previous periods are calendar periods, not elapsed-millisecond windows", () => {
  const prev = (preset: Parameters<typeof dr.previousOrganizationRange>[0], now: Date) => dr.previousOrganizationRange(preset, resolveDateRange(preset, now, DENVER), now, DENVER)!;
  // today -> yesterday, including a 23-hour yesterday.
  assert.deepEqual(span(prev("today", new Date("2026-03-09T18:00:00Z"))), [z("2026-03-08T07:00:00"), z("2026-03-09T06:00:00")]);
  assert.equal(hours(prev("today", new Date("2026-03-09T18:00:00Z"))), 23);
  // last 7 / 30 days -> the preceding 7 / 30 Denver days.
  assert.deepEqual(span(prev("last7Days", DENVER_2330)), [z("2026-09-17T06:00:00"), z("2026-09-24T06:00:00")]);
  assert.deepEqual(span(prev("last30Days", DENVER_2330)), [z("2026-08-02T06:00:00"), z("2026-09-01T06:00:00")]);
  // A 7-day previous window across fall-back is 169 hours, not a shifted 168.
  assert.equal(hours(prev("last7Days", new Date("2026-11-10T18:00:00Z"))), 169);
  // last month -> the calendar month before it.
  assert.deepEqual(span(prev("previousMonth", new Date("2026-10-15T18:00:00Z"))), [z("2026-08-01T06:00:00"), z("2026-09-01T06:00:00")]);
  // all time -> no comparison.
  assert.equal(dr.previousOrganizationRange("allTime", resolveDateRange("allTime", DENVER_2330, DENVER), DENVER_2330, DENVER), null);
});

test("this month compares month-to-date with the same elapsed days of last month, capped at last month's length", () => {
  const prev = (now: Date) => dr.previousOrganizationRange("currentMonth", resolveDateRange("currentMonth", now, DENVER), now, DENVER)!;
  assert.deepEqual(span(prev(new Date("2026-10-15T18:00:00Z"))), [z("2026-09-01T06:00:00"), z("2026-09-16T06:00:00")], "Oct 1-15 vs Sep 1-15");
  assert.deepEqual(span(prev(new Date("2026-10-01T18:00:00Z"))), [z("2026-09-01T06:00:00"), z("2026-09-02T06:00:00")], "Oct 1 vs Sep 1");
  assert.deepEqual(span(prev(new Date("2026-03-10T18:00:00Z"))), [z("2026-02-01T07:00:00"), z("2026-02-11T07:00:00")], "Mar 1-10 vs Feb 1-10");
  assert.deepEqual(span(prev(new Date("2026-03-31T18:00:00Z"))), [z("2026-02-01T07:00:00"), z("2026-03-01T07:00:00")], "Mar 1-31 vs all of February");
});

test("custom ranges keep the same-length previous window; invalid zones fall back to UTC", () => {
  const custom = { from: "2026-09-10T00:00:00.000Z", to: "2026-09-20T00:00:00.000Z" };
  assert.deepEqual(span(dr.previousOrganizationRange(custom, resolveDateRange(custom, DENVER_2330, DENVER), DENVER_2330, DENVER)!), ["2026-08-31T00:00:00.000Z", "2026-09-10T00:00:00.000Z"]);
  assert.deepEqual(span(resolveDateRange("today", DENVER_2330, "Not/AZone")), [z("2026-10-01T00:00:00"), z("2026-10-02T00:00:00")]);
  assert.deepEqual(span(resolveDateRange("today", DENVER_2330, "")), [z("2026-10-01T00:00:00"), z("2026-10-02T00:00:00")]);
});

test("calendarDaysBetween counts calendar days, unaffected by DST", () => {
  assert.equal(dr.calendarDaysBetween("2026-03-07", "2026-03-09"), 2);
  assert.equal(dr.calendarDaysBetween("2026-10-31", "2026-11-02"), 2);
  assert.equal(dr.calendarDaysBetween("2026-09-30", "2026-09-30"), 0);
  assert.equal(dr.calendarDaysBetween("2026-10-01", "2026-09-30"), -1);
});

// The original server-calendar algorithm, copied verbatim as an oracle: with
// no timezone, resolveDateRange must still produce exactly this.
function legacy(input: string, now: Date) {
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  switch (input) {
    case "today": { const from = startOf(now); const to = new Date(from); to.setDate(to.getDate() + 1); return { label: "today", from: from.toISOString(), to: to.toISOString() }; }
    case "last7Days": { const to = startOf(now); to.setDate(to.getDate() + 1); const from = new Date(to); from.setDate(from.getDate() - 7); return { label: "last 7 days", from: from.toISOString(), to: to.toISOString() }; }
    case "last30Days": { const to = startOf(now); to.setDate(to.getDate() + 1); const from = new Date(to); from.setDate(from.getDate() - 30); return { label: "last 30 days", from: from.toISOString(), to: to.toISOString() }; }
    case "currentMonth": return { label: "current month", from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(), to: new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString() };
    case "previousMonth": return { label: "previous month", from: new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString(), to: new Date(now.getFullYear(), now.getMonth(), 1).toISOString() };
    default: return { label: "all time", from: null, to: null };
  }
}

test("no timezone: resolveDateRange is unchanged for every preset (agency, automation, dashboard callers)", () => {
  for (const now of [DENVER_2330, new Date("2026-03-08T18:00:00Z"), new Date("2026-11-01T08:30:00Z"), new Date("2026-01-01T00:00:00Z")]) {
    for (const preset of ["today", "last7Days", "last30Days", "currentMonth", "previousMonth", "allTime"] as const) {
      assert.deepEqual(resolveDateRange(preset, now), legacy(preset, now), `${preset} @ ${now.toISOString()}`);
    }
  }
  const custom = { from: "2026-01-01T00:00:00.000Z", to: null };
  assert.deepEqual(resolveDateRange(custom), { label: "custom", ...custom });
});

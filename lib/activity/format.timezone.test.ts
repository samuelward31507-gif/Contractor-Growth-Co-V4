/**
 * Phase 2A: the Activity timeline in the organization's timezone - day
 * headings, displayed times and date-filter bounds - and the unchanged
 * server-local behavior when no timezone is passed.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/activity/format.timezone.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { getActivityDayLabel, formatActivityTime }: typeof import("./format") = require(path.join(process.cwd(), "lib/activity/format.ts"));
const { activityFilterBounds }: typeof import("./queries") = require(path.join(process.cwd(), "lib/activity/queries.ts"));

const DENVER = "America/Denver";
// 23:30 MDT on Sep 30 in Denver - already Oct 1 in UTC.
const NOW = new Date("2026-10-01T05:30:00Z");

test("day headings use Denver calendar days: an entry at 19:00 MDT is Today, not Yesterday", () => {
  assert.equal(getActivityDayLabel("2026-10-01T01:00:00Z", NOW, DENVER), "Today", "19:00 MDT Sep 30");
  assert.equal(getActivityDayLabel("2026-09-30T06:00:00Z", NOW, DENVER), "Today", "00:00 MDT Sep 30");
  assert.equal(getActivityDayLabel("2026-09-30T05:59:00Z", NOW, DENVER), "Yesterday", "23:59 MDT Sep 29");
  assert.equal(getActivityDayLabel("2026-09-28T18:00:00Z", NOW, DENVER), "Monday, September 28");
  // An older entry late in the Denver evening is headed with its Denver date, not the next UTC date.
  assert.equal(getActivityDayLabel("2026-09-27T04:00:00Z", NOW, DENVER), "Saturday, September 26");
});

test("day headings across DST: 23:30 MST on Nov 1 is still Nov 1 in Denver", () => {
  const now = new Date("2026-11-02T06:30:00Z"); // 23:30 MST Nov 1
  assert.equal(getActivityDayLabel("2026-11-01T06:00:00Z", now, DENVER), "Today", "00:00 MDT Nov 1");
  assert.equal(getActivityDayLabel("2026-11-01T05:59:00Z", now, DENVER), "Yesterday", "23:59 MDT Oct 31");
});

test("displayed times are Denver wall-clock times", () => {
  assert.equal(formatActivityTime("2026-10-01T05:31:00Z", DENVER), "11:31 PM");
  assert.equal(formatActivityTime("2026-03-08T10:00:00Z", DENVER), "4:00 AM", "after spring-forward (MDT)");
  assert.equal(formatActivityTime("2026-03-08T08:00:00Z", DENVER), "1:00 AM", "before spring-forward (MST)");
  assert.equal(formatActivityTime("2026-10-01T05:31:00Z", "Not/AZone"), "5:31 AM", "an invalid zone falls back to UTC");
});

test("date filters select [local midnight of from, local midnight after to) in Denver - no 23:59:59.999 gap", () => {
  assert.deepEqual(activityFilterBounds({ from: "2026-09-30", to: "2026-09-30" }, DENVER), { gte: "2026-09-30T06:00:00.000Z", lt: "2026-10-01T06:00:00.000Z" });
  assert.deepEqual(activityFilterBounds({ from: "2026-09-01" }, DENVER), { gte: "2026-09-01T06:00:00.000Z" });
  assert.deepEqual(activityFilterBounds({ to: "2026-09-30" }, DENVER), { lt: "2026-10-01T06:00:00.000Z" });
  assert.deepEqual(activityFilterBounds({}, DENVER), {});
});

test("date filters across DST: the spring-forward day is 23 hours, the fall-back day 25", () => {
  const spring = activityFilterBounds({ from: "2026-03-08", to: "2026-03-08" }, DENVER);
  assert.deepEqual(spring, { gte: "2026-03-08T07:00:00.000Z", lt: "2026-03-09T06:00:00.000Z" });
  const fall = activityFilterBounds({ from: "2026-11-01", to: "2026-11-01" }, DENVER);
  assert.deepEqual(fall, { gte: "2026-11-01T06:00:00.000Z", lt: "2026-11-02T07:00:00.000Z" });
});

test("no timezone: the original server-local headings, times and inclusive 23:59:59.999 filter bound", () => {
  const now = new Date(2026, 8, 30, 12, 0);
  assert.equal(getActivityDayLabel(new Date(2026, 8, 30, 8, 0).toISOString(), now), "Today");
  assert.equal(getActivityDayLabel(new Date(2026, 8, 29, 8, 0).toISOString(), now), "Yesterday");
  assert.equal(formatActivityTime(new Date(2026, 8, 30, 15, 5).toISOString()), "3:05 PM");
  assert.deepEqual(activityFilterBounds({ from: "2026-09-30", to: "2026-09-30" }), {
    gte: new Date("2026-09-30T00:00:00").toISOString(),
    lte: new Date("2026-09-30T23:59:59.999").toISOString(),
  });
});

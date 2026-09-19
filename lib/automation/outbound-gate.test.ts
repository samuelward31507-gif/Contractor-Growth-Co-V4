/**
 * Unit tests for isWithinBusinessHours() - the pure decision behind the
 * Automation Configuration V2.2 business-hours check inside
 * evaluateOutboundGate(). This file transitively imports several
 * "@/"-aliased modules, so it needs the same resolution bridge as
 * retry.test.ts - see lib/automation/test-loader.mjs. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/outbound-gate.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { BusinessHour } from "@/lib/settings/queries";

const require = createRequire(import.meta.url);
const { isWithinBusinessHours }: typeof import("./outbound-gate") = require("./outbound-gate.ts");

const MON_FRI_9_5: BusinessHour[] = [
  { day_of_week: "monday", is_open: true, open_time: "09:00:00", close_time: "17:00:00" },
  { day_of_week: "tuesday", is_open: true, open_time: "09:00:00", close_time: "17:00:00" },
  { day_of_week: "wednesday", is_open: true, open_time: "09:00:00", close_time: "17:00:00" },
  { day_of_week: "thursday", is_open: true, open_time: "09:00:00", close_time: "17:00:00" },
  { day_of_week: "friday", is_open: true, open_time: "09:00:00", close_time: "17:00:00" },
  { day_of_week: "saturday", is_open: false, open_time: null, close_time: null },
  { day_of_week: "sunday", is_open: false, open_time: null, close_time: null },
];

// 2026-09-21 is a Monday.
const MONDAY_NOON_UTC = new Date("2026-09-21T12:00:00.000Z");

test("no business hours configured at all (empty array) always allows - requirement 6", () => {
  assert.equal(isWithinBusinessHours(MONDAY_NOON_UTC, "UTC", []), true);
  // Even at 3am, with no configuration at all, this must never block.
  assert.equal(isWithinBusinessHours(new Date("2026-09-21T03:00:00.000Z"), "UTC", []), true);
});

test("a time inside configured hours is allowed", () => {
  // Monday noon UTC is Monday noon in UTC - well within 9-5.
  assert.equal(isWithinBusinessHours(MONDAY_NOON_UTC, "UTC", MON_FRI_9_5), true);
});

test("a time outside configured hours (but on an open day) is blocked", () => {
  const mondayEarlyMorning = new Date("2026-09-21T03:00:00.000Z"); // 3am UTC, before 9am open
  assert.equal(isWithinBusinessHours(mondayEarlyMorning, "UTC", MON_FRI_9_5), false);

  const mondayLateNight = new Date("2026-09-21T20:00:00.000Z"); // 8pm UTC, after 5pm close
  assert.equal(isWithinBusinessHours(mondayLateNight, "UTC", MON_FRI_9_5), false);
});

test("a day explicitly marked closed (is_open: false) is blocked, even though hours ARE configured for the week", () => {
  const saturdayNoon = new Date("2026-09-19T12:00:00.000Z"); // 2026-09-19 is a Saturday
  assert.equal(isWithinBusinessHours(saturdayNoon, "UTC", MON_FRI_9_5), false);
});

test("a day with no saved row at all is treated as closed - configuring Mon-Fri implicitly closes the rest of the week", () => {
  const mondayOnly: BusinessHour[] = [{ day_of_week: "monday", is_open: true, open_time: "09:00:00", close_time: "17:00:00" }];
  const tuesdayNoon = new Date("2026-09-22T12:00:00.000Z"); // Tuesday, no row present
  assert.equal(isWithinBusinessHours(tuesdayNoon, "UTC", mondayOnly), false);
});

test("timezone handling: the same UTC instant is inside hours in one timezone and outside hours in another", () => {
  // 2026-09-21T12:00:00Z is 2026-09-21 08:00 in America/New_York (UTC-4 in
  // September, DST) - before the 9am open there - but 2026-09-21 12:00 UTC
  // itself is within a UTC-configured 9-5 window.
  assert.equal(isWithinBusinessHours(MONDAY_NOON_UTC, "UTC", MON_FRI_9_5), true);
  assert.equal(isWithinBusinessHours(MONDAY_NOON_UTC, "America/New_York", MON_FRI_9_5), false);
});

test("boundary: exactly at open_time is allowed (inclusive lower bound)", () => {
  const exactlyOpen = new Date("2026-09-21T09:00:00.000Z");
  assert.equal(isWithinBusinessHours(exactlyOpen, "UTC", MON_FRI_9_5), true);
});

test("boundary: exactly at close_time is blocked (exclusive upper bound)", () => {
  const exactlyClose = new Date("2026-09-21T17:00:00.000Z");
  assert.equal(isWithinBusinessHours(exactlyClose, "UTC", MON_FRI_9_5), false);
});

test("boundary: one minute before close is allowed, one minute after open is allowed", () => {
  assert.equal(isWithinBusinessHours(new Date("2026-09-21T16:59:00.000Z"), "UTC", MON_FRI_9_5), true);
  assert.equal(isWithinBusinessHours(new Date("2026-09-21T09:01:00.000Z"), "UTC", MON_FRI_9_5), true);
});

// Overnight/wraparound hours (e.g. open 22:00, close 02:00) are not
// supported by the existing business-hours model at all -
// app/(app)/settings/actions.ts's updateBusinessHours explicitly rejects
// close_time <= open_time at save time ("closing time must be after its
// opening time"), so no organization can ever save such a row. This
// function is therefore intentionally a same-calendar-day comparison only,
// with no wraparound logic - there is nothing to test here that the
// existing model can produce.
test("a time-string with seconds (Postgres's own time-column serialization, e.g. '09:00:00') parses identically to a plain 'HH:MM' string", () => {
  const hoursWithSeconds: BusinessHour[] = [{ day_of_week: "monday", is_open: true, open_time: "09:00:00", close_time: "17:00:00" }];
  const hoursWithoutSeconds: BusinessHour[] = [{ day_of_week: "monday", is_open: true, open_time: "09:00", close_time: "17:00" }];

  assert.equal(isWithinBusinessHours(MONDAY_NOON_UTC, "UTC", hoursWithSeconds), true);
  assert.equal(isWithinBusinessHours(MONDAY_NOON_UTC, "UTC", hoursWithoutSeconds), true);
});

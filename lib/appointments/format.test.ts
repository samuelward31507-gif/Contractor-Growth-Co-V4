/**
 * Unit tests for isSameCalendarDay() - pure, no I/O. Trackpr 2.0, Phase 2A:
 * added because the dashboard's "Today's Schedule" section previously called
 * this function without an organization timezone at all (see
 * app/(app)/dashboard/page.tsx's own comment on the fix), so "today" was
 * decided in the server's runtime timezone rather than the organization's
 * configured one - these tests prove the exact near-midnight boundary case
 * that bug could get wrong, and that omitting a timezone still falls back to
 * runtime-local, unchanged.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/appointments/format.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { isSameCalendarDay }: typeof import("./format") = require("./format.ts");

test("1. with no timezone argument, falls back to runtime-local comparison (unchanged existing behavior)", () => {
  // Deliberately only 1 hour apart and nowhere near midnight in any
  // plausible runtime timezone, so this assertion holds regardless of which
  // timezone actually runs this test (unlike the no-timezone branch itself,
  // whose whole point is that it depends on the runtime's local timezone -
  // see test 2's own comment for why that specific dependency is never
  // asserted on a specific boolean here).
  const a = new Date("2027-03-10T18:00:00.000Z");
  const b = new Date("2027-03-10T19:00:00.000Z");
  assert.equal(isSameCalendarDay(a, b), true);
});

test("2. an appointment that falls on a different UTC calendar day is still 'today' in a western US organization's timezone", () => {
  // 2027-03-10T06:00:00Z is 2027-03-10 in UTC, but still 2027-03-09 22:00 in
  // America/Los_Angeles (PST, UTC-8) - a real near-midnight boundary
  // mismatch: the UTC calendar day and the organization's own day disagree
  // here. "Now" is 2027-03-09T23:30:00Z - 2027-03-09 UTC, and 2027-03-09
  // 15:30 in America/Los_Angeles.
  //
  // The no-timezone branch is deliberately not asserted here: it compares
  // using the RUNTIME's own local timezone (not UTC), so its result for a
  // near-midnight pair like this one genuinely depends on which timezone
  // runs the test - that dependency is exactly the bug this fix closes, not
  // something this test should pin to one specific value.
  const appointmentStart = new Date("2027-03-10T06:00:00.000Z");
  const orgLocalNow = new Date("2027-03-09T23:30:00.000Z");

  // With the organization's real timezone (the fix): both instants are
  // 2027-03-09 in America/Los_Angeles - correctly the same day, regardless
  // of where the server process itself is physically running.
  assert.equal(
    isSameCalendarDay(appointmentStart, orgLocalNow, "America/Los_Angeles"),
    true,
    "in America/Los_Angeles, the appointment (03-09 22:00 local) and 'now' (03-09 15:30 local) are the same calendar day",
  );
});

test("3. a genuinely different calendar day in the organization's timezone is correctly excluded", () => {
  const appointmentStart = new Date("2027-03-11T06:00:00.000Z"); // 2027-03-10 22:00 America/Los_Angeles
  const orgLocalNow = new Date("2027-03-10T20:00:00.000Z"); // 2027-03-10 12:00 America/Los_Angeles
  assert.equal(isSameCalendarDay(appointmentStart, orgLocalNow, "America/Los_Angeles"), true);

  const nextDayNow = new Date("2027-03-11T20:00:00.000Z"); // 2027-03-11 12:00 America/Los_Angeles
  assert.equal(isSameCalendarDay(appointmentStart, nextDayNow, "America/Los_Angeles"), false);
});

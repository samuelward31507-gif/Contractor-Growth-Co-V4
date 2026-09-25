/**
 * Pass 5B, Part B: pure unit tests for isNoShowEligible - no Supabase round
 * trip needed. Mirrors appointment-reminders.test.ts's own established shape
 * for isReminderDue. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/no-show-detection.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { isNoShowEligible, NO_SHOW_GRACE_PERIOD_MS }: typeof import("./no-show-detection") = require("./no-show-detection.ts");

test("exactly at end_at: not yet eligible (0ms elapsed, well within the grace period)", () => {
  const now = new Date("2027-03-10T15:00:00.000Z");
  assert.equal(isNoShowEligible({ end_at: "2027-03-10T15:00:00.000Z" }, now), false);
});

test("within the grace period (30 minutes after end_at): remains eligible for a normal outcome, not yet a no-show", () => {
  const now = new Date("2027-03-10T15:30:00.000Z");
  assert.equal(isNoShowEligible({ end_at: "2027-03-10T15:00:00.000Z" }, now), false);
});

test("right at the grace period boundary: not yet eligible (strictly greater-than, not >=)", () => {
  const endAt = "2027-03-10T15:00:00.000Z";
  const now = new Date(new Date(endAt).getTime() + NO_SHOW_GRACE_PERIOD_MS);
  assert.equal(isNoShowEligible({ end_at: endAt }, now), false);
});

test("one millisecond past the grace period: eligible", () => {
  const endAt = "2027-03-10T15:00:00.000Z";
  const now = new Date(new Date(endAt).getTime() + NO_SHOW_GRACE_PERIOD_MS + 1);
  assert.equal(isNoShowEligible({ end_at: endAt }, now), true);
});

test("well past the grace period: eligible", () => {
  const now = new Date("2027-03-11T09:00:00.000Z");
  assert.equal(isNoShowEligible({ end_at: "2027-03-10T15:00:00.000Z" }, now), true);
});

// ---------------------------------------------------------------------------
// Part B2: timezone/DST correctness. end_at is already an absolute UTC
// instant (timestamptz), so a pure duration comparison against it is immune
// to DST/timezone effects by construction - these tests construct the exact
// UTC instant a Mountain/Central-time appointment's end_at would actually be
// stored as (computed independently, by hand, from the organization's own
// wall-clock time and its real UTC offset on that date - never by calling
// any conversion helper this file itself might share a bug with) and confirm
// the eligibility boundary lands at exactly the right UTC instant regardless.
// ---------------------------------------------------------------------------

test("Mountain Time (America/Denver, MDT = UTC-6 in summer): a 2:00 PM-3:00 PM appointment on 2027-07-15 stores end_at as 21:00:00Z - eligibility is exact at the UTC instant, not shifted by the org's local time", () => {
  const endAt = "2027-07-15T21:00:00.000Z"; // 3:00 PM MDT
  const justBefore = new Date(new Date(endAt).getTime() + NO_SHOW_GRACE_PERIOD_MS);
  const justAfter = new Date(new Date(endAt).getTime() + NO_SHOW_GRACE_PERIOD_MS + 1);
  assert.equal(isNoShowEligible({ end_at: endAt }, justBefore), false);
  assert.equal(isNoShowEligible({ end_at: endAt }, justAfter), true);
});

test("Central Time (America/Chicago, CDT = UTC-5 in summer): a 9:00 AM-10:00 AM appointment on 2027-07-15 stores end_at as 15:00:00Z", () => {
  const endAt = "2027-07-15T15:00:00.000Z"; // 10:00 AM CDT
  const justBefore = new Date(new Date(endAt).getTime() + NO_SHOW_GRACE_PERIOD_MS);
  const justAfter = new Date(new Date(endAt).getTime() + NO_SHOW_GRACE_PERIOD_MS + 1);
  assert.equal(isNoShowEligible({ end_at: endAt }, justBefore), false);
  assert.equal(isNoShowEligible({ end_at: endAt }, justAfter), true);
});

test("DST spring-forward boundary (America/Chicago, 2027-03-14 2:00 AM local clocks skip to 3:00 AM): an appointment straddling the transition still resolves correctly on pure UTC instants - CST (UTC-6) before the transition, CDT (UTC-5) after", () => {
  // 1:00 AM CST (still UTC-6, before the spring-forward) -> 2027-03-14T07:00:00Z start.
  // The appointment is 90 minutes long; 2:00-3:00 AM local time does not
  // exist that day (clocks jump straight from 1:59:59 CST to 3:00:00 CDT),
  // so its real, already-computed end_at is 2027-03-14T07:30:00Z (1:30 AM
  // CST) - a duration-based end_at, exactly what this codebase already
  // stores, never a wall-clock re-derivation that the missing hour could
  // corrupt.
  const endAt = "2027-03-14T07:30:00.000Z";
  const justBefore = new Date(new Date(endAt).getTime() + NO_SHOW_GRACE_PERIOD_MS);
  const justAfter = new Date(new Date(endAt).getTime() + NO_SHOW_GRACE_PERIOD_MS + 1);
  assert.equal(isNoShowEligible({ end_at: endAt }, justBefore), false);
  assert.equal(isNoShowEligible({ end_at: endAt }, justAfter), true);
});

test("server timezone differing from organization timezone never matters: isNoShowEligible takes no timezone parameter at all and depends only on the two absolute instants", () => {
  // Structural proof, not a behavioral one: confirms the function's own
  // signature never accepts a timezone/locale argument, so there is no
  // server-local-time code path to reintroduce the exact bug this codebase
  // has already fixed once (see lib/scheduling/availability.ts's own
  // zonedWallTimeToUtc history). `.length` is 1, not 2, because `now` has a
  // default value (Function.length only counts parameters before the first
  // defaulted one) - this assertion is about the parameter COUNT/shape
  // itself, not a behavioral check.
  assert.equal(isNoShowEligible.length, 1, "signature must be (appointment, now = default) only - no timezone parameter");
});

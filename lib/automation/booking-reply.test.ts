/**
 * Pass 1 (booking loop completion): pure unit tests for
 * classifyBookingReplyIntent and resolveSlotSelection - no Supabase, no
 * network, matching this codebase's own established convention for testing
 * deterministic classifiers in isolation (see
 * lib/reviews-referrals/tracking.test.ts's classifyReviewReplySentiment
 * precedent, and lib/automation/estimate-reply.ts's own classifier).
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/booking-reply.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { classifyBookingReplyIntent, resolveSlotSelection }: typeof import("./booking-reply") = require("./booking-reply.ts");

// 3 slots at 09:00 / 10:30 / 13:00 UTC on a fixed day - matches the org
// timezone "UTC" used throughout these pure tests (no DST ambiguity).
const SLOTS = [
  { start_at: "2027-03-01T09:00:00.000Z", end_at: "2027-03-01T10:00:00.000Z" },
  { start_at: "2027-03-01T10:30:00.000Z", end_at: "2027-03-01T11:30:00.000Z" },
  { start_at: "2027-03-01T13:00:00.000Z", end_at: "2027-03-01T14:00:00.000Z" },
];

test("classifyBookingReplyIntent: cancel phrases match 'cancel', never on the bare word alone", () => {
  for (const body of ["cancel my appointment", "please cancel my appointment", "I need to cancel", "cancel the appointment", "cancel my 2pm", "I can't make it", "I can't make my appointment", "won't be able to make it"]) {
    assert.equal(classifyBookingReplyIntent(body), "cancel", `expected "${body}" to classify as cancel`);
  }
  // The bare word alone is NEVER classified here - it's a real, unchanged
  // SMS STOP keyword (lib/messaging/keywords.ts), checked by the inbound
  // webhook before this classifier is ever reached. This module must never
  // independently treat it as anything.
  assert.equal(classifyBookingReplyIntent("cancel"), null);
  assert.equal(classifyBookingReplyIntent("Cancel"), null);
  assert.equal(classifyBookingReplyIntent("  cancel  "), null);
});

test("classifyBookingReplyIntent: reschedule phrases match 'reschedule'", () => {
  for (const body of ["Can I move my appointment?", "Can we do Friday instead?", "I need to reschedule.", "Can you move me to tomorrow afternoon?", "can we change my appointment"]) {
    assert.equal(classifyBookingReplyIntent(body), "reschedule", `expected "${body}" to classify as reschedule`);
  }
});

test("classifyBookingReplyIntent: unrelated conversation never matches either", () => {
  for (const body of ["What times do you have tomorrow?", "2:30 works", "Thanks!", "How much does this cost?", ""]) {
    assert.equal(classifyBookingReplyIntent(body), null);
  }
});

test("resolveSlotSelection: exact time matches resolve unambiguously", () => {
  for (const body of ["9:00", "9am", "9:00 AM", "9:00am"]) {
    const result = resolveSlotSelection(body, SLOTS, "UTC");
    assert.equal(result.outcome, "matched");
    if (result.outcome === "matched") assert.equal(result.slot.start_at, SLOTS[0].start_at);
  }
});

test("resolveSlotSelection: required customer phrasing variants all resolve correctly", () => {
  const cases: [string, number][] = [
    ["10:30", 1],
    ["10:30 works", 1],
    ["yes 10:30", 1],
    ["tomorrow at 10:30", 1],
    ["book me for 10:30", 1],
    ["let's do 10:30", 1],
    ["the second one", 1],
    ["I'll take 1", 2],
  ];
  for (const [body, expectedIndex] of cases) {
    const result = resolveSlotSelection(body, SLOTS, "UTC");
    assert.equal(result.outcome, "matched", `expected "${body}" to match`);
    if (result.outcome === "matched") assert.equal(result.slot.start_at, SLOTS[expectedIndex].start_at, `"${body}" should resolve to slot ${expectedIndex}`);
  }
});

test("resolveSlotSelection: 'that works'/'yes' with a SINGLE offered slot resolves unambiguously", () => {
  const result = resolveSlotSelection("that works", [SLOTS[0]], "UTC");
  assert.equal(result.outcome, "matched");
  if (result.outcome === "matched") assert.equal(result.slot.start_at, SLOTS[0].start_at);
});

test("resolveSlotSelection: 'yes' with MULTIPLE offered slots is ambiguous - never guessed", () => {
  const result = resolveSlotSelection("yes", SLOTS, "UTC");
  assert.equal(result.outcome, "ambiguous");
});

test("resolveSlotSelection: a bare affirmative with multiple slots is ambiguous", () => {
  for (const body of ["that works", "sounds good", "ok", "sure"]) {
    const result = resolveSlotSelection(body, SLOTS, "UTC");
    assert.equal(result.outcome, "ambiguous", `expected "${body}" with 3 offered slots to be ambiguous`);
  }
});

test("resolveSlotSelection: an unrelated message never matches", () => {
  for (const body of ["How much does this cost?", "What's your address?", "Thanks so much!"]) {
    const result = resolveSlotSelection(body, SLOTS, "UTC");
    assert.equal(result.outcome, "no_match", `expected "${body}" to be no_match`);
  }
});

test("resolveSlotSelection: a number matching no offered slot is no_match, never a guess", () => {
  const result = resolveSlotSelection("5:00", SLOTS, "UTC");
  assert.equal(result.outcome, "no_match");
});

test("resolveSlotSelection: 'last' resolves to the final offered slot", () => {
  const result = resolveSlotSelection("I'll take the last one", SLOTS, "UTC");
  assert.equal(result.outcome, "matched");
  if (result.outcome === "matched") assert.equal(result.slot.start_at, SLOTS[2].start_at);
});

test("resolveSlotSelection: no offered slots is always no_match", () => {
  const result = resolveSlotSelection("2:30", [], "UTC");
  assert.equal(result.outcome, "no_match");
});

test("resolveSlotSelection: resolves against the organization's configured timezone, never server-local or UTC by assumption", () => {
  // 2027-01-04 is a Monday, well clear of any DST transition - EST is a
  // fixed UTC-5 offset here. These slots read as 09:00/10:30/13:00 UTC (like
  // SLOTS above), but as 04:00/05:30/08:00 in America/New_York - proving
  // resolution genuinely uses the passed timezone, not a hardcoded UTC
  // assumption a server-local or browser-timezone bug would produce.
  const nySlots = [
    { start_at: "2027-01-04T14:00:00.000Z", end_at: "2027-01-04T15:00:00.000Z" }, // 09:00 America/New_York
    { start_at: "2027-01-04T15:30:00.000Z", end_at: "2027-01-04T16:30:00.000Z" }, // 10:30 America/New_York
    { start_at: "2027-01-04T18:00:00.000Z", end_at: "2027-01-04T19:00:00.000Z" }, // 13:00 America/New_York
  ];

  const result = resolveSlotSelection("10:30", nySlots, "America/New_York");
  assert.equal(result.outcome, "matched");
  if (result.outcome === "matched") assert.equal(result.slot.start_at, nySlots[1].start_at);

  // The same literal clock time read against plain UTC (no conversion)
  // would NOT match any of these slots at all - proving the timezone
  // parameter is genuinely load-bearing, not a no-op.
  const utcMisread = resolveSlotSelection("10:30", nySlots, "UTC");
  assert.equal(utcMisread.outcome, "no_match");
});

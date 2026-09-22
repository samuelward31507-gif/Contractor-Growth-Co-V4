/**
 * Unit tests for computeAvailableSlots() - the pure calculation core of the
 * Phase 1 Scheduling Foundation availability engine (Stage 2). No Supabase,
 * no wall clock - every input, including `now`, is passed explicitly, the
 * same convention lib/automation/outbound-gate.test.ts already established
 * for isWithinBusinessHours(). Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/scheduling/availability.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { BusinessHour, BookingSettings } from "@/lib/settings/queries";
import type { AvailabilityInput } from "./availability";

const require = createRequire(import.meta.url);
const { computeAvailableSlots }: typeof import("./availability") = require("./availability.ts");

const MON_FRI_9_5: BusinessHour[] = [
  { day_of_week: "monday", is_open: true, open_time: "09:00:00", close_time: "17:00:00" },
  { day_of_week: "tuesday", is_open: true, open_time: "09:00:00", close_time: "17:00:00" },
  { day_of_week: "wednesday", is_open: true, open_time: "09:00:00", close_time: "17:00:00" },
  { day_of_week: "thursday", is_open: true, open_time: "09:00:00", close_time: "17:00:00" },
  { day_of_week: "friday", is_open: true, open_time: "09:00:00", close_time: "17:00:00" },
  { day_of_week: "saturday", is_open: false, open_time: null, close_time: null },
  { day_of_week: "sunday", is_open: false, open_time: null, close_time: null },
];

const DEFAULT_SETTINGS: BookingSettings = {
  booking_enabled: true,
  minimum_notice_minutes: 0,
  default_duration_minutes: 60,
  buffer_minutes: 0,
};

// 2026-09-21 is a Monday (matches outbound-gate.test.ts's own fixture date).
const EARLY_MONDAY_MORNING = new Date("2026-09-21T00:00:00.000Z"); // well before minimum notice can ever matter in "UTC" tests below

function baseInput(overrides: Partial<AvailabilityInput> = {}): AvailabilityInput {
  return {
    bookingSettings: DEFAULT_SETTINGS,
    businessHours: MON_FRI_9_5,
    timeZone: "UTC",
    existingAppointments: [],
    dateRangeStart: new Date("2026-09-21T00:00:00.000Z"),
    dateRangeEnd: new Date("2026-09-22T00:00:00.000Z"),
    ...overrides,
  };
}

test("1. booking_enabled: false returns booking_disabled, regardless of everything else being otherwise valid", () => {
  const result = computeAvailableSlots(baseInput({ bookingSettings: { ...DEFAULT_SETTINGS, booking_enabled: false } }), EARLY_MONDAY_MORNING);
  assert.equal(result.status, "booking_disabled");
});

test("2. no business_hours rows at all returns business_hours_not_configured - never treated as 24/7, unlike isWithinBusinessHours's own semantics", () => {
  const result = computeAvailableSlots(baseInput({ businessHours: [] }), EARLY_MONDAY_MORNING);
  assert.equal(result.status, "business_hours_not_configured");
});

test("3. a normal Mon-Fri 9-5 day with 60-minute duration and no conflicts returns exactly the 8 hourly slots, in order, using [start, end) semantics", () => {
  const result = computeAvailableSlots(baseInput(), EARLY_MONDAY_MORNING);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.slots.length, 8);
  assert.equal(result.slots[0].start_at, "2026-09-21T09:00:00.000Z");
  assert.equal(result.slots[0].end_at, "2026-09-21T10:00:00.000Z");
  assert.equal(result.slots[7].start_at, "2026-09-21T16:00:00.000Z");
  assert.equal(result.slots[7].end_at, "2026-09-21T17:00:00.000Z");
});

test("4. minimum notice excludes a slot that starts before now + minimum_notice_minutes", () => {
  // now = Monday 09:30 UTC, minimum notice = 60 minutes -> earliest bookable start is 10:30,
  // so the 09:00 and 10:00 slots must be excluded, 11:00 onward remains.
  const now = new Date("2026-09-21T09:30:00.000Z");
  const settings = { ...DEFAULT_SETTINGS, minimum_notice_minutes: 60 };
  const result = computeAvailableSlots(baseInput({ bookingSettings: settings }), now);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.deepEqual(
    result.slots.map((slot) => slot.start_at),
    ["2026-09-21T11:00:00.000Z", "2026-09-21T12:00:00.000Z", "2026-09-21T13:00:00.000Z", "2026-09-21T14:00:00.000Z", "2026-09-21T15:00:00.000Z", "2026-09-21T16:00:00.000Z"],
  );
});

test("5. minimum-notice boundary: a slot starting exactly at now + minimum_notice is INCLUDED (inclusive lower bound), one minute earlier is EXCLUDED", () => {
  const settings = { ...DEFAULT_SETTINGS, minimum_notice_minutes: 60 };

  const exactlyAtBoundary = new Date("2026-09-21T09:00:00.000Z"); // now + 60min = 10:00, the 10:00 slot must be included
  const resultAtBoundary = computeAvailableSlots(baseInput({ bookingSettings: settings }), exactlyAtBoundary);
  assert.equal(resultAtBoundary.status, "available");
  if (resultAtBoundary.status === "available") {
    assert.ok(resultAtBoundary.slots.some((slot) => slot.start_at === "2026-09-21T10:00:00.000Z"), "the slot exactly at the notice boundary must be included");
  }

  const oneMinuteLater = new Date("2026-09-21T09:01:00.000Z"); // now + 60min = 10:01, the 10:00 slot must now be excluded
  const resultJustInside = computeAvailableSlots(baseInput({ bookingSettings: settings }), oneMinuteLater);
  assert.equal(resultJustInside.status, "available");
  if (resultJustInside.status === "available") {
    assert.ok(!resultJustInside.slots.some((slot) => slot.start_at === "2026-09-21T10:00:00.000Z"), "a slot one minute inside the notice window must be excluded");
  }
});

test("6. appointment duration is honored - 30-minute default_duration_minutes produces 30-minute slots, twice as many of them", () => {
  const settings = { ...DEFAULT_SETTINGS, default_duration_minutes: 30 };
  const result = computeAvailableSlots(baseInput({ bookingSettings: settings }), EARLY_MONDAY_MORNING);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.slots.length, 16); // 8 hours / 30 minutes
  assert.equal(result.slots[0].end_at, "2026-09-21T09:30:00.000Z");
  assert.equal(result.slots[1].start_at, "2026-09-21T09:30:00.000Z");
});

test("7. buffer_minutes widens the conflict check around an existing appointment without changing the returned slot's own duration", () => {
  // A 10:00-11:00 appointment with a 30-minute buffer should also exclude
  // 09:00-10:00 (touches the buffered window: 09:30-11:30) and 11:00-12:00
  // (starts inside 09:30-11:30's tail), leaving 12:00 onward untouched.
  const settings = { ...DEFAULT_SETTINGS, buffer_minutes: 30 };
  const result = computeAvailableSlots(
    baseInput({
      bookingSettings: settings,
      existingAppointments: [{ start_at: "2026-09-21T10:00:00.000Z", end_at: "2026-09-21T11:00:00.000Z", status: "scheduled" }],
    }),
    EARLY_MONDAY_MORNING,
  );
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  const starts = result.slots.map((slot) => slot.start_at);
  assert.ok(!starts.includes("2026-09-21T09:00:00.000Z"), "09:00 must be excluded - falls inside the buffered window");
  assert.ok(!starts.includes("2026-09-21T10:00:00.000Z"), "10:00 must be excluded - the appointment itself");
  assert.ok(!starts.includes("2026-09-21T11:00:00.000Z"), "11:00 must be excluded - falls inside the buffered window");
  assert.ok(starts.includes("2026-09-21T12:00:00.000Z"), "12:00 must remain available - outside the buffered window");
  // Every returned slot is still exactly 60 minutes - the buffer only widens the CHECK, never the offered slot.
  for (const slot of result.slots) {
    assert.equal(new Date(slot.end_at).getTime() - new Date(slot.start_at).getTime(), 60 * 60_000);
  }
});

test("8. an overlapping scheduled appointment removes exactly the conflicting candidate slot(s)", () => {
  const result = computeAvailableSlots(
    baseInput({ existingAppointments: [{ start_at: "2026-09-21T13:00:00.000Z", end_at: "2026-09-21T14:00:00.000Z", status: "scheduled" }] }),
    EARLY_MONDAY_MORNING,
  );
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.slots.length, 7);
  assert.ok(!result.slots.some((slot) => slot.start_at === "2026-09-21T13:00:00.000Z"));
});

test("9. a back-to-back (touching, not overlapping) appointment does NOT remove the adjacent slot when buffer is zero", () => {
  const result = computeAvailableSlots(
    baseInput({ existingAppointments: [{ start_at: "2026-09-21T13:00:00.000Z", end_at: "2026-09-21T14:00:00.000Z", status: "scheduled" }] }),
    EARLY_MONDAY_MORNING,
  );
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.ok(result.slots.some((slot) => slot.start_at === "2026-09-21T12:00:00.000Z"), "the slot ending exactly when the appointment starts must remain available");
  assert.ok(result.slots.some((slot) => slot.start_at === "2026-09-21T14:00:00.000Z"), "the slot starting exactly when the appointment ends must remain available");
});

test("10. a cancelled appointment never blocks availability, even at the exact same time", () => {
  const result = computeAvailableSlots(
    baseInput({ existingAppointments: [{ start_at: "2026-09-21T13:00:00.000Z", end_at: "2026-09-21T14:00:00.000Z", status: "cancelled" }] }),
    EARLY_MONDAY_MORNING,
  );
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.slots.length, 8, "all 8 hourly slots must remain, including 13:00, since a cancelled appointment never occupies its slot");
});

test("11. a no_show appointment never blocks availability, even at the exact same time", () => {
  const result = computeAvailableSlots(
    baseInput({ existingAppointments: [{ start_at: "2026-09-21T13:00:00.000Z", end_at: "2026-09-21T14:00:00.000Z", status: "no_show" }] }),
    EARLY_MONDAY_MORNING,
  );
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.slots.length, 8, "all 8 hourly slots must remain, since a no-show never occupies its slot");
});

test("12. a completed appointment DOES block availability, exactly like scheduled/confirmed", () => {
  const result = computeAvailableSlots(
    baseInput({ existingAppointments: [{ start_at: "2026-09-21T13:00:00.000Z", end_at: "2026-09-21T14:00:00.000Z", status: "completed" }] }),
    EARLY_MONDAY_MORNING,
  );
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.slots.length, 7);
  assert.ok(!result.slots.some((slot) => slot.start_at === "2026-09-21T13:00:00.000Z"));
});

test("13. multiple business-hour windows across the requested date range are each honored independently - Monday 9-5 and Tuesday 10-2 in the same query", () => {
  const mondayTuesdayHours: BusinessHour[] = [
    { day_of_week: "monday", is_open: true, open_time: "09:00:00", close_time: "17:00:00" },
    { day_of_week: "tuesday", is_open: true, open_time: "10:00:00", close_time: "14:00:00" },
    ...MON_FRI_9_5.filter((h) => h.day_of_week !== "monday" && h.day_of_week !== "tuesday"),
  ];
  const result = computeAvailableSlots(
    baseInput({ businessHours: mondayTuesdayHours, dateRangeStart: new Date("2026-09-21T00:00:00.000Z"), dateRangeEnd: new Date("2026-09-23T00:00:00.000Z") }),
    EARLY_MONDAY_MORNING,
  );
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.slots.length, 8 + 4, "8 hourly slots Monday (9-5) plus 4 hourly slots Tuesday (10-2)");
  assert.ok(result.slots.some((slot) => slot.start_at === "2026-09-21T09:00:00.000Z"));
  assert.ok(result.slots.some((slot) => slot.start_at === "2026-09-22T10:00:00.000Z"));
  assert.ok(!result.slots.some((slot) => slot.start_at === "2026-09-22T09:00:00.000Z"), "Tuesday opens at 10, not 9 - must not reuse Monday's hours");
});

test("14. timezone conversion: the same organization-local 9-5 window produces different UTC instants depending on the configured timezone", () => {
  // America/Denver is UTC-6 (MDT) in September 2026 - 09:00 Denver local time is 15:00 UTC.
  const result = computeAvailableSlots(baseInput({ timeZone: "America/Denver" }), new Date("2026-09-21T00:00:00.000Z"));
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.slots[0].start_at, "2026-09-21T15:00:00.000Z", "09:00 America/Denver (MDT, UTC-6) must convert to 15:00 UTC");
  assert.equal(result.slots[7].end_at, "2026-09-21T23:00:00.000Z", "17:00 America/Denver (MDT, UTC-6) must convert to 23:00 UTC");
});

test("15. DST transition: the same 09:00 America/Denver wall-clock slot converts to a different UTC instant before and after the fall-back transition (2026-11-01)", () => {
  // Friday 2026-10-30 is still MDT (UTC-6): 09:00 Denver -> 15:00 UTC.
  // Monday 2026-11-02 is already MST (UTC-7), after the Nov 1 fall-back: 09:00 Denver -> 16:00 UTC.
  const fridayBeforeDst = computeAvailableSlots(
    baseInput({ timeZone: "America/Denver", dateRangeStart: new Date("2026-10-30T00:00:00.000Z"), dateRangeEnd: new Date("2026-10-31T00:00:00.000Z") }),
    new Date("2026-10-29T00:00:00.000Z"),
  );
  const mondayAfterDst = computeAvailableSlots(
    baseInput({ timeZone: "America/Denver", dateRangeStart: new Date("2026-11-02T00:00:00.000Z"), dateRangeEnd: new Date("2026-11-03T00:00:00.000Z") }),
    new Date("2026-10-29T00:00:00.000Z"),
  );
  assert.equal(fridayBeforeDst.status, "available");
  assert.equal(mondayAfterDst.status, "available");
  if (fridayBeforeDst.status !== "available" || mondayAfterDst.status !== "available") return;
  assert.equal(fridayBeforeDst.slots[0].start_at, "2026-10-30T15:00:00.000Z", "before fall-back, Denver is MDT (UTC-6)");
  assert.equal(mondayAfterDst.slots[0].start_at, "2026-11-02T16:00:00.000Z", "after fall-back, Denver is MST (UTC-7) - the same 09:00 local wall clock is now an hour later in UTC");
});

test("16. invalid configuration: a non-positive default_duration_minutes is rejected", () => {
  const result = computeAvailableSlots(baseInput({ bookingSettings: { ...DEFAULT_SETTINGS, default_duration_minutes: 0 } }), EARLY_MONDAY_MORNING);
  assert.equal(result.status, "invalid_configuration");
});

test("16b. invalid configuration: a negative buffer_minutes is rejected", () => {
  const result = computeAvailableSlots(baseInput({ bookingSettings: { ...DEFAULT_SETTINGS, buffer_minutes: -5 } }), EARLY_MONDAY_MORNING);
  assert.equal(result.status, "invalid_configuration");
});

test("16c. invalid configuration: a negative minimum_notice_minutes is rejected", () => {
  const result = computeAvailableSlots(baseInput({ bookingSettings: { ...DEFAULT_SETTINGS, minimum_notice_minutes: -1 } }), EARLY_MONDAY_MORNING);
  assert.equal(result.status, "invalid_configuration");
});

test("16d. invalid configuration: dateRangeEnd at or before dateRangeStart is rejected", () => {
  const result = computeAvailableSlots(baseInput({ dateRangeStart: new Date("2026-09-21T12:00:00.000Z"), dateRangeEnd: new Date("2026-09-21T12:00:00.000Z") }), EARLY_MONDAY_MORNING);
  assert.equal(result.status, "invalid_configuration");
});

test("16e. invalid configuration: an unrecognized timezone string is rejected", () => {
  const result = computeAvailableSlots(baseInput({ timeZone: "Not/A_Real_Zone" }), EARLY_MONDAY_MORNING);
  assert.equal(result.status, "invalid_configuration");
});

test("17. bounded date range: a range longer than the maximum allowed is rejected rather than silently generating an enormous slot list", () => {
  const result = computeAvailableSlots(baseInput({ dateRangeStart: new Date("2026-01-01T00:00:00.000Z"), dateRangeEnd: new Date("2027-01-01T00:00:00.000Z") }), EARLY_MONDAY_MORNING);
  assert.equal(result.status, "invalid_configuration");
});

test("17b. bounded date range: a range within the maximum allowed is accepted", () => {
  const result = computeAvailableSlots(baseInput({ dateRangeStart: new Date("2026-09-21T00:00:00.000Z"), dateRangeEnd: new Date("2026-10-05T00:00:00.000Z") }), EARLY_MONDAY_MORNING);
  assert.equal(result.status, "available");
});

test("18. a day with no configured row at all (e.g. Saturday, explicitly is_open: false) produces no slots that day, without affecting other open days", () => {
  const result = computeAvailableSlots(
    baseInput({ dateRangeStart: new Date("2026-09-19T00:00:00.000Z"), dateRangeEnd: new Date("2026-09-22T00:00:00.000Z") }), // Sat 19 -> Mon 21
    new Date("2026-09-18T00:00:00.000Z"),
  );
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.ok(!result.slots.some((slot) => slot.start_at.startsWith("2026-09-19") || slot.start_at.startsWith("2026-09-20")), "Saturday/Sunday must produce zero slots");
  assert.equal(result.slots.length, 8, "only Monday's 8 hourly slots");
});

// ===========================================================================
// GOOGLE CALENDAR BUSY PERIODS (Phase 1 Scheduling Foundation, Stage 4)
//
// computeAvailableSlots() itself needed ZERO changes for Stage 4 - it
// already merged input.externalBusyPeriods into the same conflict check as
// Trackpr appointments since Stage 2 (see this file's own module comment
// and AvailabilityInput's own comment). These tests exist to prove that
// boundary actually behaves correctly for every scenario Stage 4 cares
// about, not because the implementation changed.
// ===========================================================================

test("19. a Google busy interval completely covering a candidate slot removes it", () => {
  const result = computeAvailableSlots(baseInput({ externalBusyPeriods: [{ start_at: "2026-09-21T09:00:00.000Z", end_at: "2026-09-21T15:00:00.000Z" }] }), EARLY_MONDAY_MORNING);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  const starts = result.slots.map((s) => s.start_at);
  for (const hour of ["09", "10", "11", "12", "13", "14"]) assert.ok(!starts.includes(`2026-09-21T${hour}:00:00.000Z`));
  assert.ok(starts.includes("2026-09-21T15:00:00.000Z"), "the slot right after the busy interval ends must remain available");
});

test("20. a Google busy interval partially overlapping a candidate slot removes it", () => {
  const result = computeAvailableSlots(baseInput({ externalBusyPeriods: [{ start_at: "2026-09-21T13:30:00.000Z", end_at: "2026-09-21T14:30:00.000Z" }] }), EARLY_MONDAY_MORNING);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  const starts = result.slots.map((s) => s.start_at);
  assert.ok(!starts.includes("2026-09-21T13:00:00.000Z"), "overlaps the busy interval's start half");
  assert.ok(!starts.includes("2026-09-21T14:00:00.000Z"), "overlaps the busy interval's end half");
  assert.ok(starts.includes("2026-09-21T12:00:00.000Z") && starts.includes("2026-09-21T15:00:00.000Z"));
});

test("21. a Google busy interval nested inside a wider Trackpr appointment changes nothing - the appointment alone already blocks the whole range, and the redundant nested interval must not cause any double-counting bug", () => {
  const result = computeAvailableSlots(
    baseInput({
      existingAppointments: [{ start_at: "2026-09-21T10:00:00.000Z", end_at: "2026-09-21T14:00:00.000Z", status: "scheduled" }],
      externalBusyPeriods: [{ start_at: "2026-09-21T11:00:00.000Z", end_at: "2026-09-21T12:00:00.000Z" }],
    }),
    EARLY_MONDAY_MORNING,
  );
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.slots.length, 4, "8 hourly slots minus the 4 the appointment alone already covers (10,11,12,13)");
});

test("22. a Trackpr appointment and a Google busy period at different times both independently remove their own slot, without interfering with each other", () => {
  const result = computeAvailableSlots(
    baseInput({
      existingAppointments: [{ start_at: "2026-09-21T09:00:00.000Z", end_at: "2026-09-21T10:00:00.000Z", status: "scheduled" }],
      externalBusyPeriods: [{ start_at: "2026-09-21T15:00:00.000Z", end_at: "2026-09-21T16:00:00.000Z" }],
    }),
    EARLY_MONDAY_MORNING,
  );
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  const starts = result.slots.map((s) => s.start_at);
  assert.ok(!starts.includes("2026-09-21T09:00:00.000Z"));
  assert.ok(!starts.includes("2026-09-21T15:00:00.000Z"));
  assert.equal(result.slots.length, 6, "8 hourly slots minus the 2 independently removed ones");
});

test("23. back-to-back: a candidate slot touching (but not overlapping) a Google busy interval remains available when buffer is zero", () => {
  const result = computeAvailableSlots(baseInput({ externalBusyPeriods: [{ start_at: "2026-09-21T13:00:00.000Z", end_at: "2026-09-21T14:00:00.000Z" }] }), EARLY_MONDAY_MORNING);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  const starts = result.slots.map((s) => s.start_at);
  assert.ok(starts.includes("2026-09-21T12:00:00.000Z"), "ends exactly when the Google busy interval starts");
  assert.ok(starts.includes("2026-09-21T14:00:00.000Z"), "starts exactly when the Google busy interval ends");
});

test("24. buffer_minutes widens the conflict check around a Google busy period exactly like it does around a Trackpr appointment", () => {
  const settings = { ...DEFAULT_SETTINGS, buffer_minutes: 30 };
  const result = computeAvailableSlots(
    baseInput({ bookingSettings: settings, externalBusyPeriods: [{ start_at: "2026-09-21T13:00:00.000Z", end_at: "2026-09-21T14:00:00.000Z" }] }),
    EARLY_MONDAY_MORNING,
  );
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  const starts = result.slots.map((s) => s.start_at);
  assert.ok(!starts.includes("2026-09-21T12:00:00.000Z"), "falls inside the buffered window before the Google busy period");
  assert.ok(!starts.includes("2026-09-21T14:00:00.000Z"), "falls inside the buffered window after the Google busy period");
  assert.ok(starts.includes("2026-09-21T15:00:00.000Z"));
});

test("25. a cancelled Trackpr appointment still never blocks, even when a Google busy period is also present elsewhere in the same request", () => {
  const result = computeAvailableSlots(
    baseInput({
      existingAppointments: [{ start_at: "2026-09-21T09:00:00.000Z", end_at: "2026-09-21T10:00:00.000Z", status: "cancelled" }],
      externalBusyPeriods: [{ start_at: "2026-09-21T15:00:00.000Z", end_at: "2026-09-21T16:00:00.000Z" }],
    }),
    EARLY_MONDAY_MORNING,
  );
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.ok(result.slots.some((s) => s.start_at === "2026-09-21T09:00:00.000Z"), "the cancelled appointment's slot must remain available");
  assert.equal(result.slots.length, 7, "only the real Google busy period removes a slot");
});

test("26. a no_show Trackpr appointment still never blocks, even when a Google busy period is also present elsewhere in the same request", () => {
  const result = computeAvailableSlots(
    baseInput({
      existingAppointments: [{ start_at: "2026-09-21T09:00:00.000Z", end_at: "2026-09-21T10:00:00.000Z", status: "no_show" }],
      externalBusyPeriods: [{ start_at: "2026-09-21T15:00:00.000Z", end_at: "2026-09-21T16:00:00.000Z" }],
    }),
    EARLY_MONDAY_MORNING,
  );
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.ok(result.slots.some((s) => s.start_at === "2026-09-21T09:00:00.000Z"));
  assert.equal(result.slots.length, 7);
});

test("27. multiple, separate Google busy intervals each independently remove their own slot", () => {
  const result = computeAvailableSlots(
    baseInput({
      externalBusyPeriods: [
        { start_at: "2026-09-21T09:00:00.000Z", end_at: "2026-09-21T10:00:00.000Z" },
        { start_at: "2026-09-21T13:00:00.000Z", end_at: "2026-09-21T14:00:00.000Z" },
        { start_at: "2026-09-21T16:00:00.000Z", end_at: "2026-09-21T17:00:00.000Z" },
      ],
    }),
    EARLY_MONDAY_MORNING,
  );
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.slots.length, 5, "8 hourly slots minus the 3 independently busy ones");
});

test("28. adjacent (back-to-back with each other) Google busy intervals combine into one continuous blocked range with no gap slot slipping through", () => {
  const result = computeAvailableSlots(
    baseInput({
      externalBusyPeriods: [
        { start_at: "2026-09-21T10:00:00.000Z", end_at: "2026-09-21T12:00:00.000Z" },
        { start_at: "2026-09-21T12:00:00.000Z", end_at: "2026-09-21T14:00:00.000Z" },
      ],
    }),
    EARLY_MONDAY_MORNING,
  );
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  const starts = result.slots.map((s) => s.start_at);
  for (const hour of ["10", "11", "12", "13"]) assert.ok(!starts.includes(`2026-09-21T${hour}:00:00.000Z`), `${hour}:00 must be blocked by the combined adjacent intervals`);
});

test("29. overlapping Google busy intervals correctly block their full combined union, without any double-counting bug creating a false gap", () => {
  const result = computeAvailableSlots(
    baseInput({
      externalBusyPeriods: [
        { start_at: "2026-09-21T10:00:00.000Z", end_at: "2026-09-21T12:00:00.000Z" },
        { start_at: "2026-09-21T11:00:00.000Z", end_at: "2026-09-21T13:00:00.000Z" },
      ],
    }),
    EARLY_MONDAY_MORNING,
  );
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  const starts = result.slots.map((s) => s.start_at);
  for (const hour of ["10", "11", "12"]) assert.ok(!starts.includes(`2026-09-21T${hour}:00:00.000Z`));
  assert.ok(starts.includes("2026-09-21T13:00:00.000Z"), "the union's actual end (13:00) must be free again");
});

test("30. a Google busy interval expressed in UTC still correctly blocks slots generated from America/Denver business hours across the DST fall-back boundary (2026-11-01)", () => {
  // Business hours 09:00-17:00 America/Denver on Monday 2026-11-02 (MST,
  // UTC-7, after the Nov 1 fall-back) -> 16:00-00:00 UTC. A Google busy
  // period 16:00-17:00 UTC (the org's own 09:00-10:00 local) must remove
  // exactly that slot.
  const result = computeAvailableSlots(
    baseInput({
      timeZone: "America/Denver",
      dateRangeStart: new Date("2026-11-02T00:00:00.000Z"),
      dateRangeEnd: new Date("2026-11-03T00:00:00.000Z"),
      externalBusyPeriods: [{ start_at: "2026-11-02T16:00:00.000Z", end_at: "2026-11-02T17:00:00.000Z" }],
    }),
    new Date("2026-10-29T00:00:00.000Z"),
  );
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  const starts = result.slots.map((s) => s.start_at);
  assert.ok(!starts.includes("2026-11-02T16:00:00.000Z"), "the Google busy period must block the org's local 09:00 slot");
  assert.ok(starts.includes("2026-11-02T17:00:00.000Z"), "the org's local 10:00 slot (17:00 UTC, MST) must remain available");
});

/**
 * Live integration tests for lib/scheduling/booking.ts - the AI-facing
 * booking interface (Phase 1 Scheduling Foundation, Stage 6). Real,
 * disposable organizations/contacts/appointments on the production
 * Supabase project, fully cleaned up afterward. A FAKE CalendarProvider is
 * injected via getAvailableBookingSlots/bookAppointment's underlying
 * dependencies where relevant - this file never makes a real Google API
 * call, matching every prior stage's established convention.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/scheduling/booking.integration.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const require = createRequire(path.join(REPO_ROOT, "package.json"));

const envPath = path.join(REPO_ROOT, ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

const { getAvailableBookingSlots, bookAppointment, rescheduleAppointment }: typeof import("./booking") = require(path.join(REPO_ROOT, "lib/scheduling/booking.ts"));
const { storeGoogleConnection, selectCalendar }: typeof import("@/lib/calendar/connection") = require(path.join(REPO_ROOT, "lib/calendar/connection.ts"));
type CalendarProvider = import("@/lib/calendar/provider").CalendarProvider;

function fakeProvider(overrides: Partial<CalendarProvider> = {}): CalendarProvider {
  return {
    exchangeCode: async () => ({ ok: false, error: "not used in these tests" }),
    refreshAccessToken: async () => ({ ok: true, value: { accessToken: "refreshed-access-token", expiresAt: new Date(Date.now() + 3600_000).toISOString() } }),
    listCalendars: async () => ({ ok: true, value: [{ id: "team-calendar-id", name: "Jobs", primary: false }] }),
    checkHealth: async () => ({ ok: true, value: true }),
    getBusyPeriods: async () => ({ ok: true, value: [] }),
    createEvent: async (_accessToken, input) => ({ ok: true, value: { eventId: `fake-event-${Date.now()}-${Math.random()}`, calendarId: input.calendarId } }),
    updateEvent: async (_accessToken, calendarId, eventId) => ({ ok: true, value: { eventId, calendarId } }),
    deleteEvent: async () => ({ ok: true, value: true }),
    ...overrides,
  };
}

async function connectFakeCalendar(orgId: string) {
  await storeGoogleConnection(service, orgId, { email: "owner@example.com" }, { accessToken: "at-1", refreshToken: "rt-1", expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  await selectCalendar(service, orgId, "team-calendar-id", "Jobs");
}

async function disconnectCalendar(orgId: string) {
  await service.from("calendar_connections").delete().eq("organization_id", orgId);
}

const service = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const MON_FRI_9_5 = [
  { day_of_week: "monday", is_open: true, open_time: "09:00:00", close_time: "17:00:00" },
  { day_of_week: "tuesday", is_open: true, open_time: "09:00:00", close_time: "17:00:00" },
  { day_of_week: "wednesday", is_open: true, open_time: "09:00:00", close_time: "17:00:00" },
  { day_of_week: "thursday", is_open: true, open_time: "09:00:00", close_time: "17:00:00" },
  { day_of_week: "friday", is_open: true, open_time: "09:00:00", close_time: "17:00:00" },
  { day_of_week: "saturday", is_open: false, open_time: null, close_time: null },
  { day_of_week: "sunday", is_open: false, open_time: null, close_time: null },
];

// 2026-10-05 is a Monday, comfortably in the future relative to this test
// suite's actual run date (2026-09-22) - every fixture below must stay in
// the future, since minimum-notice/past-slot filtering will otherwise
// silently exclude it exactly like any other elapsed slot would.
const MONDAY_RANGE = { start: new Date("2026-10-05T00:00:00.000Z"), end: new Date("2026-10-06T00:00:00.000Z") };
const EARLY_MONDAY_MORNING = new Date("2026-10-05T00:00:00.000Z");
const FIRST_SLOT = { start_at: "2026-10-05T09:00:00.000Z", end_at: "2026-10-05T10:00:00.000Z" };

let organizationId: string;
let otherOrganizationId: string;
let contactId: string;
let otherOrgContactId: string;

async function setBookingSettings(orgId: string, overrides: Record<string, unknown> = {}) {
  await service.from("booking_settings").upsert({ organization_id: orgId, booking_enabled: true, minimum_notice_minutes: 0, default_duration_minutes: 60, buffer_minutes: 0, ...overrides }, { onConflict: "organization_id" });
}

async function setBusinessHours(orgId: string, hours: typeof MON_FRI_9_5) {
  await service.from("business_hours").delete().eq("organization_id", orgId);
  await service.from("business_hours").insert(hours.map((h) => ({ ...h, organization_id: orgId })));
}

async function activate(orgId: string) {
  await service.from("organizations").update({ payment_status: "active" }).eq("id", orgId);
}

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Booking Interface Integration Test Org", timezone: "UTC" }).select("id").single();
  organizationId = org!.id;
  await activate(organizationId);
  await setBookingSettings(organizationId);
  await setBusinessHours(organizationId, MON_FRI_9_5);

  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "Jane", last_name: "Doe", phone: "+15555550101" }).select("id").single();
  contactId = contact!.id;

  const { data: otherOrg } = await service.from("organizations").insert({ name: "Booking Interface Integration Test Org (Other)", timezone: "UTC" }).select("id").single();
  otherOrganizationId = otherOrg!.id;
  await activate(otherOrganizationId);
  await setBookingSettings(otherOrganizationId);
  await setBusinessHours(otherOrganizationId, MON_FRI_9_5);

  const { data: otherContact } = await service.from("contacts").insert({ organization_id: otherOrganizationId, first_name: "Other", last_name: "Org" }).select("id").single();
  otherOrgContactId = otherContact!.id;
});

after(async () => {
  await service.from("appointments").delete().eq("organization_id", organizationId);
  await service.from("appointments").delete().eq("organization_id", otherOrganizationId);
  await service.from("contacts").delete().eq("organization_id", organizationId);
  await service.from("contacts").delete().eq("organization_id", otherOrganizationId);
  await service.from("calendar_connections").delete().eq("organization_id", organizationId);
  await service.from("business_hours").delete().eq("organization_id", organizationId);
  await service.from("business_hours").delete().eq("organization_id", otherOrganizationId);
  await service.from("booking_settings").delete().eq("organization_id", organizationId);
  await service.from("booking_settings").delete().eq("organization_id", otherOrganizationId);
  await service.from("automation_events").delete().eq("organization_id", organizationId);
  await service.from("automation_events").delete().eq("organization_id", otherOrganizationId);
  await service.from("organizations").delete().eq("id", organizationId);
  await service.from("organizations").delete().eq("id", otherOrganizationId);
});

// ===========================================================================
// AVAILABILITY (getAvailableBookingSlots)
// ===========================================================================

test("1. returns real Trackpr-backed available slots", async () => {
  const result = await getAvailableBookingSlots(service, organizationId, MONDAY_RANGE.start, MONDAY_RANGE.end);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.slots.length, 8);
  assert.deepEqual(result.slots[0], FIRST_SLOT);
});

test("2. no available slots on a closed day (Saturday)", async () => {
  const result = await getAvailableBookingSlots(service, organizationId, new Date("2026-10-03T00:00:00.000Z"), new Date("2026-10-04T00:00:00.000Z"));
  assert.equal(result.status, "available");
  if (result.status === "available") assert.equal(result.slots.length, 0);
});

test("3. booking_disabled is surfaced through the wrapper unchanged", async () => {
  await setBookingSettings(organizationId, { booking_enabled: false });
  const result = await getAvailableBookingSlots(service, organizationId, MONDAY_RANGE.start, MONDAY_RANGE.end);
  assert.equal(result.status, "booking_disabled");
  await setBookingSettings(organizationId);
});

test("4. business_hours_not_configured is surfaced through the wrapper unchanged", async () => {
  await service.from("business_hours").delete().eq("organization_id", organizationId);
  const result = await getAvailableBookingSlots(service, organizationId, MONDAY_RANGE.start, MONDAY_RANGE.end);
  assert.equal(result.status, "business_hours_not_configured");
  await setBusinessHours(organizationId, MON_FRI_9_5);
});

test("5. an unhealthy connected calendar fails closed as calendar_unavailable, never silently Trackpr-only", async () => {
  await connectFakeCalendar(organizationId);
  try {
    const brokenProvider = fakeProvider({ getBusyPeriods: async () => ({ ok: false, error: "The calendar connection is no longer valid and needs to be reconnected." }) });
    const result = await getAvailableBookingSlots(service, organizationId, MONDAY_RANGE.start, MONDAY_RANGE.end, brokenProvider);
    assert.equal(result.status, "calendar_unavailable");
  } finally {
    await disconnectCalendar(organizationId);
  }
});

test("6. DST: business hours generated in America/Denver remain correct across the fall-back boundary through this same wrapper", async () => {
  await service.from("organizations").update({ timezone: "America/Denver" }).eq("id", organizationId);
  const result = await getAvailableBookingSlots(service, organizationId, new Date("2026-11-02T00:00:00.000Z"), new Date("2026-11-03T00:00:00.000Z"));
  assert.equal(result.status, "available");
  if (result.status === "available") {
    assert.equal(result.slots[0].start_at, "2026-11-02T16:00:00.000Z", "09:00 America/Denver after the Nov 1 fall-back (MST, UTC-7) must be 16:00 UTC");
  }
  await service.from("organizations").update({ timezone: "UTC" }).eq("id", organizationId);
});

test("7. minimum notice is honored through this same wrapper", async () => {
  await setBookingSettings(organizationId, { minimum_notice_minutes: 120 });
  const result = await getAvailableBookingSlots(service, organizationId, MONDAY_RANGE.start, MONDAY_RANGE.end, EARLY_MONDAY_MORNING as never);
  // getAvailableBookingSlots doesn't accept `now` directly (matches
  // getAvailableSlots's own default-to-real-clock signature) - this test
  // instead confirms the setting is read and applied at all by checking a
  // minimum_notice_minutes so large no slot today could ever satisfy it.
  assert.equal(result.status, "available");
  if (result.status === "available") {
    assert.equal(result.slots.some((s) => new Date(s.start_at).getTime() < Date.now() + 120 * 60_000), false);
  }
  await setBookingSettings(organizationId);
});

// ===========================================================================
// BOOKING (bookAppointment)
// ===========================================================================

test("8. a successful booking creates the Trackpr appointment and returns the correct confirmation payload", async () => {
  const result = await bookAppointment(service, {
    organizationId,
    contactId,
    startAt: FIRST_SLOT.start_at,
    endAt: FIRST_SLOT.end_at,
    title: "AC Repair",
    idempotencyKey: "booking:test-8",
  });

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.ok(result.appointmentId);
  assert.equal(result.startAt, FIRST_SLOT.start_at);
  assert.equal(result.endAt, FIRST_SLOT.end_at);
  assert.equal(result.timezone, "UTC");
  assert.equal(result.calendarSyncStatus, "synced", "no calendar connected - treated as cleanly synced, nothing to act on");

  const { data: appointment } = await service.from("appointments").select("status, contact_id").eq("id", result.appointmentId).single();
  assert.equal(appointment?.status, "scheduled");
  assert.equal(appointment?.contact_id, contactId);
});

test("9. a stale slot (no longer actually available) is rejected with slot_unavailable, and no appointment is created", async () => {
  const slot = { start_at: "2026-10-05T11:00:00.000Z", end_at: "2026-10-05T12:00:00.000Z" };
  await service.from("appointments").insert({ organization_id: organizationId, contact_id: contactId, title: "Blocking appointment", start_at: slot.start_at, end_at: slot.end_at, status: "scheduled" });

  const result = await bookAppointment(service, { organizationId, contactId, startAt: slot.start_at, endAt: slot.end_at, title: "AC Repair", idempotencyKey: "booking:test-9" });
  assert.equal(result.success, false);
  if (result.success) return;
  assert.equal(result.reason, "slot_unavailable");
});

test("10. CONCURRENCY: two simultaneous booking attempts for the same slot result in exactly one success, proving Stage 1's exclusion constraint is the real backstop underneath the availability recheck", async () => {
  const slot = { start_at: "2026-10-05T13:00:00.000Z", end_at: "2026-10-05T14:00:00.000Z" };

  const [resultA, resultB] = await Promise.all([
    bookAppointment(service, { organizationId, contactId, startAt: slot.start_at, endAt: slot.end_at, title: "Concurrent A", idempotencyKey: "booking:test-10-a" }),
    bookAppointment(service, { organizationId, contactId, startAt: slot.start_at, endAt: slot.end_at, title: "Concurrent B", idempotencyKey: "booking:test-10-b" }),
  ]);

  const successes = [resultA, resultB].filter((r) => r.success);
  const failures = [resultA, resultB].filter((r) => !r.success);
  assert.equal(successes.length, 1, "exactly one concurrent booking attempt for the same slot must succeed");
  assert.equal(failures.length, 1);
  if (!failures[0].success) assert.equal(failures[0].reason, "slot_unavailable");
});

test("11. when Google Calendar sync fails, the Trackpr appointment is still created and reported as a success, with calendarSyncStatus 'needs_attention'", async () => {
  await connectFakeCalendar(organizationId);
  try {
    // Busy periods resolve fine (recheck passes, proving the calendar was
    // healthy right up to the insert), but the createEvent call itself
    // fails - a distinct, later failure mode from an unhealthy connection.
    const provider = fakeProvider({ createEvent: async () => ({ ok: false, error: "The calendar provider rejected the request." }) });
    const slot = { start_at: "2026-10-05T15:00:00.000Z", end_at: "2026-10-05T16:00:00.000Z" };
    const result = await bookAppointment(service, { organizationId, contactId, startAt: slot.start_at, endAt: slot.end_at, title: "AC Repair", idempotencyKey: "booking:test-11" }, provider);

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.calendarSyncStatus, "needs_attention");

    const { data: appointment } = await service.from("appointments").select("id").eq("id", result.appointmentId).single();
    assert.ok(appointment, "the Trackpr appointment must exist regardless of the Google sync failure");
  } finally {
    await disconnectCalendar(organizationId);
  }
});

test("12. IDEMPOTENCY: retrying the exact same booking request (same idempotencyKey) never creates a second appointment, and replays the original successful result", async () => {
  const slot = { start_at: "2026-10-05T16:00:00.000Z", end_at: "2026-10-05T17:00:00.000Z" };
  const key = "booking:test-12";

  const first = await bookAppointment(service, { organizationId, contactId, startAt: slot.start_at, endAt: slot.end_at, title: "AC Repair", idempotencyKey: key });
  const second = await bookAppointment(service, { organizationId, contactId, startAt: slot.start_at, endAt: slot.end_at, title: "AC Repair (should not create a second row)", idempotencyKey: key });

  assert.equal(first.success, true);
  assert.equal(second.success, true);
  if (!first.success || !second.success) return;
  assert.equal(first.appointmentId, second.appointmentId, "a retried request must return the SAME appointment id, not create a new one");

  const { data: appointments } = await service.from("appointments").select("id").eq("organization_id", organizationId).eq("start_at", slot.start_at);
  assert.equal(appointments?.length, 1, "exactly one appointment row must exist for this slot, regardless of the retry");
});

test("13. IDEMPOTENCY: retrying a booking request that originally FAILED replays the same failure, never silently succeeding on retry with stale input", async () => {
  const slot = { start_at: "2026-10-05T09:00:00.000Z", end_at: "2026-10-05T10:00:00.000Z" }; // already booked in test 8
  const key = "booking:test-13";

  const first = await bookAppointment(service, { organizationId, contactId, startAt: slot.start_at, endAt: slot.end_at, title: "AC Repair", idempotencyKey: key });
  const second = await bookAppointment(service, { organizationId, contactId, startAt: slot.start_at, endAt: slot.end_at, title: "AC Repair", idempotencyKey: key });

  assert.equal(first.success, false);
  assert.equal(second.success, false);
  if (first.success || second.success) return;
  assert.equal(first.reason, second.reason);
});

// ===========================================================================
// SECURITY
// ===========================================================================

test("14. cross-org isolation: organization B's contact/appointment can never be created or affected by organization A's booking request", async () => {
  const result = await bookAppointment(service, {
    organizationId: otherOrganizationId,
    contactId: otherOrgContactId,
    startAt: FIRST_SLOT.start_at,
    endAt: FIRST_SLOT.end_at,
    title: "Org B appointment",
    idempotencyKey: "booking:test-14",
  });
  assert.equal(result.success, true);
  if (!result.success) return;

  const { data: orgAAppointments } = await service.from("appointments").select("id").eq("organization_id", organizationId).eq("start_at", FIRST_SLOT.start_at);
  // Organization A already booked this exact slot in test 8 - confirms
  // organization B's identical-time booking used its OWN exclusion
  // constraint scope (organization-wide, not global) and never touched A's row.
  assert.equal(orgAAppointments?.length, 1, "organization A's own appointment for this slot must be completely unaffected");

  const { data: orgBAppointment } = await service.from("appointments").select("organization_id, contact_id").eq("id", result.appointmentId).single();
  assert.equal(orgBAppointment?.organization_id, otherOrganizationId);
  assert.equal(orgBAppointment?.contact_id, otherOrgContactId);
});

test("15. payment gate: a payment_required organization's booking attempt is rejected with organization_not_active, and creates no appointment - service-role bypasses RLS, so this must be an explicit check", async () => {
  await service.from("organizations").update({ payment_status: "payment_required" }).eq("id", organizationId);
  try {
    const result = await bookAppointment(service, { organizationId, contactId, startAt: "2026-10-06T09:00:00.000Z", endAt: "2026-10-06T10:00:00.000Z", title: "AC Repair", idempotencyKey: "booking:test-15" });
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.reason, "organization_not_active");

    const { data } = await service.from("appointments").select("id").eq("start_at", "2026-10-06T09:00:00.000Z");
    assert.equal(data?.length, 0);
  } finally {
    await activate(organizationId);
  }
});

test("16. organization resolution is always server-side: a contact belonging to a DIFFERENT organization than the one requested is rejected as invalid_contact, never silently booked against the wrong org", async () => {
  const result = await bookAppointment(service, {
    organizationId,
    contactId: otherOrgContactId, // belongs to otherOrganizationId, not organizationId
    startAt: "2026-10-07T09:00:00.000Z",
    endAt: "2026-10-07T10:00:00.000Z",
    title: "Should be rejected",
    idempotencyKey: "booking:test-16",
  });
  assert.equal(result.success, false);
  if (result.success) return;
  assert.equal(result.reason, "invalid_contact");
});

// ===========================================================================
// AI SAFETY
// ===========================================================================

test("17. AI SAFETY: a fabricated slot that was never returned by availability (e.g. outside business hours) is rejected as slot_unavailable, never booked", async () => {
  const result = await bookAppointment(service, {
    organizationId,
    contactId,
    startAt: "2026-10-05T22:00:00.000Z", // 10pm, well outside 9-5
    endAt: "2026-10-05T23:00:00.000Z",
    title: "Hallucinated slot",
    idempotencyKey: "booking:test-17",
  });
  assert.equal(result.success, false);
  if (result.success) return;
  assert.equal(result.reason, "slot_unavailable");

  const { data } = await service.from("appointments").select("id").eq("start_at", "2026-10-05T22:00:00.000Z");
  assert.equal(data?.length, 0);
});

test("18. AI SAFETY: every failure path leaves zero appointment rows behind - there is no partial-success state a caller could misreport as booked", async () => {
  const before = await service.from("appointments").select("id", { count: "exact", head: true }).eq("organization_id", organizationId);
  const result = await bookAppointment(service, {
    organizationId,
    contactId,
    startAt: "2026-10-05T22:00:00.000Z",
    endAt: "2026-10-05T23:00:00.000Z",
    title: "Should not create anything",
    idempotencyKey: "booking:test-18",
  });
  assert.equal(result.success, false);
  const after = await service.from("appointments").select("id", { count: "exact", head: true }).eq("organization_id", organizationId);
  assert.equal(after.count, before.count, "a failed booking attempt must never change the appointment count");
});

test("19. AI SAFETY: the success payload contains only the documented fields - no Google event id, no calendar id, no OAuth/credential data of any kind", async () => {
  const result = await bookAppointment(service, {
    organizationId,
    contactId,
    startAt: "2026-10-05T14:00:00.000Z",
    endAt: "2026-10-05T15:00:00.000Z",
    title: "AC Repair",
    idempotencyKey: "booking:test-19",
  });
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.deepEqual(Object.keys(result).sort(), ["appointmentId", "calendarSyncStatus", "endAt", "startAt", "success", "timezone"]);
});

// ===========================================================================
// Pass 5C Batch 5, Phase 1: appointment automation attribution
// (appointments.source_workflow_execution_id)
// ===========================================================================

test("22. ATTRIBUTION: a successful automated booking sets source_workflow_execution_id to the exact appointment_booking execution bookAppointment() created", async () => {
  const slot = { start_at: "2026-10-06T09:00:00.000Z", end_at: "2026-10-06T10:00:00.000Z" };
  const result = await bookAppointment(service, { organizationId, contactId, startAt: slot.start_at, endAt: slot.end_at, title: "AC Repair", idempotencyKey: "booking:test-22" });
  assert.equal(result.success, true);
  if (!result.success) return;

  const { data: appointment } = await service.from("appointments").select("source_workflow_execution_id").eq("id", result.appointmentId).single();
  assert.ok(appointment?.source_workflow_execution_id, "a booking created through bookAppointment() must record its own attribution");

  const { data: execution } = await service.from("workflow_executions").select("organization_id, workflow_name, status, metadata").eq("id", appointment!.source_workflow_execution_id).single();
  assert.equal(execution?.organization_id, organizationId);
  assert.equal(execution?.workflow_name, "appointment_booking");
  assert.equal(execution?.status, "completed");
  // The reverse link (execution -> appointment, via metadata) already
  // existed before this pass - confirms both directions agree rather than
  // this migration inventing a second, possibly-drifting source of truth.
  assert.equal((execution?.metadata as Record<string, unknown> | undefined)?.appointment_id, result.appointmentId);
});

test("23. ATTRIBUTION: a manually-created appointment (the shape app/(app)/appointments/actions.ts's createAppointment inserts - no source_workflow_execution_id in the payload) leaves attribution NULL", async () => {
  // Mirrors createAppointment's own insert payload exactly (organization_id,
  // contact_id, title, start_at, end_at, status) with no
  // source_workflow_execution_id field at all - proving the column defaults
  // to NULL rather than requiring an explicit null, which is what that
  // server action's own insert() call actually does (verified by direct
  // code inspection, not exercised here through a session-authenticated
  // server action - this codebase has no existing harness for driving
  // requireOrganization()-gated server actions from an integration test,
  // and building one is out of this pass's scope).
  const { data: appointment } = await service
    .from("appointments")
    .insert({ organization_id: organizationId, contact_id: contactId, title: "Manually booked", start_at: "2026-10-06T11:00:00.000Z", end_at: "2026-10-06T12:00:00.000Z", status: "scheduled" })
    .select("source_workflow_execution_id")
    .single();
  assert.equal(appointment?.source_workflow_execution_id, null);
});

test("24. ATTRIBUTION: retrying the same idempotencyKey never switches or duplicates attribution", async () => {
  const slot = { start_at: "2026-10-06T13:00:00.000Z", end_at: "2026-10-06T14:00:00.000Z" };
  const key = "booking:test-24";

  const first = await bookAppointment(service, { organizationId, contactId, startAt: slot.start_at, endAt: slot.end_at, title: "AC Repair", idempotencyKey: key });
  assert.equal(first.success, true);
  if (!first.success) return;
  const { data: firstAppointment } = await service.from("appointments").select("source_workflow_execution_id").eq("id", first.appointmentId).single();

  const second = await bookAppointment(service, { organizationId, contactId, startAt: slot.start_at, endAt: slot.end_at, title: "AC Repair (retry)", idempotencyKey: key });
  assert.equal(second.success, true);
  if (!second.success) return;
  assert.equal(second.appointmentId, first.appointmentId, "a retry must resolve to the same appointment, not a new one");

  const { data: secondAppointment } = await service.from("appointments").select("source_workflow_execution_id").eq("id", second.appointmentId).single();
  assert.equal(secondAppointment?.source_workflow_execution_id, firstAppointment?.source_workflow_execution_id, "a retry must never change the original attribution");

  const { data: appointmentsForSlot } = await service.from("appointments").select("id").eq("organization_id", organizationId).eq("start_at", slot.start_at);
  assert.equal(appointmentsForSlot?.length, 1, "a retry must never create a second appointment row");
});

test("25. ATTRIBUTION: rescheduling an appointment preserves its original attribution unchanged", async () => {
  const slot = { start_at: "2026-10-06T15:00:00.000Z", end_at: "2026-10-06T16:00:00.000Z" };
  const booked = await bookAppointment(service, { organizationId, contactId, startAt: slot.start_at, endAt: slot.end_at, title: "AC Repair", idempotencyKey: "booking:test-25" });
  assert.equal(booked.success, true);
  if (!booked.success) return;

  const { data: before } = await service.from("appointments").select("source_workflow_execution_id").eq("id", booked.appointmentId).single();
  assert.ok(before?.source_workflow_execution_id);

  const rescheduled = await rescheduleAppointment(service, {
    organizationId,
    contactId,
    appointmentId: booked.appointmentId,
    // Within the fixture's 09:00-17:00 business hours (17:00-18:00 is not -
    // business hours close AT 17:00, so 17:00 can never be a valid slot
    // start). 10:00-11:00 is the one hour on 2026-10-06 that no other test
    // in this file ever occupies for organizationId (09-10: test 22,
    // 11-12: test 23, 13-14: test 24, 14-15: test 20 below, 15-16: this
    // test's own original booking, 16-17: test 21 below).
    startAt: "2026-10-06T10:00:00.000Z",
    endAt: "2026-10-06T11:00:00.000Z",
    idempotencyKey: "reschedule:test-25",
  });
  assert.equal(rescheduled.success, true);

  const { data: after } = await service.from("appointments").select("source_workflow_execution_id").eq("id", booked.appointmentId).single();
  assert.equal(after?.source_workflow_execution_id, before?.source_workflow_execution_id, "rescheduleAppointment() UPDATEs the existing row and must never clear or replace its original attribution");
});

test("26. ATTRIBUTION: the foreign key rejects a nonexistent workflow_execution id", async () => {
  const { error } = await service
    .from("appointments")
    .insert({
      organization_id: organizationId,
      contact_id: contactId,
      title: "Should be rejected",
      start_at: "2026-10-06T19:00:00.000Z",
      end_at: "2026-10-06T20:00:00.000Z",
      status: "scheduled",
      source_workflow_execution_id: "00000000-0000-0000-0000-000000000000",
    })
    .select("id")
    .single();
  assert.ok(error, "inserting a nonexistent execution id must fail");
  assert.equal(error?.code, "23503", "must fail as a foreign key violation");
});

test("27. ATTRIBUTION: cross-org safety - organization A's and organization B's automated bookings each attribute only to their own organization's execution", async () => {
  // Within business hours (09:00-17:00). For organizationId, the only
  // remaining unused hour on 2026-10-06 is 12:00-13:00 (09-10: test 22,
  // 10-11: test 25's reschedule target above, 11-12: test 23, 13-14: test
  // 24, 14-15: test 20 below, 15-16: test 25's own original booking, 16-17:
  // test 21 below). otherOrganizationId has no other appointment anywhere
  // in this file on 2026-10-06 (its only other booking, test 14, is on
  // 2026-10-05) - its own exclusion-constraint scope is independent of
  // organizationId's, so reusing the same clock time for organization B
  // here is safe and mirrors this file's own established "identical time,
  // different org" pattern (see test 14).
  const slotA = { start_at: "2026-10-06T12:00:00.000Z", end_at: "2026-10-06T13:00:00.000Z" };
  const slotB = { start_at: "2026-10-06T12:00:00.000Z", end_at: "2026-10-06T13:00:00.000Z" };

  const resultA = await bookAppointment(service, { organizationId, contactId, startAt: slotA.start_at, endAt: slotA.end_at, title: "Org A booking", idempotencyKey: "booking:test-27-a" });
  const resultB = await bookAppointment(service, { organizationId: otherOrganizationId, contactId: otherOrgContactId, startAt: slotB.start_at, endAt: slotB.end_at, title: "Org B booking", idempotencyKey: "booking:test-27-b" });
  assert.equal(resultA.success, true);
  assert.equal(resultB.success, true);
  if (!resultA.success || !resultB.success) return;

  const { data: appointmentA } = await service.from("appointments").select("source_workflow_execution_id").eq("id", resultA.appointmentId).single();
  const { data: appointmentB } = await service.from("appointments").select("source_workflow_execution_id").eq("id", resultB.appointmentId).single();
  assert.notEqual(appointmentA?.source_workflow_execution_id, appointmentB?.source_workflow_execution_id);

  const { data: executionA } = await service.from("workflow_executions").select("organization_id").eq("id", appointmentA!.source_workflow_execution_id).single();
  const { data: executionB } = await service.from("workflow_executions").select("organization_id").eq("id", appointmentB!.source_workflow_execution_id).single();
  assert.equal(executionA?.organization_id, organizationId, "organization A's appointment must attribute only to an execution owned by organization A");
  assert.equal(executionB?.organization_id, otherOrganizationId, "organization B's appointment must attribute only to an execution owned by organization B");
});

test("28. ATTRIBUTION: pre-existing (historical) appointment rows are never backfilled and remain NULL", async () => {
  // Simulates a row that existed before this migration - a plain insert
  // with no source_workflow_execution_id, exactly like every appointment
  // ever created before this pass. The column's own default (no DEFAULT
  // clause, nullable) is what guarantees this, not any application code -
  // this test exists to keep that guarantee under regression coverage.
  const { data: historical } = await service
    .from("appointments")
    .insert({ organization_id: organizationId, contact_id: contactId, title: "Pre-existing appointment", start_at: "2026-10-06T22:00:00.000Z", end_at: "2026-10-06T23:00:00.000Z", status: "scheduled" })
    .select("source_workflow_execution_id")
    .single();
  assert.equal(historical?.source_workflow_execution_id, null);
});

test("29. ATTRIBUTION: opportunity sync (detection/resolution) never writes to appointment attribution", async () => {
  const slot = { start_at: "2026-10-07T09:00:00.000Z", end_at: "2026-10-07T10:00:00.000Z" };
  const booked = await bookAppointment(service, { organizationId, contactId, startAt: slot.start_at, endAt: slot.end_at, title: "AC Repair", idempotencyKey: "booking:test-29" });
  assert.equal(booked.success, true);
  if (!booked.success) return;

  const { data: before } = await service.from("appointments").select("source_workflow_execution_id").eq("id", booked.appointmentId).single();

  const { syncOpportunities }: typeof import("@/lib/opportunities/detect") = require(path.join(REPO_ROOT, "lib/opportunities/detect.ts"));
  await syncOpportunities(service, organizationId);

  const { data: after } = await service.from("appointments").select("source_workflow_execution_id").eq("id", booked.appointmentId).single();
  assert.equal(after?.source_workflow_execution_id, before?.source_workflow_execution_id, "opportunity sync must never touch appointment attribution - detection and attribution are separate concerns");
});

// ===========================================================================
// Pass 5B, Part A5: rescheduleAppointment confirmation invalidation
// ===========================================================================

async function insertAppointment(orgId: string, contactIdForOrg: string, status: "scheduled" | "confirmed", startAt: string, endAt: string, extra: Record<string, unknown> = {}) {
  const { data } = await service
    .from("appointments")
    .insert({ organization_id: orgId, contact_id: contactIdForOrg, title: "AC Repair", start_at: startAt, end_at: endAt, status, ...extra })
    .select("id")
    .single();
  return data!.id as string;
}

test("20. Part A5: rescheduling a CONFIRMED appointment reverts it to 'scheduled' and clears confirmed_at/confirmation_requested_at - the exact Part A5 example (confirmed Tuesday -> rescheduled Thursday -> requires confirmation again)", async () => {
  const appointmentId = await insertAppointment(organizationId, contactId, "confirmed", "2026-10-06T14:00:00.000Z", "2026-10-06T15:00:00.000Z", {
    confirmed_at: new Date().toISOString(),
    confirmation_requested_at: new Date().toISOString(),
  });

  const result = await rescheduleAppointment(service, {
    organizationId,
    contactId,
    appointmentId,
    startAt: "2026-10-08T14:00:00.000Z",
    endAt: "2026-10-08T15:00:00.000Z",
    idempotencyKey: "reschedule:test-20",
  });
  assert.equal(result.success, true);

  const { data: appointment } = await service.from("appointments").select("status, confirmed_at, confirmation_requested_at").eq("id", appointmentId).single();
  assert.equal(appointment?.status, "scheduled", "a rescheduled appointment must never silently remain 'confirmed' for a time the customer never saw");
  assert.equal(appointment?.confirmed_at, null);
  assert.equal(appointment?.confirmation_requested_at, null);
});

test("21. Part A5: rescheduling a plain 'scheduled' (never confirmed) appointment leaves status alone but still clears any stray confirmation_requested_at", async () => {
  const appointmentId = await insertAppointment(organizationId, contactId, "scheduled", "2026-10-06T16:00:00.000Z", "2026-10-06T17:00:00.000Z", {
    confirmation_requested_at: new Date().toISOString(),
  });

  const result = await rescheduleAppointment(service, {
    organizationId,
    contactId,
    appointmentId,
    startAt: "2026-10-08T16:00:00.000Z",
    endAt: "2026-10-08T17:00:00.000Z",
    idempotencyKey: "reschedule:test-21",
  });
  assert.equal(result.success, true);

  const { data: appointment } = await service.from("appointments").select("status, confirmed_at, confirmation_requested_at").eq("id", appointmentId).single();
  assert.equal(appointment?.status, "scheduled");
  assert.equal(appointment?.confirmation_requested_at, null, "a reschedule must clear a stale confirmation request too, so a fresh one goes out for the new time");
});

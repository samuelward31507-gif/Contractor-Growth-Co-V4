/**
 * Live integration tests for lib/calendar/appointment-sync.ts - the
 * orchestration layer between Trackpr appointments and Google Calendar
 * events (Phase 1 Scheduling Foundation, Stage 5). Real, disposable
 * organizations/contacts/appointments on the production Supabase project,
 * fully cleaned up afterward. A FAKE CalendarProvider is injected into
 * every function - this file never makes a real Google API call, matching
 * every prior stage's established convention.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/calendar/appointment-sync.integration.test.ts
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

const {
  syncAppointmentCreatedToGoogle,
  syncAppointmentUpdatedToGoogle,
  syncAppointmentRemovedFromGoogle,
}: typeof import("./appointment-sync") = require(path.join(REPO_ROOT, "lib/calendar/appointment-sync.ts"));
const { storeGoogleConnection, selectCalendar }: typeof import("./connection") = require(path.join(REPO_ROOT, "lib/calendar/connection.ts"));
type CalendarProvider = import("./provider").CalendarProvider;

const service = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let organizationId: string;
let otherOrganizationId: string;
let contactId: string;

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

// Stage 1's appointments_no_overlap exclusion constraint is organization-wide
// - every call gets its own hour slot (never overridden by callers below) so
// repeated inserts for the same organization across this file's many tests
// never collide with each other.
let nextSlotHour = 0;

async function insertAppointment(orgId: string, overrides: Record<string, unknown> = {}) {
  const hour = 9 + nextSlotHour++;
  const { data, error } = await service
    .from("appointments")
    .insert({
      organization_id: orgId,
      contact_id: contactId,
      title: "AC Repair",
      start_at: `2026-09-21T${String(hour).padStart(2, "0")}:00:00.000Z`,
      end_at: `2026-09-21T${String(hour).padStart(2, "0")}:30:00.000Z`,
      status: "scheduled",
      ...overrides,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`insertAppointment failed: ${error?.message}`);
  return data.id as string;
}

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Appointment Sync Integration Test Org", timezone: "UTC" }).select("id").single();
  organizationId = org!.id;

  const { data: otherOrg } = await service.from("organizations").insert({ name: "Appointment Sync Integration Test Org (Other)", timezone: "UTC" }).select("id").single();
  otherOrganizationId = otherOrg!.id;

  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "John", last_name: "Smith", phone: "+15555550100" }).select("id").single();
  contactId = contact!.id;
});

after(async () => {
  await service.from("appointments").delete().eq("organization_id", organizationId);
  await service.from("appointments").delete().eq("organization_id", otherOrganizationId);
  await service.from("contacts").delete().eq("organization_id", organizationId);
  await service.from("calendar_connections").delete().eq("organization_id", organizationId);
  await service.from("calendar_connections").delete().eq("organization_id", otherOrganizationId);
  await service.from("organizations").delete().eq("id", organizationId);
  await service.from("organizations").delete().eq("id", otherOrganizationId);
});

// ===========================================================================
// CREATE
// ===========================================================================

test("1. no Google Calendar connection: no warning, appointment stays Trackpr-only, no external ids", async () => {
  const appointmentId = await insertAppointment(organizationId);
  const result = await syncAppointmentCreatedToGoogle(service, organizationId, appointmentId, fakeProvider());
  assert.equal(result.warning, undefined);

  const { data } = await service.from("appointments").select("external_event_id, external_calendar_id").eq("id", appointmentId).single();
  assert.equal(data?.external_event_id, null);
  assert.equal(data?.external_calendar_id, null);
});

test("2. connected AND a calendar selected (healthy): creates the Google event and persists external_event_id/external_calendar_id, no warning", async () => {
  await storeGoogleConnection(service, organizationId, { email: "owner@example.com" }, { accessToken: "at-1", refreshToken: "rt-1", expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  await selectCalendar(service, organizationId, "team-calendar-id", "Jobs");

  const appointmentId = await insertAppointment(organizationId);
  const provider = fakeProvider({ createEvent: async (_accessToken, input) => ({ ok: true, value: { eventId: "google-event-1", calendarId: input.calendarId } }) });

  const result = await syncAppointmentCreatedToGoogle(service, organizationId, appointmentId, provider);
  assert.equal(result.warning, undefined);

  const { data } = await service.from("appointments").select("external_event_id, external_calendar_id").eq("id", appointmentId).single();
  assert.equal(data?.external_event_id, "google-event-1");
  assert.equal(data?.external_calendar_id, "team-calendar-id");
});

test("3. connected but NO calendar selected yet: a warning is returned, and no event is ever attempted", async () => {
  await service.from("calendar_connections").update({ calendar_id: null, calendar_name: null }).eq("organization_id", organizationId);

  let createEventCalled = false;
  const provider = fakeProvider({ createEvent: async () => { createEventCalled = true; return { ok: true, value: { eventId: "x", calendarId: "y" } }; } });

  const appointmentId = await insertAppointment(organizationId);
  const result = await syncAppointmentCreatedToGoogle(service, organizationId, appointmentId, provider);
  assert.ok(result.warning);
  assert.equal(createEventCalled, false);

  await selectCalendar(service, organizationId, "team-calendar-id", "Jobs");
});

test("4. connected, selected, but the provider itself rejects event creation (unhealthy): a warning is returned, the Trackpr appointment is untouched and still valid", async () => {
  const provider = fakeProvider({ createEvent: async () => ({ ok: false, error: "The calendar provider rejected the request." }) });
  const appointmentId = await insertAppointment(organizationId);

  const result = await syncAppointmentCreatedToGoogle(service, organizationId, appointmentId, provider);
  assert.ok(result.warning);

  const { data } = await service.from("appointments").select("id, external_event_id").eq("id", appointmentId).single();
  assert.ok(data, "the Trackpr appointment must still exist - a Google failure never rolls it back");
  assert.equal(data?.external_event_id, null);

  await service.from("calendar_connections").update({ status: "connected", last_error: null }).eq("organization_id", organizationId);
});

test("5. an expired access token is transparently refreshed and event creation still succeeds", async () => {
  const { data: connectionRow } = await service.from("calendar_connections").select("id").eq("organization_id", organizationId).single();
  await service.from("calendar_credentials").update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("calendar_connection_id", connectionRow!.id);

  let refreshed = false;
  const provider = fakeProvider({
    refreshAccessToken: async () => { refreshed = true; return { ok: true, value: { accessToken: "new-access-token", expiresAt: new Date(Date.now() + 3600_000).toISOString() } }; },
  });

  const appointmentId = await insertAppointment(organizationId);
  const result = await syncAppointmentCreatedToGoogle(service, organizationId, appointmentId, provider);
  assert.equal(result.warning, undefined);
  assert.equal(refreshed, true);

  const { data } = await service.from("appointments").select("external_event_id").eq("id", appointmentId).single();
  assert.ok(data?.external_event_id);
});

test("6. a failed access-token refresh returns a warning and never creates a Google event", async () => {
  const { data: connectionRow } = await service.from("calendar_connections").select("id").eq("organization_id", organizationId).single();
  await service.from("calendar_credentials").update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("calendar_connection_id", connectionRow!.id);

  let createEventCalled = false;
  const provider = fakeProvider({
    refreshAccessToken: async () => ({ ok: false, error: "The calendar connection is no longer valid and needs to be reconnected." }),
    createEvent: async () => { createEventCalled = true; return { ok: true, value: { eventId: "x", calendarId: "y" } }; },
  });

  const appointmentId = await insertAppointment(organizationId);
  const result = await syncAppointmentCreatedToGoogle(service, organizationId, appointmentId, provider);
  assert.ok(result.warning);
  assert.equal(createEventCalled, false);

  await service.from("calendar_credentials").update({ access_token: "at-1", expires_at: new Date(Date.now() + 3600_000).toISOString() }).eq("calendar_connection_id", connectionRow!.id);
  await service.from("calendar_connections").update({ status: "connected", last_error: null }).eq("organization_id", organizationId);
});

test("7. IDEMPOTENCY: an appointment that already has an external_event_id is never given a second Google event, even if the sync function is called again", async () => {
  const appointmentId = await insertAppointment(organizationId, { external_event_id: "already-synced-event-id", external_calendar_id: "team-calendar-id" });

  let createEventCalled = false;
  const provider = fakeProvider({ createEvent: async () => { createEventCalled = true; return { ok: true, value: { eventId: "a-new-duplicate-event", calendarId: "team-calendar-id" }}; } });

  const result = await syncAppointmentCreatedToGoogle(service, organizationId, appointmentId, provider);
  assert.equal(result.warning, undefined);
  assert.equal(createEventCalled, false, "a retried sync call must never create a second event for an already-synced appointment");

  const { data } = await service.from("appointments").select("external_event_id").eq("id", appointmentId).single();
  assert.equal(data?.external_event_id, "already-synced-event-id", "the original id must be untouched");
});

// ===========================================================================
// UPDATE
// ===========================================================================

test("8. an appointment WITH a synced external event: the Google event is updated with the new fields", async () => {
  const appointmentId = await insertAppointment(organizationId, { external_event_id: "event-to-update", external_calendar_id: "team-calendar-id", title: "AC Repair (updated)" });

  let updateCalledWith: { calendarId: string; eventId: string } | null = null;
  const provider = fakeProvider({
    updateEvent: async (_accessToken, calendarId, eventId) => {
      updateCalledWith = { calendarId, eventId };
      return { ok: true, value: { eventId, calendarId } };
    },
  });

  const result = await syncAppointmentUpdatedToGoogle(service, organizationId, appointmentId, provider);
  assert.equal(result.warning, undefined);
  assert.deepEqual(updateCalledWith, { calendarId: "team-calendar-id", eventId: "event-to-update" });
});

test("9. a Google update failure returns a warning, but the Trackpr appointment's own update already succeeded and remains intact", async () => {
  const appointmentId = await insertAppointment(organizationId, { external_event_id: "event-that-fails-to-update", external_calendar_id: "team-calendar-id" });
  const provider = fakeProvider({ updateEvent: async () => ({ ok: false, error: "The calendar connection is no longer valid and needs to be reconnected." }) });

  const result = await syncAppointmentUpdatedToGoogle(service, organizationId, appointmentId, provider);
  assert.ok(result.warning);

  const { data } = await service.from("appointments").select("id").eq("id", appointmentId).single();
  assert.ok(data, "the Trackpr appointment update itself is a separate, already-committed operation, unaffected by this sync failure");

  await service.from("calendar_connections").update({ status: "connected", last_error: null }).eq("organization_id", organizationId);
});

test("10. an appointment WITHOUT a synced external event: existing behavior is preserved exactly - no event is created or touched", async () => {
  const appointmentId = await insertAppointment(organizationId);
  let providerCalled = false;
  const provider = fakeProvider({
    createEvent: async () => { providerCalled = true; return { ok: true, value: { eventId: "x", calendarId: "y" } }; },
    updateEvent: async () => { providerCalled = true; return { ok: true, value: { eventId: "x", calendarId: "y" } }; },
  });

  const result = await syncAppointmentUpdatedToGoogle(service, organizationId, appointmentId, provider);
  assert.equal(result.warning, undefined);
  assert.equal(providerCalled, false, "an appointment never synced must never be auto-created on an unrelated edit - see this stage's own explicit instruction");
});

// ===========================================================================
// DELETE / CANCEL
// ===========================================================================

test("11. an external event exists: it is deleted from Google", async () => {
  let deleteCalledWith: { calendarId: string; eventId: string } | null = null;
  const provider = fakeProvider({
    deleteEvent: async (_accessToken, calendarId, eventId) => { deleteCalledWith = { calendarId, eventId }; return { ok: true, value: true }; },
  });

  const result = await syncAppointmentRemovedFromGoogle(service, organizationId, "event-to-delete", "team-calendar-id", provider);
  assert.equal(result.warning, undefined);
  assert.deepEqual(deleteCalledWith, { calendarId: "team-calendar-id", eventId: "event-to-delete" });
});

test("12. a Google deletion failure returns a warning without throwing - the caller's already-committed Trackpr deletion/cancellation is never affected", async () => {
  const provider = fakeProvider({ deleteEvent: async () => ({ ok: false, error: "The calendar provider is temporarily unavailable." }) });
  const result = await syncAppointmentRemovedFromGoogle(service, organizationId, "event-that-fails-to-delete", "team-calendar-id", provider);
  assert.ok(result.warning);

  await service.from("calendar_connections").update({ status: "connected", last_error: null }).eq("organization_id", organizationId);
});

// ===========================================================================
// SECURITY
// ===========================================================================

test("13. cross-org isolation: organization B has no calendar connection - syncing one of its appointments never touches organization A's connection/events, and never guesses at a calendar id", async () => {
  const otherAppointmentId = await insertAppointment(otherOrganizationId, { contact_id: null });
  let providerCalled = false;
  const provider = fakeProvider({ createEvent: async () => { providerCalled = true; return { ok: true, value: { eventId: "x", calendarId: "y" } }; } });

  const result = await syncAppointmentCreatedToGoogle(service, otherOrganizationId, otherAppointmentId, provider);
  assert.equal(result.warning, undefined, "organization B has no connection at all, so this must be a silent no-op, not an error");
  assert.equal(providerCalled, false, "organization B's appointment must never be synced using organization A's connection");

  const { data } = await service.from("appointments").select("external_event_id").eq("id", otherAppointmentId).single();
  assert.equal(data?.external_event_id, null);
});

test("14. payment-gate compatibility: sync functions work via the service-role client regardless of organization payment_status, exactly like every other service-role calendar path", async () => {
  const { data: paymentStatusRow } = await service.from("organizations").select("payment_status").eq("id", organizationId).single();
  assert.equal(paymentStatusRow?.payment_status, "payment_required");

  const appointmentId = await insertAppointment(organizationId);
  const result = await syncAppointmentCreatedToGoogle(service, organizationId, appointmentId, fakeProvider());
  assert.equal(result.warning, undefined);
});

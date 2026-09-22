/**
 * Live integration tests for getAvailableSlots() - the I/O loader half of
 * the Phase 1 Scheduling Foundation availability engine (Stage 2). Against
 * a disposable, fully-cleaned-up test organization on the real Supabase
 * project, matching this codebase's established pattern (e.g.
 * lib/appointments/overlap.integration.test.ts). The pure calculation core
 * (computeAvailableSlots) is already exhaustively covered by
 * availability.test.ts with zero DB dependency - this file exists
 * specifically to prove the real Supabase reads (getBookingSettings/
 * getBusinessHours/getOrganizationTimezone/the appointments query) are
 * wired correctly, not to re-prove the calculation logic itself.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/scheduling/availability.integration.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
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

const { createServiceRoleClient }: typeof import("@/lib/supabase/service") = require(path.join(REPO_ROOT, "lib/supabase/service.ts"));
const { getAvailableSlots }: typeof import("./availability") = require(path.join(REPO_ROOT, "lib/scheduling/availability.ts"));
const { storeGoogleConnection, selectCalendar }: typeof import("@/lib/calendar/connection") = require(path.join(REPO_ROOT, "lib/calendar/connection.ts"));
type CalendarProvider = import("@/lib/calendar/provider").CalendarProvider;

const service = createServiceRoleClient();

let organizationId: string;
let otherOrganizationId: string;
let calendarOrgId: string;
let otherCalendarOrgId: string;

const MON_FRI_9_5 = [
  { day_of_week: "monday", is_open: true, open_time: "09:00:00", close_time: "17:00:00" },
  { day_of_week: "tuesday", is_open: true, open_time: "09:00:00", close_time: "17:00:00" },
  { day_of_week: "wednesday", is_open: true, open_time: "09:00:00", close_time: "17:00:00" },
  { day_of_week: "thursday", is_open: true, open_time: "09:00:00", close_time: "17:00:00" },
  { day_of_week: "friday", is_open: true, open_time: "09:00:00", close_time: "17:00:00" },
  { day_of_week: "saturday", is_open: false, open_time: null, close_time: null },
  { day_of_week: "sunday", is_open: false, open_time: null, close_time: null },
];

// 2026-09-21 is a Monday.
const MONDAY_RANGE = { start: new Date("2026-09-21T00:00:00.000Z"), end: new Date("2026-09-22T00:00:00.000Z") };
const EARLY_MONDAY_MORNING = new Date("2026-09-21T00:00:00.000Z");

async function setBookingSettings(orgId: string, overrides: Record<string, unknown> = {}) {
  await service
    .from("booking_settings")
    .upsert({ organization_id: orgId, booking_enabled: true, minimum_notice_minutes: 0, default_duration_minutes: 60, buffer_minutes: 0, ...overrides }, { onConflict: "organization_id" });
}

async function setBusinessHours(orgId: string, hours: typeof MON_FRI_9_5) {
  await service.from("business_hours").delete().eq("organization_id", orgId);
  await service.from("business_hours").insert(hours.map((h) => ({ ...h, organization_id: orgId })));
}

async function insertAppointment(orgId: string, start: string, end: string, status = "scheduled") {
  await service.from("appointments").insert({ organization_id: orgId, title: "Test appointment", start_at: start, end_at: end, status });
}

before(async () => {
  // timezone: "UTC" explicitly - organizations.timezone defaults to
  // 'America/Denver' (confirmed by inspection), which would shift every
  // slot in this file's UTC-literal assertions by 6 hours for no reason
  // relevant to what these tests are actually checking. Timezone
  // conversion itself is already exhaustively covered by
  // availability.test.ts's own dedicated timezone/DST unit tests.
  const { data: org } = await service.from("organizations").insert({ name: "Availability Engine Integration Test Org", timezone: "UTC" }).select("id").single();
  organizationId = org!.id;

  const { data: otherOrg } = await service.from("organizations").insert({ name: "Availability Engine Integration Test Org (Other)", timezone: "UTC" }).select("id").single();
  otherOrganizationId = otherOrg!.id;

  // A separate pair of organizations for the Google Calendar tests below -
  // kept independent of organizationId/otherOrganizationId (which
  // accumulate appointment data across tests 1-7 above) so these tests can
  // reason about a clean slate.
  const { data: calendarOrg } = await service.from("organizations").insert({ name: "Availability Engine Integration Test Org (Calendar)", timezone: "UTC" }).select("id").single();
  calendarOrgId = calendarOrg!.id;
  await setBookingSettings(calendarOrgId);
  await setBusinessHours(calendarOrgId, MON_FRI_9_5);

  const { data: otherCalendarOrg } = await service.from("organizations").insert({ name: "Availability Engine Integration Test Org (Calendar, Other)", timezone: "UTC" }).select("id").single();
  otherCalendarOrgId = otherCalendarOrg!.id;
  await setBookingSettings(otherCalendarOrgId);
  await setBusinessHours(otherCalendarOrgId, MON_FRI_9_5);
});

after(async () => {
  await service.from("appointments").delete().eq("organization_id", organizationId);
  await service.from("appointments").delete().eq("organization_id", otherOrganizationId);
  await service.from("business_hours").delete().eq("organization_id", organizationId);
  await service.from("business_hours").delete().eq("organization_id", otherOrganizationId);
  await service.from("booking_settings").delete().eq("organization_id", organizationId);
  await service.from("booking_settings").delete().eq("organization_id", otherOrganizationId);
  await service.from("organizations").delete().eq("id", organizationId);
  await service.from("organizations").delete().eq("id", otherOrganizationId);

  await service.from("calendar_connections").delete().eq("organization_id", calendarOrgId);
  await service.from("calendar_connections").delete().eq("organization_id", otherCalendarOrgId);
  await service.from("business_hours").delete().eq("organization_id", calendarOrgId);
  await service.from("business_hours").delete().eq("organization_id", otherCalendarOrgId);
  await service.from("booking_settings").delete().eq("organization_id", calendarOrgId);
  await service.from("booking_settings").delete().eq("organization_id", otherCalendarOrgId);
  await service.from("organizations").delete().eq("id", calendarOrgId);
  await service.from("organizations").delete().eq("id", otherCalendarOrgId);
});

function fakeProvider(overrides: Partial<CalendarProvider> = {}): CalendarProvider {
  return {
    exchangeCode: async () => ({ ok: false, error: "not used in these tests" }),
    refreshAccessToken: async () => ({ ok: true, value: { accessToken: "refreshed-access-token", expiresAt: new Date(Date.now() + 3600_000).toISOString() } }),
    listCalendars: async () => ({ ok: true, value: [{ id: "primary", name: "owner@example.com", primary: true }] }),
    checkHealth: async () => ({ ok: true, value: true }),
    getBusyPeriods: async () => ({ ok: true, value: [] }),
    // Stage 5 additions to the CalendarProvider interface - unused by any
    // pre-existing test in this file, included only so this fake still
    // satisfies the interface.
    createEvent: async () => ({ ok: true, value: { eventId: "fake-event-id", calendarId: "fake-calendar-id" } }),
    updateEvent: async (_accessToken, calendarId, eventId) => ({ ok: true, value: { eventId, calendarId } }),
    deleteEvent: async () => ({ ok: true, value: true }),
    ...overrides,
  };
}

test("1. a freshly created organization (no booking_settings row saved yet) returns booking_disabled - the real DEFAULT_BOOKING_SETTINGS fallback, matching the column's own DB default of false", async () => {
  const result = await getAvailableSlots(service, { organizationId, dateRangeStart: MONDAY_RANGE.start, dateRangeEnd: MONDAY_RANGE.end }, EARLY_MONDAY_MORNING);
  assert.equal(result.status, "booking_disabled");
});

test("2. booking enabled but no business_hours rows saved yet returns business_hours_not_configured", async () => {
  await setBookingSettings(organizationId);
  const result = await getAvailableSlots(service, { organizationId, dateRangeStart: MONDAY_RANGE.start, dateRangeEnd: MONDAY_RANGE.end }, EARLY_MONDAY_MORNING);
  assert.equal(result.status, "business_hours_not_configured");
});

test("3. real booking_settings + real business_hours together produce real available slots", async () => {
  await setBookingSettings(organizationId);
  await setBusinessHours(organizationId, MON_FRI_9_5);
  const result = await getAvailableSlots(service, { organizationId, dateRangeStart: MONDAY_RANGE.start, dateRangeEnd: MONDAY_RANGE.end }, EARLY_MONDAY_MORNING);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.slots.length, 8);
  assert.equal(result.slots[0].start_at, "2026-09-21T09:00:00.000Z");
});

test("4. a real scheduled appointment removes its slot; a real confirmed and a real completed appointment do too", async () => {
  await insertAppointment(organizationId, "2026-09-21T10:00:00.000Z", "2026-09-21T11:00:00.000Z", "scheduled");
  await insertAppointment(organizationId, "2026-09-21T12:00:00.000Z", "2026-09-21T13:00:00.000Z", "confirmed");
  await insertAppointment(organizationId, "2026-09-21T14:00:00.000Z", "2026-09-21T15:00:00.000Z", "completed");

  const result = await getAvailableSlots(service, { organizationId, dateRangeStart: MONDAY_RANGE.start, dateRangeEnd: MONDAY_RANGE.end }, EARLY_MONDAY_MORNING);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  const starts = result.slots.map((s) => s.start_at);
  assert.ok(!starts.includes("2026-09-21T10:00:00.000Z"));
  assert.ok(!starts.includes("2026-09-21T12:00:00.000Z"));
  assert.ok(!starts.includes("2026-09-21T14:00:00.000Z"));
  assert.equal(result.slots.length, 5, "8 hourly slots minus the 3 occupied ones");
});

test("5. a real cancelled appointment and a real no_show appointment do NOT remove their slots", async () => {
  await insertAppointment(organizationId, "2026-09-21T09:00:00.000Z", "2026-09-21T10:00:00.000Z", "cancelled");
  await insertAppointment(organizationId, "2026-09-21T16:00:00.000Z", "2026-09-21T17:00:00.000Z", "no_show");

  const result = await getAvailableSlots(service, { organizationId, dateRangeStart: MONDAY_RANGE.start, dateRangeEnd: MONDAY_RANGE.end }, EARLY_MONDAY_MORNING);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  const starts = result.slots.map((s) => s.start_at);
  assert.ok(starts.includes("2026-09-21T09:00:00.000Z"), "cancelled must never occupy its slot");
  assert.ok(starts.includes("2026-09-21T16:00:00.000Z"), "no_show must never occupy its slot");
});

test("6. organization isolation: another organization's appointments, booking_settings, and business_hours never affect this organization's availability", async () => {
  await setBookingSettings(otherOrganizationId, { booking_enabled: true });
  await setBusinessHours(otherOrganizationId, MON_FRI_9_5);
  await insertAppointment(otherOrganizationId, "2026-09-21T09:00:00.000Z", "2026-09-21T10:00:00.000Z", "scheduled");

  const result = await getAvailableSlots(service, { organizationId, dateRangeStart: MONDAY_RANGE.start, dateRangeEnd: MONDAY_RANGE.end }, EARLY_MONDAY_MORNING);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.ok(result.slots.some((s) => s.start_at === "2026-09-21T09:00:00.000Z"), "the other organization's appointment must never block this organization's identical slot");
});

test("7. payment-gate compatibility: getAvailableSlots works via the service-role client regardless of the organization's payment_status - a fresh org defaults to payment_required, and this must still work exactly like every other service-role automation path", async () => {
  const { data: paymentStatusRow } = await service.from("organizations").select("payment_status").eq("id", organizationId).single();
  assert.equal(paymentStatusRow?.payment_status, "payment_required", "sanity check: this test org was never activated, matching every real new organization's default");

  const result = await getAvailableSlots(service, { organizationId, dateRangeStart: MONDAY_RANGE.start, dateRangeEnd: MONDAY_RANGE.end }, EARLY_MONDAY_MORNING);
  assert.equal(result.status, "available", "service-role reads must never be blocked by the payment gate, matching outbound-gate.ts/n8n-callback's existing exemption");
});

// ===========================================================================
// GOOGLE CALENDAR INTEGRATION (Phase 1 Scheduling Foundation, Stage 4)
// Real Supabase, a FAKE CalendarProvider injected as getAvailableSlots's
// 4th argument - never a real Google API call, matching Stage 3's
// established convention. Uses the dedicated calendarOrgId/otherCalendarOrgId
// pair set up in before() above.
// ===========================================================================

test("8. backward compatibility: an organization with NO Google Calendar connection gets exactly the same Trackpr-only availability as before Stage 4 - the connection lookup finding nothing must never change behavior", async () => {
  const result = await getAvailableSlots(service, { organizationId: calendarOrgId, dateRangeStart: MONDAY_RANGE.start, dateRangeEnd: MONDAY_RANGE.end }, EARLY_MONDAY_MORNING);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.slots.length, 8, "identical to Stage 2's own behavior - no calendar connected means no external conflicts at all");
});

test("9. a connected calendar with no calendar selected yet fails closed with calendar_unavailable - never silently falls back to Trackpr-only", async () => {
  const storeResult = await storeGoogleConnection(service, calendarOrgId, { email: "owner@example.com" }, { accessToken: "at-1", refreshToken: "rt-1", expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  assert.equal(storeResult.ok, true);

  const result = await getAvailableSlots(service, { organizationId: calendarOrgId, dateRangeStart: MONDAY_RANGE.start, dateRangeEnd: MONDAY_RANGE.end }, EARLY_MONDAY_MORNING);
  assert.equal(result.status, "calendar_unavailable");
});

test("10. a connected, selected, and healthy calendar merges its busy periods into real Trackpr-backed availability", async () => {
  await selectCalendar(service, calendarOrgId, "team-calendar-id", "Team Jobs");

  const provider = fakeProvider({ getBusyPeriods: async () => ({ ok: true, value: [{ start_at: "2026-09-21T13:00:00.000Z", end_at: "2026-09-21T14:00:00.000Z" }] }) });
  const result = await getAvailableSlots(service, { organizationId: calendarOrgId, dateRangeStart: MONDAY_RANGE.start, dateRangeEnd: MONDAY_RANGE.end }, EARLY_MONDAY_MORNING, provider);

  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.slots.length, 7, "8 hourly slots minus the 1 Google busy period");
  assert.ok(!result.slots.some((s) => s.start_at === "2026-09-21T13:00:00.000Z"));
});

test("11. a connected, selected, but UNHEALTHY calendar fails closed with calendar_unavailable and offers zero slots - never silently treated as an empty calendar", async () => {
  const provider = fakeProvider({ getBusyPeriods: async () => ({ ok: false, error: "The calendar connection is no longer valid and needs to be reconnected." }) });
  const result = await getAvailableSlots(service, { organizationId: calendarOrgId, dateRangeStart: MONDAY_RANGE.start, dateRangeEnd: MONDAY_RANGE.end }, EARLY_MONDAY_MORNING, provider);

  assert.equal(result.status, "calendar_unavailable");
  if (result.status === "calendar_unavailable") assert.equal(result.reason, "The calendar connection is no longer valid and needs to be reconnected.");

  // Confirm this failure was recorded via the existing safe status mechanism, not silently dropped.
  const { data: connectionRow } = await service.from("calendar_connections").select("status, last_error").eq("organization_id", calendarOrgId).single();
  assert.equal(connectionRow?.status, "error");
});

test("12. a failed token refresh (not just a provider-level failure) also fails closed with calendar_unavailable", async () => {
  const { data: connectionRow } = await service.from("calendar_connections").select("id").eq("organization_id", calendarOrgId).single();
  await service.from("calendar_credentials").update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("calendar_connection_id", connectionRow!.id);

  const provider = fakeProvider({ refreshAccessToken: async () => ({ ok: false, error: "The calendar connection is no longer valid and needs to be reconnected." }) });
  const result = await getAvailableSlots(service, { organizationId: calendarOrgId, dateRangeStart: MONDAY_RANGE.start, dateRangeEnd: MONDAY_RANGE.end }, EARLY_MONDAY_MORNING, provider);
  assert.equal(result.status, "calendar_unavailable");

  // Restore a valid token so this org doesn't interfere with anything after it in this file.
  await service.from("calendar_credentials").update({ access_token: "at-1", expires_at: new Date(Date.now() + 3600_000).toISOString() }).eq("calendar_connection_id", connectionRow!.id);
  await service.from("calendar_connections").update({ status: "connected", last_error: null }).eq("organization_id", calendarOrgId);
});

test("13. cross-org security: organization B's Google Calendar connection/busy periods can never affect organization A's availability, and vice versa - the organization id is always resolved server-side, never trusted from the caller for credential access", async () => {
  await storeGoogleConnection(service, otherCalendarOrgId, { email: "other-owner@example.com" }, { accessToken: "other-at-1", refreshToken: "other-rt-1", expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  await selectCalendar(service, otherCalendarOrgId, "other-team-calendar-id", "Other Team Jobs");

  let calendarIdRequestedForOrgB: string | undefined;
  const otherOrgProvider = fakeProvider({
    getBusyPeriods: async (_accessToken, calendarId) => {
      calendarIdRequestedForOrgB = calendarId;
      return { ok: true, value: [{ start_at: "2026-09-21T09:00:00.000Z", end_at: "2026-09-21T10:00:00.000Z" }] };
    },
  });

  const resultB = await getAvailableSlots(service, { organizationId: otherCalendarOrgId, dateRangeStart: MONDAY_RANGE.start, dateRangeEnd: MONDAY_RANGE.end }, EARLY_MONDAY_MORNING, otherOrgProvider);
  assert.equal(resultB.status, "available");
  if (resultB.status === "available") {
    assert.ok(!resultB.slots.some((s) => s.start_at === "2026-09-21T09:00:00.000Z"), "organization B's own busy period must block organization B's own slot");
  }
  assert.equal(calendarIdRequestedForOrgB, "other-team-calendar-id", "organization B's fetch must use organization B's own selected calendar id, never organization A's");

  // Organization A (calendarOrgId), restored to healthy above, must be
  // completely unaffected by organization B's connection/busy periods.
  const resultA = await getAvailableSlots(service, { organizationId: calendarOrgId, dateRangeStart: MONDAY_RANGE.start, dateRangeEnd: MONDAY_RANGE.end }, EARLY_MONDAY_MORNING, fakeProvider());
  assert.equal(resultA.status, "available");
  if (resultA.status === "available") {
    assert.ok(resultA.slots.some((s) => s.start_at === "2026-09-21T09:00:00.000Z"), "organization A's 09:00 slot must remain available - organization B's busy period must never leak across organizations");
  }
});

test("14. payment-gate compatibility for the Google-aware path: works via the service-role client for a payment_required organization, exactly like the Trackpr-only path", async () => {
  const { data: paymentStatusRow } = await service.from("organizations").select("payment_status").eq("id", calendarOrgId).single();
  assert.equal(paymentStatusRow?.payment_status, "payment_required");

  const result = await getAvailableSlots(service, { organizationId: calendarOrgId, dateRangeStart: MONDAY_RANGE.start, dateRangeEnd: MONDAY_RANGE.end }, EARLY_MONDAY_MORNING, fakeProvider());
  assert.equal(result.status, "available");
});

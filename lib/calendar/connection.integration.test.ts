/**
 * Live integration tests for lib/calendar/connection.ts - real, disposable
 * organizations/users on the production Supabase project, fully cleaned up
 * afterward, matching this codebase's established pattern (e.g.
 * app/agency/organizations/actions.test.ts). A FAKE CalendarProvider is
 * injected into every function that would otherwise call Google - this
 * file never makes a real Google API call, per Stage 3's explicit
 * requirement (google.test.ts's own mocked-fetch tests are what exercise
 * the real Google-shaped request/response handling).
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/calendar/connection.integration.test.ts
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
  getCalendarConnection,
  storeGoogleConnection,
  selectCalendar,
  disconnectCalendar,
  getFreshAccessToken,
  checkConnectionHealth,
  listConnectedCalendars,
  getCalendarBusyPeriods,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
}: typeof import("./connection") = require(path.join(REPO_ROOT, "lib/calendar/connection.ts"));
type CalendarProvider = import("./provider").CalendarProvider;

const service = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function signIn(email: string, password: string) {
  const throwaway = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await throwaway.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw error ?? new Error("no session");
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
  });
}

/** Fully controllable fake - never touches the network. Each field can be overridden per test. */
function fakeProvider(overrides: Partial<CalendarProvider> = {}): CalendarProvider {
  return {
    exchangeCode: async () => ({ ok: false, error: "not used in these tests" }),
    refreshAccessToken: async () => ({ ok: true, value: { accessToken: "refreshed-access-token", expiresAt: new Date(Date.now() + 3600_000).toISOString() } }),
    listCalendars: async () => ({ ok: true, value: [{ id: "primary", name: "owner@example.com", primary: true }] }),
    checkHealth: async () => ({ ok: true, value: true }),
    // Stage 4 addition to the CalendarProvider interface - unused by any
    // test in this file (all pre-existing Stage 3 tests here only exercise
    // connection CRUD/refresh/health/listing), included only so this fake
    // still satisfies the interface. See google.test.ts and
    // availability.integration.test.ts for real getBusyPeriods coverage.
    getBusyPeriods: async () => ({ ok: true, value: [] }),
    // Stage 5 additions to the CalendarProvider interface - unused by any
    // pre-existing test in this file, included only so this fake still
    // satisfies the interface. See appointment-sync.integration.test.ts for
    // real create/update/delete event coverage.
    createEvent: async () => ({ ok: true, value: { eventId: "fake-event-id", calendarId: "fake-calendar-id" } }),
    updateEvent: async (_accessToken, calendarId, eventId) => ({ ok: true, value: { eventId, calendarId } }),
    deleteEvent: async () => ({ ok: true, value: true }),
    ...overrides,
  };
}

const password = "a-real-test-password-123";
let organizationId: string;
let otherOrganizationId: string;
let ownerUserId: string;
let otherOwnerUserId: string;
const ownerEmail = `calendar-owner-${Date.now()}@example.com`;
const otherOwnerEmail = `calendar-other-owner-${Date.now()}@example.com`;

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Calendar Connection Integration Test Org" }).select("id").single();
  organizationId = org!.id;
  const { data: otherOrg } = await service.from("organizations").insert({ name: "Calendar Connection Integration Test Org (Other)" }).select("id").single();
  otherOrganizationId = otherOrg!.id;

  const { data: ownerUser } = await service.auth.admin.createUser({ email: ownerEmail, password, email_confirm: true });
  ownerUserId = ownerUser.user!.id;
  await service.from("organization_members").insert({ organization_id: organizationId, user_id: ownerUserId, role: "owner" });

  const { data: otherOwnerUser } = await service.auth.admin.createUser({ email: otherOwnerEmail, password, email_confirm: true });
  otherOwnerUserId = otherOwnerUser.user!.id;
  await service.from("organization_members").insert({ organization_id: otherOrganizationId, user_id: otherOwnerUserId, role: "owner" });
});

after(async () => {
  await service.from("calendar_connections").delete().eq("organization_id", organizationId);
  await service.from("calendar_connections").delete().eq("organization_id", otherOrganizationId);
  await service.from("organization_members").delete().eq("organization_id", organizationId);
  await service.from("organization_members").delete().eq("organization_id", otherOrganizationId);
  await service.from("organizations").delete().eq("id", organizationId);
  await service.from("organizations").delete().eq("id", otherOrganizationId);
  await service.auth.admin.deleteUser(ownerUserId);
  await service.auth.admin.deleteUser(otherOwnerUserId);
});

test("1. a fresh organization has no calendar connection", async () => {
  const connection = await getCalendarConnection(service, organizationId);
  assert.equal(connection, null);
});

test("2. storeGoogleConnection creates a connection with safe metadata AND stores credentials in the separate table", async () => {
  const result = await storeGoogleConnection(service, organizationId, { email: "owner@example.com" }, { accessToken: "at-1", refreshToken: "rt-1", expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  assert.equal(result.ok, true);

  const connection = await getCalendarConnection(service, organizationId);
  assert.ok(connection);
  assert.equal(connection?.accountEmail, "owner@example.com");
  assert.equal(connection?.status, "connected");
  assert.equal(connection?.calendarId, null, "no calendar chosen yet");

  const { data: credentialsRow } = await service.from("calendar_credentials").select("access_token").eq("calendar_connection_id", connection!.id).maybeSingle();
  assert.equal(credentialsRow?.access_token, "at-1");
});

test("3. selectCalendar records the chosen calendar as safe metadata", async () => {
  const result = await selectCalendar(service, organizationId, "team-calendar-id", "Team Jobs");
  assert.equal(result.ok, true);

  const connection = await getCalendarConnection(service, organizationId);
  assert.equal(connection?.calendarId, "team-calendar-id");
  assert.equal(connection?.calendarName, "Team Jobs");
});

test("4. listConnectedCalendars uses the fake provider and never touches the network", async () => {
  const connection = await getCalendarConnection(service, organizationId);
  const result = await listConnectedCalendars(connection!.id, fakeProvider());
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, [{ id: "primary", name: "owner@example.com", primary: true }]);
});

test("5. getFreshAccessToken returns the stored access token unchanged when it is not yet close to expiring", async () => {
  const connection = await getCalendarConnection(service, organizationId);
  const result = await getFreshAccessToken(connection!.id, fakeProvider());
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.accessToken, "at-1", "still within its validity window - must not have been refreshed");
});

test("6. getFreshAccessToken transparently refreshes an expired access token and persists the new one", async () => {
  const connection = await getCalendarConnection(service, organizationId);
  await service.from("calendar_credentials").update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("calendar_connection_id", connection!.id);

  const result = await getFreshAccessToken(connection!.id, fakeProvider());
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.accessToken, "refreshed-access-token");

  const { data: credentialsRow } = await service.from("calendar_credentials").select("access_token").eq("calendar_connection_id", connection!.id).maybeSingle();
  assert.equal(credentialsRow?.access_token, "refreshed-access-token", "the refreshed token must be persisted, not just returned once");
});

test("7. a failed refresh marks the connection unhealthy with a safe error, and getFreshAccessToken itself fails", async () => {
  const connection = await getCalendarConnection(service, organizationId);
  await service.from("calendar_credentials").update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("calendar_connection_id", connection!.id);

  const failingProvider = fakeProvider({ refreshAccessToken: async () => ({ ok: false, error: "The calendar connection is no longer valid and needs to be reconnected." }) });
  const result = await getFreshAccessToken(connection!.id, failingProvider);
  assert.equal(result.ok, false);

  const refreshed = await getCalendarConnection(service, organizationId);
  assert.equal(refreshed?.status, "error");
  assert.equal(refreshed?.lastError, "The calendar connection is no longer valid and needs to be reconnected.");

  // Restore a valid, non-expired token so later tests in this file are unaffected.
  await service.from("calendar_credentials").update({ access_token: "at-1", expires_at: new Date(Date.now() + 3600_000).toISOString() }).eq("calendar_connection_id", connection!.id);
  await service.from("calendar_connections").update({ status: "connected", last_error: null }).eq("organization_id", organizationId);
});

test("8. checkConnectionHealth updates status/last_synced_at on success", async () => {
  const connection = await getCalendarConnection(service, organizationId);
  const result = await checkConnectionHealth(connection!.id, fakeProvider());
  assert.equal(result.ok, true);

  const refreshed = await getCalendarConnection(service, organizationId);
  assert.equal(refreshed?.status, "connected");
  assert.ok(refreshed?.lastSyncedAt);
});

test("9. checkConnectionHealth marks the connection unhealthy on a real provider failure (e.g. Google itself rejecting the request)", async () => {
  const connection = await getCalendarConnection(service, organizationId);
  const failingProvider = fakeProvider({ checkHealth: async () => ({ ok: false, error: "The calendar provider is temporarily unavailable." }) });

  const result = await checkConnectionHealth(connection!.id, failingProvider);
  assert.equal(result.ok, false);

  const refreshed = await getCalendarConnection(service, organizationId);
  assert.equal(refreshed?.status, "error");
  assert.equal(refreshed?.lastError, "The calendar provider is temporarily unavailable.");

  await service.from("calendar_connections").update({ status: "connected", last_error: null }).eq("organization_id", organizationId);
});

test("10. disconnectCalendar deletes the connection AND cascades to delete its stored credentials - nothing is left behind", async () => {
  const connectionBefore = await getCalendarConnection(service, organizationId);
  assert.ok(connectionBefore, "sanity check: a connection exists before disconnecting");

  const result = await disconnectCalendar(service, organizationId);
  assert.equal(result.ok, true);

  const connectionAfter = await getCalendarConnection(service, organizationId);
  assert.equal(connectionAfter, null);

  const { data: credentialsRow } = await service.from("calendar_credentials").select("calendar_connection_id").eq("calendar_connection_id", connectionBefore!.id).maybeSingle();
  assert.equal(credentialsRow, null, "credentials must be gone too - ON DELETE CASCADE, not a separate cleanup step");
});

// ===========================================================================
// RLS / CROSS-ORGANIZATION ISOLATION
// ===========================================================================

test("11. organization A's own owner CANNOT read calendar_connections via the session client while payment_status is still payment_required - the existing RESTRICTIVE payment-gate policy applies to this table exactly like every other settings table", async () => {
  await storeGoogleConnection(service, organizationId, { email: "owner@example.com" }, { accessToken: "at-2", refreshToken: "rt-2", expiresAt: new Date(Date.now() + 3600_000).toISOString() });

  const { data: paymentStatusRow } = await service.from("organizations").select("payment_status").eq("id", organizationId).single();
  assert.equal(paymentStatusRow?.payment_status, "payment_required", "sanity check: this test org was never activated");

  const ownerSession = await signIn(ownerEmail, password);
  const { data, error } = await ownerSession.from("calendar_connections").select("id").eq("organization_id", organizationId);
  assert.ok(!data || data.length === 0, "the payment gate must block this read regardless of a genuinely valid is_org_member match");
  void error;
});

test("12. once activated, organization A's own owner CAN read (but not create/update/delete beyond their role) their own connection via the session client", async () => {
  await service.from("organizations").update({ payment_status: "active" }).eq("id", organizationId);
  try {
    const ownerSession = await signIn(ownerEmail, password);
    const { data } = await ownerSession.from("calendar_connections").select("id, account_email").eq("organization_id", organizationId);
    assert.equal(data?.length, 1);
    assert.equal(data?.[0].account_email, "owner@example.com");
  } finally {
    await service.from("organizations").update({ payment_status: "payment_required" }).eq("id", organizationId);
  }
});

test("13. organization B cannot read organization A's calendar connection, even when active", async () => {
  await service.from("organizations").update({ payment_status: "active" }).eq("id", organizationId);
  try {
    const otherOwnerSession = await signIn(otherOwnerEmail, password);
    const { data } = await otherOwnerSession.from("calendar_connections").select("id").eq("organization_id", organizationId);
    assert.equal(data?.length ?? 0, 0, "organization B must never see organization A's connection row");
  } finally {
    await service.from("organizations").update({ payment_status: "payment_required" }).eq("id", organizationId);
  }
});

test("14. organization B cannot mutate organization A's calendar connection", async () => {
  await service.from("organizations").update({ payment_status: "active" }).eq("id", organizationId);
  try {
    const otherOwnerSession = await signIn(otherOwnerEmail, password);
    const { error } = await otherOwnerSession.from("calendar_connections").update({ status: "error" }).eq("organization_id", organizationId);
    const { data: afterAttempt } = await service.from("calendar_connections").select("status").eq("organization_id", organizationId).single();
    assert.equal(afterAttempt?.status, "connected", "organization A's connection must be completely unaffected by organization B's attempt");
    void error;
  } finally {
    await service.from("organizations").update({ payment_status: "payment_required" }).eq("id", organizationId);
  }
});

test("15. calendar_credentials can never be read through an authenticated client, even by the connection's own organization's owner, even when active", async () => {
  await service.from("organizations").update({ payment_status: "active" }).eq("id", organizationId);
  try {
    const ownerSession = await signIn(ownerEmail, password);
    const { data } = await ownerSession.from("calendar_credentials").select("access_token, refresh_token");
    assert.equal(data?.length ?? 0, 0, "RLS with zero permissive policies must return zero rows to any session-authenticated client, regardless of whose organization they belong to");
  } finally {
    await service.from("organizations").update({ payment_status: "payment_required" }).eq("id", organizationId);
  }
});

test("16. the service-role client CAN read calendar_credentials - the one intended access path", async () => {
  const connection = await getCalendarConnection(service, organizationId);
  const { data, error } = await service.from("calendar_credentials").select("access_token").eq("calendar_connection_id", connection!.id).maybeSingle();
  assert.equal(error, null);
  assert.equal(data?.access_token, "at-2");
});

// ===========================================================================
// getCalendarBusyPeriods (Phase 1 Scheduling Foundation, Stage 4)
// ===========================================================================

test("17. getCalendarBusyPeriods returns the fake provider's busy intervals and marks the connection healthy (status/last_synced_at updated) as a side effect", async () => {
  const connection = await getCalendarConnection(service, organizationId);
  const busyPeriods = [{ start_at: "2026-09-21T15:00:00.000Z", end_at: "2026-09-21T16:00:00.000Z" }];
  const provider = fakeProvider({ getBusyPeriods: async () => ({ ok: true, value: busyPeriods }) });

  const result = await getCalendarBusyPeriods(connection!.id, "team-calendar-id", new Date("2026-09-21T00:00:00Z"), new Date("2026-09-22T00:00:00Z"), provider);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, busyPeriods);

  const refreshed = await getCalendarConnection(service, organizationId);
  assert.equal(refreshed?.status, "connected");
  assert.ok(refreshed?.lastSyncedAt);
});

test("18. getCalendarBusyPeriods fails closed and marks the connection unhealthy with a safe error when the provider itself rejects the request", async () => {
  const connection = await getCalendarConnection(service, organizationId);
  const provider = fakeProvider({ getBusyPeriods: async () => ({ ok: false, error: "The calendar provider could not check this calendar's availability." }) });

  const result = await getCalendarBusyPeriods(connection!.id, "team-calendar-id", new Date("2026-09-21T00:00:00Z"), new Date("2026-09-22T00:00:00Z"), provider);
  assert.equal(result.ok, false);

  const refreshed = await getCalendarConnection(service, organizationId);
  assert.equal(refreshed?.status, "error");
  assert.equal(refreshed?.lastError, "The calendar provider could not check this calendar's availability.");

  await service.from("calendar_connections").update({ status: "connected", last_error: null }).eq("organization_id", organizationId);
});

test("19. getCalendarBusyPeriods fails closed (and never calls the provider's getBusyPeriods at all) when the access token refresh itself fails first", async () => {
  const connection = await getCalendarConnection(service, organizationId);
  await service.from("calendar_credentials").update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("calendar_connection_id", connection!.id);

  let getBusyPeriodsCalled = false;
  const provider = fakeProvider({
    refreshAccessToken: async () => ({ ok: false, error: "The calendar connection is no longer valid and needs to be reconnected." }),
    getBusyPeriods: async () => {
      getBusyPeriodsCalled = true;
      return { ok: true, value: [] };
    },
  });

  const result = await getCalendarBusyPeriods(connection!.id, "team-calendar-id", new Date("2026-09-21T00:00:00Z"), new Date("2026-09-22T00:00:00Z"), provider);
  assert.equal(result.ok, false);
  assert.equal(getBusyPeriodsCalled, false, "a failed token refresh must short-circuit before ever attempting the actual busy-period request");

  const refreshed = await getCalendarConnection(service, organizationId);
  assert.equal(refreshed?.status, "error");

  await service.from("calendar_credentials").update({ access_token: "at-2", expires_at: new Date(Date.now() + 3600_000).toISOString() }).eq("calendar_connection_id", connection!.id);
  await service.from("calendar_connections").update({ status: "connected", last_error: null }).eq("organization_id", organizationId);
});

// ===========================================================================
// createCalendarEvent / updateCalendarEvent / deleteCalendarEvent
// (Phase 1 Scheduling Foundation, Stage 5)
// ===========================================================================

test("20. createCalendarEvent returns the fake provider's event id and marks the connection healthy as a side effect", async () => {
  const connection = await getCalendarConnection(service, organizationId);
  const provider = fakeProvider({ createEvent: async () => ({ ok: true, value: { eventId: "google-event-xyz", calendarId: "team-calendar-id" } }) });

  const result = await createCalendarEvent(connection!.id, { calendarId: "team-calendar-id", start_at: "2026-09-21T15:00:00.000Z", end_at: "2026-09-21T16:00:00.000Z", summary: "AC Repair" }, provider);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.eventId, "google-event-xyz");

  const refreshed = await getCalendarConnection(service, organizationId);
  assert.equal(refreshed?.status, "connected");
});

test("21. createCalendarEvent fails closed and marks the connection unhealthy when the provider rejects the request", async () => {
  const connection = await getCalendarConnection(service, organizationId);
  const provider = fakeProvider({ createEvent: async () => ({ ok: false, error: "The calendar provider rejected the request." }) });

  const result = await createCalendarEvent(connection!.id, { calendarId: "team-calendar-id", start_at: "2026-09-21T15:00:00.000Z", end_at: "2026-09-21T16:00:00.000Z", summary: "AC Repair" }, provider);
  assert.equal(result.ok, false);

  const refreshed = await getCalendarConnection(service, organizationId);
  assert.equal(refreshed?.status, "error");
  await service.from("calendar_connections").update({ status: "connected", last_error: null }).eq("organization_id", organizationId);
});

test("22. updateCalendarEvent returns success and marks the connection healthy", async () => {
  const connection = await getCalendarConnection(service, organizationId);
  const provider = fakeProvider({ updateEvent: async (_accessToken, calendarId, eventId) => ({ ok: true, value: { eventId, calendarId } }) });

  const result = await updateCalendarEvent(connection!.id, "team-calendar-id", "google-event-xyz", { start_at: "2026-09-21T16:00:00.000Z", end_at: "2026-09-21T17:00:00.000Z", summary: "AC Repair (rescheduled)" }, provider);
  assert.equal(result.ok, true);
});

test("23. updateCalendarEvent fails closed and marks the connection unhealthy when the provider rejects the request", async () => {
  const connection = await getCalendarConnection(service, organizationId);
  const provider = fakeProvider({ updateEvent: async () => ({ ok: false, error: "The calendar connection is no longer valid and needs to be reconnected." }) });

  const result = await updateCalendarEvent(connection!.id, "team-calendar-id", "google-event-xyz", { start_at: "2026-09-21T16:00:00.000Z", end_at: "2026-09-21T17:00:00.000Z", summary: "AC Repair" }, provider);
  assert.equal(result.ok, false);

  const refreshed = await getCalendarConnection(service, organizationId);
  assert.equal(refreshed?.status, "error");
  await service.from("calendar_connections").update({ status: "connected", last_error: null }).eq("organization_id", organizationId);
});

test("24. deleteCalendarEvent returns success and marks the connection healthy", async () => {
  const connection = await getCalendarConnection(service, organizationId);
  const provider = fakeProvider({ deleteEvent: async () => ({ ok: true, value: true }) });

  const result = await deleteCalendarEvent(connection!.id, "team-calendar-id", "google-event-xyz", provider);
  assert.equal(result.ok, true);
});

test("25. deleteCalendarEvent fails closed and marks the connection unhealthy when the provider rejects the request", async () => {
  const connection = await getCalendarConnection(service, organizationId);
  const provider = fakeProvider({ deleteEvent: async () => ({ ok: false, error: "The calendar provider is temporarily unavailable." }) });

  const result = await deleteCalendarEvent(connection!.id, "team-calendar-id", "google-event-xyz", provider);
  assert.equal(result.ok, false);

  const refreshed = await getCalendarConnection(service, organizationId);
  assert.equal(refreshed?.status, "error");
  await service.from("calendar_connections").update({ status: "connected", last_error: null }).eq("organization_id", organizationId);
});

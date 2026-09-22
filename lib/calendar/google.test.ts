/**
 * Unit tests for googleCalendarProvider (lib/calendar/google.ts) - global
 * fetch() is replaced with a controlled fake for every test in this file
 * and restored afterward; NO test here ever makes a real network call,
 * per Stage 3's explicit "mock/fake the provider boundary" requirement.
 * Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/calendar/google.test.ts
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { googleCalendarProvider, GOOGLE_CALENDAR_OAUTH_SCOPES }: typeof import("./google") = require("./google.ts");

const realFetch = globalThis.fetch;
let fetchCalls: { url: string; init: RequestInit }[] = [];
let mockResponses: Map<string, { status: number; body: unknown }> = new Map();

function urlKey(url: string): string {
  return new URL(url).pathname;
}

function mockFetch(pathname: string, response: { status: number; body: unknown }) {
  mockResponses.set(pathname, response);
}

before(() => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    fetchCalls.push({ url, init: init ?? {} });
    const mocked = mockResponses.get(urlKey(url));
    if (!mocked) throw new Error(`Unmocked fetch call in test to ${url} - this test suite must never hit the real network.`);
    return new Response(JSON.stringify(mocked.body), { status: mocked.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  process.env.GOOGLE_CALENDAR_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "test-client-secret";
});

after(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  fetchCalls = [];
  mockResponses = new Map();
});

test("1. exchangeCode: a successful token exchange + userinfo lookup returns tokens and the account email", async () => {
  mockFetch("/token", { status: 200, body: { access_token: "fake-access-token", refresh_token: "fake-refresh-token", expires_in: 3600 } });
  mockFetch("/v1/userinfo", { status: 200, body: { email: "owner@example.com" } });

  const result = await googleCalendarProvider.exchangeCode("auth-code-123", "https://example.com/callback");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.tokens.accessToken, "fake-access-token");
  assert.equal(result.value.tokens.refreshToken, "fake-refresh-token");
  assert.equal(result.value.account.email, "owner@example.com");
  assert.equal(fetchCalls.length, 2, "exactly one token-exchange call and one userinfo call - no extra requests");
});

test("2. exchangeCode: a token response missing refresh_token (e.g. a reconsent Google didn't force) is a safe, generic error, not a crash", async () => {
  mockFetch("/token", { status: 200, body: { access_token: "fake-access-token", expires_in: 3600 } });

  const result = await googleCalendarProvider.exchangeCode("auth-code-123", "https://example.com/callback");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.error.length > 0);
  assert.ok(!result.error.includes("fake-access-token"), "no token value must ever appear in an error message");
});

test("3. exchangeCode: an invalid_grant response from Google's token endpoint maps to a safe, fixed message - never Google's raw error body", async () => {
  mockFetch("/token", { status: 400, body: { error: "invalid_grant", error_description: "Malformed auth code AQABC123SECRETDETAIL" } });

  const result = await googleCalendarProvider.exchangeCode("bad-code", "https://example.com/callback");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "The calendar connection is no longer valid and needs to be reconnected.");
  assert.ok(!result.error.includes("AQABC123SECRETDETAIL"), "Google's raw error_description must never be forwarded");
});

test("4. exchangeCode: with GOOGLE_CALENDAR_CLIENT_ID/SECRET unset, returns a safe 'not configured' error and makes zero network calls", async () => {
  const savedId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
  const savedSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  delete process.env.GOOGLE_CALENDAR_CLIENT_ID;
  delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET;

  try {
    const result = await googleCalendarProvider.exchangeCode("auth-code-123", "https://example.com/callback");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "Google Calendar is not configured.");
    assert.equal(fetchCalls.length, 0, "an unconfigured provider must never attempt any network call");
  } finally {
    process.env.GOOGLE_CALENDAR_CLIENT_ID = savedId;
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = savedSecret;
  }
});

test("5. refreshAccessToken: a successful refresh returns a new access token and expiry, and never returns a new refresh_token field at all", async () => {
  mockFetch("/token", { status: 200, body: { access_token: "new-access-token", expires_in: 3600 } });

  const result = await googleCalendarProvider.refreshAccessToken("stored-refresh-token");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.accessToken, "new-access-token");
  assert.ok(!("refreshToken" in result.value), "refreshAccessToken's return type has no refreshToken field - Google only issues one at initial consent");
});

test("6. refreshAccessToken: a failed refresh (expired/revoked refresh token) is a safe error", async () => {
  mockFetch("/token", { status: 400, body: { error: "invalid_grant" } });

  const result = await googleCalendarProvider.refreshAccessToken("revoked-refresh-token");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "The calendar connection is no longer valid and needs to be reconnected.");
});

test("7. listCalendars: parses real calendar items and silently drops any entry missing an id, rather than crashing on a malformed response", async () => {
  mockFetch("/calendar/v3/users/me/calendarList", {
    status: 200,
    body: {
      items: [
        { id: "owner@example.com", summary: "owner@example.com", primary: true },
        { id: "team-calendar-id", summary: "Team Jobs" },
        { summary: "Malformed entry with no id" },
      ],
    },
  });

  const result = await googleCalendarProvider.listCalendars("fake-access-token");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.length, 2);
  assert.equal(result.value[0].primary, true);
  assert.equal(result.value[1].name, "Team Jobs");
});

test("8. listCalendars: a calendar with no summary falls back to its id as the display name", async () => {
  mockFetch("/calendar/v3/users/me/calendarList", { status: 200, body: { items: [{ id: "raw-calendar-id" }] } });

  const result = await googleCalendarProvider.listCalendars("fake-access-token");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value[0].name, "raw-calendar-id");
});

test("9. checkHealth: succeeds when the provider responds normally", async () => {
  mockFetch("/calendar/v3/users/me/calendarList", { status: 200, body: { items: [] } });
  const result = await googleCalendarProvider.checkHealth("fake-access-token");
  assert.equal(result.ok, true);
});

test("10. checkHealth: an expired/invalid access token (401) is a safe, specific 'needs reconnect' error", async () => {
  mockFetch("/calendar/v3/users/me/calendarList", { status: 401, body: { error: "invalid_token" } });
  const result = await googleCalendarProvider.checkHealth("expired-access-token");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "The calendar connection is no longer valid and needs to be reconnected.");
});

test("11. a network-level failure (fetch itself throws, e.g. DNS/timeout) is a safe, generic error, never an uncaught exception", async () => {
  globalThis.fetch = (async () => {
    throw new Error("getaddrinfo ENOTFOUND oauth2.googleapis.com");
  }) as typeof fetch;

  try {
    const result = await googleCalendarProvider.refreshAccessToken("some-refresh-token");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "Could not reach the calendar provider.");
  } finally {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      fetchCalls.push({ url, init: init ?? {} });
      const mocked = mockResponses.get(urlKey(url));
      if (!mocked) throw new Error(`Unmocked fetch call in test to ${url}`);
      return new Response(JSON.stringify(mocked.body), { status: mocked.status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  }
});

test("12. the requested OAuth scopes are the minimum Phase 1 needs - identity plus full calendar read/write, nothing broader", () => {
  assert.deepEqual(GOOGLE_CALENDAR_OAUTH_SCOPES, ["openid", "email", "https://www.googleapis.com/auth/calendar"]);
});

// ===========================================================================
// getBusyPeriods (Phase 1 Scheduling Foundation, Stage 4)
// ===========================================================================

test("13. getBusyPeriods: parses real freebusy intervals and normalizes them to UTC ISO 8601", async () => {
  mockFetch("/calendar/v3/freeBusy", {
    status: 200,
    body: { calendars: { "owner@example.com": { busy: [{ start: "2026-09-21T15:00:00Z", end: "2026-09-21T16:00:00Z" }] } } },
  });

  const result = await googleCalendarProvider.getBusyPeriods("fake-access-token", "owner@example.com", "2026-09-21T00:00:00Z", "2026-09-22T00:00:00Z");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value, [{ start_at: "2026-09-21T15:00:00.000Z", end_at: "2026-09-21T16:00:00.000Z" }]);
});

test("14. getBusyPeriods: the POST body requests exactly the one calendar and range asked for - never every calendar on the account", async () => {
  mockFetch("/calendar/v3/freeBusy", { status: 200, body: { calendars: { "team-calendar-id": { busy: [] } } } });

  await googleCalendarProvider.getBusyPeriods("fake-access-token", "team-calendar-id", "2026-09-21T00:00:00Z", "2026-09-22T00:00:00Z");
  assert.equal(fetchCalls.length, 1);
  const sentBody = JSON.parse(fetchCalls[0].init.body as string);
  assert.deepEqual(sentBody, { timeMin: "2026-09-21T00:00:00Z", timeMax: "2026-09-22T00:00:00Z", items: [{ id: "team-calendar-id" }] });
});

test("15. getBusyPeriods: a non-UTC offset in Google's response is still normalized correctly to the same absolute UTC instant", async () => {
  mockFetch("/calendar/v3/freeBusy", {
    status: 200,
    body: { calendars: { "owner@example.com": { busy: [{ start: "2026-09-21T09:00:00-06:00", end: "2026-09-21T10:00:00-06:00" }] } } },
  });

  const result = await googleCalendarProvider.getBusyPeriods("fake-access-token", "owner@example.com", "2026-09-21T00:00:00Z", "2026-09-22T00:00:00Z");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value[0].start_at, "2026-09-21T15:00:00.000Z", "09:00-06:00 must normalize to 15:00 UTC");
});

test("16. getBusyPeriods: silently drops a malformed busy entry (missing start/end) rather than crashing", async () => {
  mockFetch("/calendar/v3/freeBusy", {
    status: 200,
    body: { calendars: { "owner@example.com": { busy: [{ start: "2026-09-21T15:00:00Z", end: "2026-09-21T16:00:00Z" }, { start: "not-a-real-instant" }] } } },
  });

  const result = await googleCalendarProvider.getBusyPeriods("fake-access-token", "owner@example.com", "2026-09-21T00:00:00Z", "2026-09-22T00:00:00Z");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.length, 1, "the malformed entry must be dropped, not crash the whole response");
});

test("17. getBusyPeriods: a per-calendar error inside a 200 response (e.g. the calendar was deleted or access revoked) is a safe, generic failure, never forwarded verbatim", async () => {
  mockFetch("/calendar/v3/freeBusy", {
    status: 200,
    body: { calendars: { "deleted-calendar-id": { errors: [{ domain: "calendar", reason: "notFound" }] } } },
  });

  const result = await googleCalendarProvider.getBusyPeriods("fake-access-token", "deleted-calendar-id", "2026-09-21T00:00:00Z", "2026-09-22T00:00:00Z");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "The calendar provider could not check this calendar's availability.");
});

test("18. getBusyPeriods: the requested calendar id missing entirely from the response is a safe failure, not a crash reading undefined", async () => {
  mockFetch("/calendar/v3/freeBusy", { status: 200, body: { calendars: {} } });

  const result = await googleCalendarProvider.getBusyPeriods("fake-access-token", "some-calendar-id", "2026-09-21T00:00:00Z", "2026-09-22T00:00:00Z");
  assert.equal(result.ok, false);
});

test("19. getBusyPeriods: multiple, adjacent, and overlapping busy intervals are all returned as-is - merging/deduplication is the scheduling engine's job, not the provider's", async () => {
  mockFetch("/calendar/v3/freeBusy", {
    status: 200,
    body: {
      calendars: {
        "owner@example.com": {
          busy: [
            { start: "2026-09-21T10:00:00Z", end: "2026-09-21T11:00:00Z" },
            { start: "2026-09-21T11:00:00Z", end: "2026-09-21T12:00:00Z" },
            { start: "2026-09-21T11:30:00Z", end: "2026-09-21T13:00:00Z" },
          ],
        },
      },
    },
  });

  const result = await googleCalendarProvider.getBusyPeriods("fake-access-token", "owner@example.com", "2026-09-21T00:00:00Z", "2026-09-22T00:00:00Z");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.length, 3);
});

// ===========================================================================
// createEvent / updateEvent / deleteEvent (Phase 1 Scheduling Foundation, Stage 5)
// ===========================================================================

test("20. createEvent: a successful creation returns the real Google event id and echoes back the calendar id", async () => {
  mockFetch("/calendar/v3/calendars/owner%40example.com/events", { status: 200, body: { id: "google-event-abc123" } });

  const result = await googleCalendarProvider.createEvent("fake-access-token", {
    calendarId: "owner@example.com",
    start_at: "2026-09-21T15:00:00.000Z",
    end_at: "2026-09-21T16:00:00.000Z",
    summary: "AC Repair",
    description: "Trackpr appointment for John Smith.",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.eventId, "google-event-abc123");
  assert.equal(result.value.calendarId, "owner@example.com");
});

test("21. createEvent: the request body contains only summary/start/end when no description is given - never any extra field", async () => {
  mockFetch("/calendar/v3/calendars/owner%40example.com/events", { status: 200, body: { id: "google-event-abc123" } });

  await googleCalendarProvider.createEvent("fake-access-token", {
    calendarId: "owner@example.com",
    start_at: "2026-09-21T15:00:00.000Z",
    end_at: "2026-09-21T16:00:00.000Z",
    summary: "AC Repair",
  });
  const sentBody = JSON.parse(fetchCalls[0].init.body as string);
  assert.deepEqual(Object.keys(sentBody).sort(), ["end", "start", "summary"], "an omitted optional description must not appear in the request body at all");
  assert.equal(sentBody.start.dateTime, "2026-09-21T15:00:00.000Z");
  assert.equal(sentBody.end.dateTime, "2026-09-21T16:00:00.000Z");
});

test("22. createEvent: a calendar id containing '@' (a real Google account email, the common case for a primary calendar) is correctly URL-encoded in the request path", async () => {
  mockFetch("/calendar/v3/calendars/owner%40example.com/events", { status: 200, body: { id: "google-event-abc123" } });

  await googleCalendarProvider.createEvent("fake-access-token", { calendarId: "owner@example.com", start_at: "2026-09-21T15:00:00.000Z", end_at: "2026-09-21T16:00:00.000Z", summary: "AC Repair" });
  assert.ok(fetchCalls[0].url.includes("owner%40example.com"), "the '@' must be percent-encoded in the actual request URL");
});

test("23. createEvent: a missing event id in Google's response is a safe failure, not a crash", async () => {
  mockFetch("/calendar/v3/calendars/owner%40example.com/events", { status: 200, body: {} });

  const result = await googleCalendarProvider.createEvent("fake-access-token", { calendarId: "owner@example.com", start_at: "2026-09-21T15:00:00.000Z", end_at: "2026-09-21T16:00:00.000Z", summary: "AC Repair" });
  assert.equal(result.ok, false);
});

test("24. updateEvent: a successful update echoes back the same event/calendar ids and sends the same minimal body shape as createEvent", async () => {
  mockFetch("/calendar/v3/calendars/owner%40example.com/events/google-event-abc123", { status: 200, body: { id: "google-event-abc123" } });

  const result = await googleCalendarProvider.updateEvent("fake-access-token", "owner@example.com", "google-event-abc123", {
    start_at: "2026-09-21T16:00:00.000Z",
    end_at: "2026-09-21T17:00:00.000Z",
    summary: "AC Repair (rescheduled)",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.eventId, "google-event-abc123");
  assert.equal(fetchCalls[0].init.method, "PATCH");
});

test("25. updateEvent: a 404 (the event no longer exists on Google, e.g. manually deleted) is a real failure here, distinct from deleteEvent's own idempotent-success treatment", async () => {
  mockFetch("/calendar/v3/calendars/owner%40example.com/events/deleted-event-id", { status: 404, body: { error: "notFound" } });

  const result = await googleCalendarProvider.updateEvent("fake-access-token", "owner@example.com", "deleted-event-id", { start_at: "2026-09-21T16:00:00.000Z", end_at: "2026-09-21T17:00:00.000Z", summary: "AC Repair" });
  assert.equal(result.ok, false, "updating an event that no longer exists must be reported as a failure, not silently treated as success");
});

test("26. deleteEvent: a successful deletion (204 No Content, no JSON body) is handled correctly", async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    fetchCalls.push({ url, init: {} });
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  const result = await googleCalendarProvider.deleteEvent("fake-access-token", "owner@example.com", "google-event-abc123");
  assert.equal(result.ok, true);
});

test("27. deleteEvent: a 404 (already gone) is treated as SUCCESS, not failure - idempotent by design", async () => {
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  const result = await googleCalendarProvider.deleteEvent("fake-access-token", "owner@example.com", "already-deleted-event-id");
  assert.equal(result.ok, true, "a delete for an event that's already gone must succeed - the desired end state is already true");
});

test("28. deleteEvent: a 410 (Gone - Google's own 'permanently removed' status) is also treated as SUCCESS", async () => {
  globalThis.fetch = (async () => new Response(null, { status: 410 })) as typeof fetch;
  const result = await googleCalendarProvider.deleteEvent("fake-access-token", "owner@example.com", "gone-event-id");
  assert.equal(result.ok, true);
});

test("29. deleteEvent: a real failure (e.g. 401/403/500) is still reported as a failure, not silently swallowed like 404/410 are", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "invalid_token" }), { status: 401 })) as typeof fetch;
  const result = await googleCalendarProvider.deleteEvent("fake-access-token", "owner@example.com", "some-event-id");
  assert.equal(result.ok, false);

  // Restore the shared mock fetch for any tests that might run after this one in the same process.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    fetchCalls.push({ url, init: init ?? {} });
    const mocked = mockResponses.get(urlKey(url));
    if (!mocked) throw new Error(`Unmocked fetch call in test to ${url}`);
    return new Response(JSON.stringify(mocked.body), { status: mocked.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

import type { CalendarProvider, CalendarProviderResult, CalendarAccount, CalendarListItem, CalendarTokens, BusyInterval, CalendarEventInput, CalendarEventResult } from "./provider";

/**
 * Google Calendar implementation of CalendarProvider - plain fetch() calls
 * to Google's own REST endpoints (OAuth 2.0 token endpoint, OpenID Connect
 * userinfo endpoint, Calendar API v3), the same "no SDK, one dispatch
 * boundary" style this codebase already uses for n8n
 * (lib/automation/n8n.ts's triggerN8nWorkflow) - deliberately not the
 * `googleapis` package (a very large dependency for what is, for Phase 1's
 * actual needs, a handful of simple JSON REST calls) and not a lighter
 * auth-only library either, to avoid adding any new dependency at all for
 * a stage that doesn't need one. Every Google-specific detail (endpoint
 * URLs, request/response shapes, error-code mapping) is isolated to this
 * one file - lib/calendar/connection.ts and every route/action above it
 * only ever see the provider-agnostic CalendarProvider interface.
 */

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const CALENDAR_LIST_ENDPOINT = "https://www.googleapis.com/calendar/v3/users/me/calendarList";
const FREEBUSY_ENDPOINT = "https://www.googleapis.com/calendar/v3/freeBusy";
const GOOGLE_API_TIMEOUT_MS = 10_000;

function eventsUrl(calendarId: string, eventId?: string): string {
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  return eventId ? `${base}/${encodeURIComponent(eventId)}` : base;
}

/** The exact body shape both createEvent and updateEvent send - a single source of truth so the two can never drift apart in what fields they set. */
function eventRequestBody(input: Omit<CalendarEventInput, "calendarId">): Record<string, unknown> {
  return {
    summary: input.summary,
    description: input.description,
    start: { dateTime: input.start_at },
    end: { dateTime: input.end_at },
  };
}

/** The minimum scopes for Phase 1's full scope (Stage 3's connection/identity/listing needs, plus the event read/write Stage 4/5 will need under the same consent - requesting a second, narrower scope now would just force a second re-consent flow later). */
export const GOOGLE_CALENDAR_OAUTH_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar"];

function getGoogleOAuthConfig(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * Translates a raw Google OAuth/Calendar API error into a safe, generic
 * message - the same allowlist-of-known-causes convention
 * lib/automation/executions.ts's mapExecutionRpcError already established
 * for this codebase's own RPC errors. Google's raw error bodies can
 * legitimately include request-echoing details; nothing from them is ever
 * logged or returned verbatim, only this fixed set of safe, pre-written
 * descriptions selected by the (non-sensitive) HTTP status/error code.
 */
function safeErrorForStatus(status: number, googleErrorCode?: string): string {
  if (status === 401 || googleErrorCode === "invalid_grant") return "The calendar connection is no longer valid and needs to be reconnected.";
  if (status === 403) return "The calendar provider denied this request.";
  if (status === 429) return "The calendar provider is temporarily rate-limiting requests.";
  if (status >= 500) return "The calendar provider is temporarily unavailable.";
  return "The calendar provider rejected the request.";
}

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<{ ok: true; status: number; body: Record<string, unknown> } | { ok: false; error: string }> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(GOOGLE_API_TIMEOUT_MS) });
  } catch {
    return { ok: false, error: "Could not reach the calendar provider." };
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // A non-JSON body (e.g. an upstream proxy error page) still needs a
    // safe, generic error below - never surfaced as a parse exception.
  }

  if (!response.ok) {
    const googleErrorCode = typeof body.error === "string" ? body.error : undefined;
    return { ok: false, error: safeErrorForStatus(response.status, googleErrorCode) };
  }

  return { ok: true, status: response.status, body };
}

export const googleCalendarProvider: CalendarProvider = {
  async exchangeCode(code, redirectUri): Promise<CalendarProviderResult<{ tokens: CalendarTokens; account: CalendarAccount }>> {
    const config = getGoogleOAuthConfig();
    if (!config) return { ok: false, error: "Google Calendar is not configured." };

    const tokenResult = await fetchJson(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });
    if (!tokenResult.ok) return tokenResult;

    const accessToken = typeof tokenResult.body.access_token === "string" ? tokenResult.body.access_token : null;
    const refreshToken = typeof tokenResult.body.refresh_token === "string" ? tokenResult.body.refresh_token : null;
    const expiresIn = typeof tokenResult.body.expires_in === "number" ? tokenResult.body.expires_in : null;
    if (!accessToken || !refreshToken || expiresIn === null) {
      // Google omits refresh_token when a prior consent already granted
      // one and this request didn't force re-consent - the OAuth start
      // route always sends prompt=consent specifically to prevent this,
      // but the response shape is still verified here rather than assumed.
      return { ok: false, error: "The calendar provider did not grant the access this connection needs." };
    }

    const userinfoResult = await fetchJson(USERINFO_ENDPOINT, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!userinfoResult.ok) return userinfoResult;

    const email = typeof userinfoResult.body.email === "string" ? userinfoResult.body.email : null;
    if (!email) return { ok: false, error: "Could not identify the connected Google account." };

    return {
      ok: true,
      value: {
        tokens: { accessToken, refreshToken, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() },
        account: { email },
      },
    };
  },

  async refreshAccessToken(refreshToken): Promise<CalendarProviderResult<{ accessToken: string; expiresAt: string }>> {
    const config = getGoogleOAuthConfig();
    if (!config) return { ok: false, error: "Google Calendar is not configured." };

    const result = await fetchJson(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
      }).toString(),
    });
    if (!result.ok) return result;

    const accessToken = typeof result.body.access_token === "string" ? result.body.access_token : null;
    const expiresIn = typeof result.body.expires_in === "number" ? result.body.expires_in : null;
    if (!accessToken || expiresIn === null) {
      return { ok: false, error: "The calendar provider did not return a usable refreshed token." };
    }

    return { ok: true, value: { accessToken, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() } };
  },

  async listCalendars(accessToken): Promise<CalendarProviderResult<CalendarListItem[]>> {
    const result = await fetchJson(`${CALENDAR_LIST_ENDPOINT}?minAccessRole=writer`, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!result.ok) return result;

    const items = Array.isArray(result.body.items) ? (result.body.items as Record<string, unknown>[]) : [];
    const calendars: CalendarListItem[] = items
      .filter((item): item is Record<string, unknown> & { id: string } => typeof item.id === "string")
      .map((item) => ({
        id: item.id,
        name: typeof item.summary === "string" ? item.summary : item.id,
        primary: item.primary === true,
      }));

    return { ok: true, value: calendars };
  },

  async checkHealth(accessToken): Promise<CalendarProviderResult<true>> {
    const result = await fetchJson(`${CALENDAR_LIST_ENDPOINT}?maxResults=1`, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!result.ok) return result;
    return { ok: true, value: true };
  },

  /**
   * Phase 1 Scheduling Foundation, Stage 4. Google's freebusy API
   * (POST /freeBusy, not GET /events) is used deliberately - it is
   * structurally incapable of returning event titles/attendees/
   * descriptions/locations; its response for each requested calendar is
   * only ever `{ busy: [{start, end}], errors?: [...] }`. This is what
   * makes "the AI must not see Google event metadata" true by construction
   * rather than by convention - there is no metadata field here to
   * accidentally forward even if a future change wanted to.
   */
  async getBusyPeriods(accessToken, calendarId, timeMinIso, timeMaxIso): Promise<CalendarProviderResult<BusyInterval[]>> {
    const result = await fetchJson(FREEBUSY_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ timeMin: timeMinIso, timeMax: timeMaxIso, items: [{ id: calendarId }] }),
    });
    if (!result.ok) return result;

    const calendars = result.body.calendars as Record<string, { busy?: unknown; errors?: unknown[] }> | undefined;
    const calendarResult = calendars?.[calendarId];
    if (!calendarResult) {
      return { ok: false, error: "The calendar provider did not return availability data for this calendar." };
    }
    if (Array.isArray(calendarResult.errors) && calendarResult.errors.length > 0) {
      // Google reports per-calendar errors (e.g. the calendar was deleted,
      // or access was revoked) inside a 200 response, not as an HTTP error -
      // never forwarded verbatim, same safe/generic convention as
      // safeErrorForStatus() above.
      return { ok: false, error: "The calendar provider could not check this calendar's availability." };
    }

    const rawBusy = Array.isArray(calendarResult.busy) ? (calendarResult.busy as Record<string, unknown>[]) : [];
    const intervals: BusyInterval[] = [];
    for (const entry of rawBusy) {
      if (typeof entry.start !== "string" || typeof entry.end !== "string") continue;
      const startMs = new Date(entry.start).getTime();
      const endMs = new Date(entry.end).getTime();
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
      // Normalized to UTC ISO 8601 here, once, so nothing downstream in the
      // scheduling engine ever needs to reason about what offset Google
      // itself used.
      intervals.push({ start_at: new Date(startMs).toISOString(), end_at: new Date(endMs).toISOString() });
    }

    return { ok: true, value: intervals };
  },

  /**
   * Phase 1 Scheduling Foundation, Stage 5. `input` already carries only
   * the minimal, non-sensitive fields CalendarEventInput's own type
   * declares - this function has no way to see anything else even if a
   * caller wanted to send it.
   */
  async createEvent(accessToken, input): Promise<CalendarProviderResult<CalendarEventResult>> {
    const result = await fetchJson(eventsUrl(input.calendarId), {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(eventRequestBody(input)),
    });
    if (!result.ok) return result;

    const eventId = typeof result.body.id === "string" ? result.body.id : null;
    if (!eventId) return { ok: false, error: "The calendar provider did not return an event id." };

    return { ok: true, value: { eventId, calendarId: input.calendarId } };
  },

  async updateEvent(accessToken, calendarId, eventId, input): Promise<CalendarProviderResult<CalendarEventResult>> {
    const result = await fetchJson(eventsUrl(calendarId, eventId), {
      method: "PATCH",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(eventRequestBody(input)),
    });
    if (!result.ok) return result;

    return { ok: true, value: { eventId, calendarId } };
  },

  /**
   * Idempotent by design: an event Google no longer has (manually removed
   * by the contractor, or a retried delete call) is treated as success,
   * not failure - the desired end state ("no event with this id exists")
   * is already true either way, and this deliberately bypasses fetchJson
   * (which would otherwise report 404/410 as errors) to encode that.
   */
  async deleteEvent(accessToken, calendarId, eventId): Promise<CalendarProviderResult<true>> {
    let response: Response;
    try {
      response = await fetch(eventsUrl(calendarId, eventId), {
        method: "DELETE",
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(GOOGLE_API_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, error: "Could not reach the calendar provider." };
    }

    if (response.ok || response.status === 404 || response.status === 410) {
      return { ok: true, value: true };
    }
    return { ok: false, error: safeErrorForStatus(response.status) };
  },
};

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { googleCalendarProvider } from "./google";
import type { CalendarTokens, CalendarAccount, CalendarListItem, CalendarProviderResult, CalendarProvider, BusyInterval, CalendarEventInput, CalendarEventResult } from "./provider";

/**
 * Phase 1 Scheduling Foundation, Stage 3: the one module that ever touches
 * calendar_credentials. Every function that reads or writes a token
 * internally creates its own service-role client (createServiceRoleClient())
 * rather than accepting one as a parameter - this is deliberate: it means
 * there is no call signature a caller could use to accidentally pass a
 * session client into a credential read/write, because the parameter
 * simply doesn't exist. calendar_connections (safe metadata only) is the
 * opposite: every function here that touches it takes the CALLER's own
 * client, so the existing RLS (is_org_member for reads, is_org_admin for
 * writes) is what actually authorizes it, exactly like every other
 * settings table in this codebase - the callers (the OAuth callback route,
 * Settings actions) have already independently verified the caller
 * server-side before reaching here, and this is defense-in-depth on top of
 * that, not a replacement for it.
 */

export type CalendarConnectionStatus = "connected" | "disconnected" | "error";

export type SafeCalendarConnection = {
  id: string;
  accountEmail: string | null;
  calendarId: string | null;
  calendarName: string | null;
  status: CalendarConnectionStatus;
  lastSyncedAt: string | null;
  lastError: string | null;
};

type ConnectionRow = {
  id: string;
  account_email: string | null;
  calendar_id: string | null;
  calendar_name: string | null;
  status: CalendarConnectionStatus;
  last_synced_at: string | null;
  last_error: string | null;
};

const CONNECTION_COLUMNS = "id, account_email, calendar_id, calendar_name, status, last_synced_at, last_error";

function toSafeConnection(row: ConnectionRow): SafeCalendarConnection {
  return {
    id: row.id,
    accountEmail: row.account_email,
    calendarId: row.calendar_id,
    calendarName: row.calendar_name,
    status: row.status,
    lastSyncedAt: row.last_synced_at,
    lastError: row.last_error,
  };
}

/** Safe-metadata-only read. Never touches calendar_credentials. */
export async function getCalendarConnection(supabase: SupabaseClient, organizationId: string): Promise<SafeCalendarConnection | null> {
  const { data } = await supabase
    .from("calendar_connections")
    .select(CONNECTION_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("provider", "google")
    .maybeSingle();

  return data ? toSafeConnection(data as ConnectionRow) : null;
}

/**
 * Creates or fully replaces this organization's Google connection - called
 * only from the OAuth callback route, immediately after it has
 * independently re-verified the caller is an authenticated admin of their
 * own organization (never trusted from anything in the OAuth round-trip
 * itself - see app/api/calendar/oauth/callback/route.ts). A prior
 * connection for this organization is replaced wholesale, not merged - no
 * stale calendar_id/calendar_name is ever carried over from a previous,
 * possibly-different, Google account; the contractor re-selects a calendar
 * after reconnecting, same as the first time.
 */
export async function storeGoogleConnection(
  supabase: SupabaseClient,
  organizationId: string,
  account: CalendarAccount,
  tokens: CalendarTokens,
): Promise<{ ok: true; connectionId: string } | { ok: false; error: string }> {
  const { data: connection, error: connectionError } = await supabase
    .from("calendar_connections")
    .upsert(
      {
        organization_id: organizationId,
        provider: "google",
        account_email: account.email,
        calendar_id: null,
        calendar_name: null,
        status: "connected",
        last_synced_at: new Date().toISOString(),
        last_error: null,
      },
      { onConflict: "organization_id,provider" },
    )
    .select("id")
    .single();

  if (connectionError || !connection) {
    return { ok: false, error: "Could not save the calendar connection." };
  }

  const service = createServiceRoleClient();
  const { error: credentialsError } = await service.from("calendar_credentials").upsert(
    {
      calendar_connection_id: connection.id,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expires_at: tokens.expiresAt,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "calendar_connection_id" },
  );

  if (credentialsError) {
    return { ok: false, error: "Could not securely store the calendar connection's credentials." };
  }

  return { ok: true, connectionId: connection.id };
}

/** Records which of the connected account's calendars Trackpr uses. Safe metadata only. */
export async function selectCalendar(
  supabase: SupabaseClient,
  organizationId: string,
  calendarId: string,
  calendarName: string,
): Promise<{ ok: boolean }> {
  const { error } = await supabase
    .from("calendar_connections")
    .update({ calendar_id: calendarId, calendar_name: calendarName })
    .eq("organization_id", organizationId)
    .eq("provider", "google");

  return { ok: !error };
}

/**
 * Deletes the connection row. calendar_credentials cascades via its own
 * ON DELETE CASCADE foreign key - this is the ONLY operation needed to
 * fully purge stored tokens; there is no separate "also delete the
 * credentials" step for a caller to forget.
 */
export async function disconnectCalendar(supabase: SupabaseClient, organizationId: string): Promise<{ ok: boolean }> {
  const { error } = await supabase.from("calendar_connections").delete().eq("organization_id", organizationId).eq("provider", "google");
  return { ok: !error };
}

/** A stored access token is refreshed slightly before its real expiry, never exactly at it, so a token that's about to expire mid-request is never handed out as if it were still safely usable. */
const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 2 * 60 * 1000;

/**
 * The ONLY function in this codebase that ever reads a stored Google
 * access/refresh token. Always uses an internally-created service-role
 * client - this function takes no client parameter at all, so there is no
 * call shape that could pass a session client in by mistake. Refreshes
 * transparently when the stored access token is expired (or within the
 * safety margin above), persists the refreshed token, and marks the
 * connection unhealthy (status: 'error', a safe error already produced by
 * google.ts - never Google's raw response) if the refresh itself fails.
 * Callers only ever receive a short-lived access token for immediate
 * one-shot use - never the refresh_token, and nothing at all on failure.
 *
 * `provider` defaults to the real googleCalendarProvider and is only ever
 * overridden by tests (see connection.test.ts) - production code never
 * passes this argument. This is the one, deliberate seam that lets the
 * refresh/health/listing logic in this file be tested without a real
 * Google API call, per Stage 3's own explicit "mock/fake the provider
 * boundary" requirement - google.ts's own tests are what actually exercise
 * real HTTP-shaped request/response handling, against a mocked fetch, not
 * a mocked CalendarProvider.
 */
export async function getFreshAccessToken(connectionId: string, provider: CalendarProvider = googleCalendarProvider): Promise<{ ok: true; accessToken: string } | { ok: false; error: string }> {
  const service = createServiceRoleClient();

  const { data: credentials } = await service
    .from("calendar_credentials")
    .select("access_token, refresh_token, expires_at")
    .eq("calendar_connection_id", connectionId)
    .maybeSingle();

  if (!credentials) {
    return { ok: false, error: "This calendar connection no longer has stored credentials." };
  }

  const expiresAtMs = new Date(credentials.expires_at as string).getTime();
  if (expiresAtMs - TOKEN_EXPIRY_SAFETY_MARGIN_MS > Date.now()) {
    return { ok: true, accessToken: credentials.access_token as string };
  }

  const refreshResult = await provider.refreshAccessToken(credentials.refresh_token as string);
  if (!refreshResult.ok) {
    await service.from("calendar_connections").update({ status: "error", last_error: refreshResult.error }).eq("id", connectionId);
    return { ok: false, error: refreshResult.error };
  }

  await service
    .from("calendar_credentials")
    .update({ access_token: refreshResult.value.accessToken, expires_at: refreshResult.value.expiresAt, updated_at: new Date().toISOString() })
    .eq("calendar_connection_id", connectionId);

  return { ok: true, accessToken: refreshResult.value.accessToken };
}

/**
 * A cheap, real provider call using the current (transparently refreshed
 * if needed) access token, updating the connection's status/
 * last_synced_at/last_error accordingly. This is both the explicit "Check
 * connection health" Settings action and the function a later stage should
 * call before trusting a connection for anything real.
 */
export async function checkConnectionHealth(connectionId: string, provider: CalendarProvider = googleCalendarProvider): Promise<{ ok: boolean; error?: string }> {
  const tokenResult = await getFreshAccessToken(connectionId, provider);
  if (!tokenResult.ok) {
    return { ok: false, error: tokenResult.error };
  }

  const service = createServiceRoleClient();
  const healthResult = await provider.checkHealth(tokenResult.accessToken);

  if (!healthResult.ok) {
    await service.from("calendar_connections").update({ status: "error", last_error: healthResult.error }).eq("id", connectionId);
    return { ok: false, error: healthResult.error };
  }

  await service.from("calendar_connections").update({ status: "connected", last_synced_at: new Date().toISOString(), last_error: null }).eq("id", connectionId);
  return { ok: true };
}

/** Lists the connected account's calendars for the "choose which calendar" step. Uses a fresh access token internally; never exposes it to the caller. */
export async function listConnectedCalendars(connectionId: string, provider: CalendarProvider = googleCalendarProvider): Promise<CalendarProviderResult<CalendarListItem[]>> {
  const tokenResult = await getFreshAccessToken(connectionId, provider);
  if (!tokenResult.ok) return { ok: false, error: tokenResult.error };
  return provider.listCalendars(tokenResult.accessToken);
}

/**
 * Phase 1 Scheduling Foundation, Stage 4: opaque busy intervals for the
 * connection's selected calendar, for lib/scheduling/availability.ts to
 * merge into its conflict check. Mirrors checkConnectionHealth's exact
 * status-update shape - a successful fetch marks the connection healthy
 * (status: 'connected', last_synced_at refreshed) as a side effect of the
 * same call scheduling was already making, no separate health-check round
 * trip needed; a failure (whether the access-token refresh itself failed,
 * or the provider call succeeded in reaching Google but Google rejected
 * it) marks the connection unhealthy with a safe error - callers
 * (getAvailableSlots) MUST treat that failure as "cannot currently trust
 * this calendar" and fail closed, never as "this calendar happens to be
 * empty right now".
 */
export async function getCalendarBusyPeriods(
  connectionId: string,
  calendarId: string,
  dateRangeStart: Date,
  dateRangeEnd: Date,
  provider: CalendarProvider = googleCalendarProvider,
): Promise<CalendarProviderResult<BusyInterval[]>> {
  const tokenResult = await getFreshAccessToken(connectionId, provider);
  if (!tokenResult.ok) {
    // getFreshAccessToken has already marked the connection unhealthy on a
    // refresh failure - nothing more to record here.
    return { ok: false, error: tokenResult.error };
  }

  const service = createServiceRoleClient();
  const busyResult = await provider.getBusyPeriods(tokenResult.accessToken, calendarId, dateRangeStart.toISOString(), dateRangeEnd.toISOString());

  if (!busyResult.ok) {
    await service.from("calendar_connections").update({ status: "error", last_error: busyResult.error }).eq("id", connectionId);
    return busyResult;
  }

  await service.from("calendar_connections").update({ status: "connected", last_synced_at: new Date().toISOString(), last_error: null }).eq("id", connectionId);
  return busyResult;
}

/**
 * Phase 1 Scheduling Foundation, Stage 5: the three event-sync wrappers,
 * all mirroring getCalendarBusyPeriods's exact shape above - resolve a
 * fresh access token (transparently refreshing/marking unhealthy exactly
 * as already established), call the provider, and record success/failure
 * via the same existing status/last_synced_at/last_error mechanism. No new
 * health-tracking mechanism is introduced for Stage 5 - these three
 * functions are the only new code paths that can mark a connection
 * unhealthy, and they do it identically to how Stage 4 already does.
 */
export async function createCalendarEvent(
  connectionId: string,
  input: CalendarEventInput,
  provider: CalendarProvider = googleCalendarProvider,
): Promise<CalendarProviderResult<CalendarEventResult>> {
  const tokenResult = await getFreshAccessToken(connectionId, provider);
  if (!tokenResult.ok) return { ok: false, error: tokenResult.error };

  const service = createServiceRoleClient();
  const result = await provider.createEvent(tokenResult.accessToken, input);

  if (!result.ok) {
    await service.from("calendar_connections").update({ status: "error", last_error: result.error }).eq("id", connectionId);
    return result;
  }

  await service.from("calendar_connections").update({ status: "connected", last_synced_at: new Date().toISOString(), last_error: null }).eq("id", connectionId);
  return result;
}

export async function updateCalendarEvent(
  connectionId: string,
  calendarId: string,
  eventId: string,
  input: Omit<CalendarEventInput, "calendarId">,
  provider: CalendarProvider = googleCalendarProvider,
): Promise<CalendarProviderResult<CalendarEventResult>> {
  const tokenResult = await getFreshAccessToken(connectionId, provider);
  if (!tokenResult.ok) return { ok: false, error: tokenResult.error };

  const service = createServiceRoleClient();
  const result = await provider.updateEvent(tokenResult.accessToken, calendarId, eventId, input);

  if (!result.ok) {
    await service.from("calendar_connections").update({ status: "error", last_error: result.error }).eq("id", connectionId);
    return result;
  }

  await service.from("calendar_connections").update({ status: "connected", last_synced_at: new Date().toISOString(), last_error: null }).eq("id", connectionId);
  return result;
}

export async function deleteCalendarEvent(
  connectionId: string,
  calendarId: string,
  eventId: string,
  provider: CalendarProvider = googleCalendarProvider,
): Promise<CalendarProviderResult<true>> {
  const tokenResult = await getFreshAccessToken(connectionId, provider);
  if (!tokenResult.ok) return { ok: false, error: tokenResult.error };

  const service = createServiceRoleClient();
  const result = await provider.deleteEvent(tokenResult.accessToken, calendarId, eventId);

  if (!result.ok) {
    await service.from("calendar_connections").update({ status: "error", last_error: result.error }).eq("id", connectionId);
    return result;
  }

  await service.from("calendar_connections").update({ status: "connected", last_synced_at: new Date().toISOString(), last_error: null }).eq("id", connectionId);
  return result;
}

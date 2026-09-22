/**
 * Phase 1 Scheduling Foundation, Stage 3: the provider-agnostic calendar
 * interface. Google is the only implementation today (lib/calendar/google.ts),
 * but every caller (lib/calendar/connection.ts, the OAuth routes, Settings
 * actions) depends on this interface, not on Google's API shape directly -
 * a future Microsoft/Outlook implementation would satisfy the same
 * interface without any caller needing to change, mirroring this
 * codebase's existing single-abstraction-boundary discipline
 * (triggerN8nWorkflow for n8n, sendOutboundMessage for SMS).
 *
 * SCOPE: Stage 3 declared OAuth code exchange, token refresh, calendar
 * listing, and a health check. Stage 4 added getBusyPeriods(). Stage 5 adds
 * the event CRUD trio - createEvent()/updateEvent()/deleteEvent() - and
 * nothing else (no watch/webhook methods; those are a later stage's job).
 * Adding unused stub methods that throw "not implemented" would let
 * TypeScript lie about what's actually callable today - methods get added
 * to this interface only in the stage that actually implements them.
 */

export type CalendarAccount = {
  email: string;
};

export type CalendarListItem = {
  id: string;
  name: string;
  primary: boolean;
};

export type CalendarTokens = {
  accessToken: string;
  refreshToken: string;
  /** ISO 8601 timestamp. */
  expiresAt: string;
};

export type CalendarProviderResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Phase 1 Scheduling Foundation, Stage 4: the ONLY shape Google Calendar
 * data ever takes once it enters the scheduling engine - an opaque busy
 * interval, nothing else. Google's freebusy API (see google.ts's
 * getBusyPeriods implementation) is used specifically because it can only
 * ever return this shape at the API level - unlike events.list, there is no
 * title/attendees/description/location field for it to leak even by
 * accident. start_at/end_at are always normalized to UTC ISO 8601 before
 * this type is ever constructed (see google.ts) - callers never need to
 * reason about what timezone Google itself used.
 */
export type BusyInterval = {
  start_at: string;
  end_at: string;
};

/**
 * Phase 1 Scheduling Foundation, Stage 5: the ONLY fields ever sent to
 * Google when creating/updating an event for a Trackpr appointment -
 * deliberately just enough for the contractor to recognize the
 * appointment on their own calendar. No conversation/lead/qualification/
 * AI data has any field to travel through here even if a caller wanted to
 * pass it - see lib/calendar/appointment-sync.ts for what actually
 * populates `summary`/`description`.
 */
export type CalendarEventInput = {
  calendarId: string;
  start_at: string;
  end_at: string;
  summary: string;
  description?: string;
};

export type CalendarEventResult = {
  eventId: string;
  calendarId: string;
};

/**
 * Every method returns a typed ok/error result rather than throwing -
 * matching triggerN8nWorkflow's own N8nDispatchResult shape - so a provider
 * failure is always a value the caller must explicitly handle, never an
 * uncaught exception that could otherwise propagate a raw Google error
 * message (which might contain sensitive request details) somewhere it
 * shouldn't. Implementations are responsible for translating any raw
 * provider error into a safe, generic `error` string - see google.ts's own
 * comment on this.
 */
export interface CalendarProvider {
  /** Exchanges an OAuth authorization code for tokens, and identifies the connected account, in one call - Google's userinfo lookup only makes sense immediately after a successful token exchange. */
  exchangeCode(code: string, redirectUri: string): Promise<CalendarProviderResult<{ tokens: CalendarTokens; account: CalendarAccount }>>;

  /** Exchanges a refresh_token for a new access_token. Never returns a new refresh_token - Google only issues one at initial consent. */
  refreshAccessToken(refreshToken: string): Promise<CalendarProviderResult<{ accessToken: string; expiresAt: string }>>;

  /** Lists the connected account's calendars, for the contractor to choose which one Trackpr uses. */
  listCalendars(accessToken: string): Promise<CalendarProviderResult<CalendarListItem[]>>;

  /** A cheap, side-effect-free call proving the current access token is actually valid right now - used for both the explicit "check connection health" action and before trusting a connection in future stages. */
  checkHealth(accessToken: string): Promise<CalendarProviderResult<true>>;

  /** Opaque busy intervals for `calendarId` within [timeMinIso, timeMaxIso) - via Google's freebusy API, which by design can only ever return busy/free ranges, never event metadata. */
  getBusyPeriods(accessToken: string, calendarId: string, timeMinIso: string, timeMaxIso: string): Promise<CalendarProviderResult<BusyInterval[]>>;

  /** Creates a new event. Trackpr is always written first - this is only ever called after the corresponding appointments row already exists (see appointment-sync.ts). */
  createEvent(accessToken: string, input: CalendarEventInput): Promise<CalendarProviderResult<CalendarEventResult>>;

  /** Updates an existing event's time/summary/description. */
  updateEvent(accessToken: string, calendarId: string, eventId: string, input: Omit<CalendarEventInput, "calendarId">): Promise<CalendarProviderResult<CalendarEventResult>>;

  /** Deletes an event. Idempotent by design - an event that's already gone (manually deleted in Google Calendar, or a retried call) is treated as success, not failure, since the desired end state is already true. */
  deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<CalendarProviderResult<true>>;
}

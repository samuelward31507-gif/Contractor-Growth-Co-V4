import type { SupabaseClient } from "@supabase/supabase-js";
import { getBookingSettings, getBusinessHours, getOrganizationTimezone, type BookingSettings, type BusinessHour, type DayOfWeek } from "@/lib/settings/queries";
import type { AppointmentStatus } from "@/lib/appointments/queries";
import { getCalendarConnection, getCalendarBusyPeriods } from "@/lib/calendar/connection";
import { googleCalendarProvider } from "@/lib/calendar/google";
import type { CalendarProvider } from "@/lib/calendar/provider";

/** The exact statuses that occupy a slot - matches lib/appointments/overlap.ts's own documented set exactly (a cancelled appointment never happened; a no-show means the contractor's time is free again). */
const OCCUPYING_APPOINTMENT_STATUSES = new Set<AppointmentStatus>(["scheduled", "confirmed", "completed"]);

/**
 * Phase 1 Scheduling Foundation, Stage 2: the availability engine.
 *
 * Deliberately split into a pure calculation layer (computeAvailableSlots)
 * and a thin I/O loader (getAvailableSlots) - the same separation this
 * codebase already uses for lib/automation/outbound-gate.ts's
 * isWithinBusinessHours (pure, unit-tested with controlled Date/timezone/
 * hours inputs) versus evaluateOutboundGate (the Supabase-backed caller).
 * computeAvailableSlots takes every piece of data it needs as plain
 * arguments, including `now` - it never reads the wall clock or calls
 * Supabase itself, so every test in availability.test.ts is fully
 * deterministic.
 *
 * IMPORTANT PRODUCT-LEVEL DIFFERENCE FROM isWithinBusinessHours: that
 * function treats an empty business_hours array as "always open" (correct
 * for its own purpose - never silently blocking an already-decided
 * automated send). This engine does the opposite on purpose: empty
 * business_hours means automated booking has never been configured at all,
 * which must never be read as "offer unlimited 24/7 slots to a real
 * customer" - it returns business_hours_not_configured instead. These are
 * two different questions ("is right now open" vs. "what can we actually
 * offer to book") with two different safe defaults; this file does not
 * reuse isWithinBusinessHours's day/time-math helpers for this reason (see
 * the local zonedWallTimeToUtc/localDateParts/dayOfWeekName helpers below) -
 * duplicating ~20 lines of pure Intl-based arithmetic here was judged the
 * smaller, safer change versus modifying outbound-gate.ts (automation-
 * safety-critical code) during a scheduling-feature stage that has no
 * business touching it.
 */

export type Slot = {
  start_at: string;
  end_at: string;
};

/**
 * Stage 4 boundary (Google Calendar busy periods) - not populated by
 * anything in Stage 2, but the pure layer already accepts it so Stage 4
 * only has to supply real data, never change this function's shape.
 */
export type ExternalBusyPeriod = {
  start_at: string;
  end_at: string;
};

export type AvailabilityResult =
  | { status: "available"; slots: Slot[] }
  | { status: "booking_disabled" }
  | { status: "business_hours_not_configured" }
  | { status: "invalid_configuration"; reason: string }
  /**
   * Phase 1 Scheduling Foundation, Stage 4: an organization that has
   * connected Google Calendar has opted into calendar-aware booking - from
   * that point on, availability must never silently fall back to
   * Trackpr-only as if nothing were connected. This status covers both "a
   * calendar is connected but no specific calendar has been selected yet"
   * and "the connected calendar could not be reached right now (expired/
   * revoked credentials, provider outage, etc.)" - both are genuinely
   * different from business_hours_not_configured/invalid_configuration
   * (which are about Trackpr's own settings, not the external calendar),
   * and both must return zero slots, never an empty-calendar assumption.
   * computeAvailableSlots() itself never produces this status - only
   * getAvailableSlots() does, before computeAvailableSlots is ever called.
   */
  | { status: "calendar_unavailable"; reason: string };

export type AvailabilityInput = {
  bookingSettings: BookingSettings;
  businessHours: BusinessHour[];
  timeZone: string;
  /**
   * Status is included deliberately, not pre-filtered by the caller - which
   * statuses actually occupy a slot is a business rule
   * (OCCUPYING_APPOINTMENT_STATUSES above), and this engine's own tests
   * need to exercise that rule directly with controlled inputs (a cancelled
   * or no_show appointment passed in here must never affect the result).
   * getAvailableSlots's DB query still scopes to the same statuses for
   * query efficiency, but that's a performance optimization, not the
   * actual enforcement point - this filter is.
   */
  existingAppointments: { start_at: string; end_at: string; status: AppointmentStatus }[];
  /** Stage 4 boundary - omitted or empty in Stage 2. */
  externalBusyPeriods?: ExternalBusyPeriod[];
  dateRangeStart: Date;
  dateRangeEnd: Date;
};

/** A generous but genuinely bounded window - this is an availability *lookup*, not an unlimited future-slot generator. */
const MAX_DATE_RANGE_DAYS = 60;

/** Reads only the "HH:MM" prefix - tolerant of both "09:00" and Postgres's "09:00:00" time-column serialization. Same tolerance as outbound-gate.ts's own parser, duplicated here per this file's own module comment. */
function parseTimeToMinutes(time: string | null): number | null {
  if (!time) return null;
  const match = /^(\d{1,2}):(\d{2})/.exec(time);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** The organization-local calendar date (year/month/day) a given instant falls on, per Intl - never assumes UTC. */
function localDateParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day") };
}

/** A plain calendar date (no timezone attached) has an unambiguous weekday regardless of what zone you'd render it in, as long as you render it in UTC to avoid any shift - so this never needs the organization's own timeZone. */
function dayOfWeekName(year: number, month: number, day: number): DayOfWeek {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(new Date(Date.UTC(year, month - 1, day)));
  return name.toLowerCase() as DayOfWeek;
}

/**
 * Converts a wall-clock date+time as observed in `timeZone` to the UTC
 * instant it represents. Vanilla Intl has no direct "construct an instant
 * from zoned local time" API, so this uses the standard two-pass technique:
 * guess the instant by treating the wall-clock values as if they were UTC,
 * then correct by the timezone's actual offset AT THAT GUESSED INSTANT
 * (re-derived via Intl.DateTimeFormat, not a fixed constant) - this is what
 * makes it correct across a DST transition, since the same timezone's
 * offset differs on either side of one.
 */
function zonedWallTimeToUtc(year: number, month: number, day: number, minutesSinceMidnight: number, timeZone: string): Date {
  const hour = Math.floor(minutesSinceMidnight / 60);
  const minute = minutesSinceMidnight % 60;
  const guessUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(guessUtcMs));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const observedUtcMs = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"), 0);

  const offsetMs = observedUtcMs - guessUtcMs;
  return new Date(guessUtcMs - offsetMs);
}

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * The pure slot-generation/filtering core. Never touches Supabase, never
 * reads the wall clock (`now` is always injected) - see this file's own
 * module comment for why. Generates candidate [start, end) slots across
 * every open business-hours window inside the requested date range, at
 * `default_duration_minutes` granularity, then filters out anything that
 * fails minimum notice or conflicts (buffer-widened) with an existing
 * Trackpr appointment or a supplied external busy period.
 */
export function computeAvailableSlots(input: AvailabilityInput, now: Date): AvailabilityResult {
  if (!input.bookingSettings.booking_enabled) {
    return { status: "booking_disabled" };
  }

  if (input.businessHours.length === 0) {
    return { status: "business_hours_not_configured" };
  }

  const { default_duration_minutes: durationMinutes, buffer_minutes: bufferMinutes, minimum_notice_minutes: minimumNoticeMinutes } = input.bookingSettings;

  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    return { status: "invalid_configuration", reason: "default_duration_minutes must be a positive number of minutes." };
  }
  if (!isFiniteNonNegative(bufferMinutes)) {
    return { status: "invalid_configuration", reason: "buffer_minutes must be zero or a positive number of minutes." };
  }
  if (!isFiniteNonNegative(minimumNoticeMinutes)) {
    return { status: "invalid_configuration", reason: "minimum_notice_minutes must be zero or a positive number of minutes." };
  }
  if (!(input.dateRangeEnd.getTime() > input.dateRangeStart.getTime())) {
    return { status: "invalid_configuration", reason: "dateRangeEnd must be after dateRangeStart." };
  }

  const rangeDays = (input.dateRangeEnd.getTime() - input.dateRangeStart.getTime()) / 86_400_000;
  if (rangeDays > MAX_DATE_RANGE_DAYS) {
    return { status: "invalid_configuration", reason: `Date range cannot exceed ${MAX_DATE_RANGE_DAYS} days.` };
  }

  // Probing for a RangeError is the only way Intl exposes "is this a real IANA zone".
  let timeZoneIsValid = true;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: input.timeZone });
  } catch {
    timeZoneIsValid = false;
  }
  if (!timeZoneIsValid) {
    return { status: "invalid_configuration", reason: `"${input.timeZone}" is not a recognized timezone.` };
  }

  const durationMs = durationMinutes * 60_000;
  const bufferMs = bufferMinutes * 60_000;
  const earliestStartMs = now.getTime() + minimumNoticeMinutes * 60_000;
  const dateRangeStartMs = input.dateRangeStart.getTime();
  const dateRangeEndMs = input.dateRangeEnd.getTime();

  const openHoursByDay = new Map<DayOfWeek, BusinessHour>();
  for (const hour of input.businessHours) {
    if (hour.is_open) openHoursByDay.set(hour.day_of_week, hour);
  }

  const occupyingAppointments = input.existingAppointments.filter((appointment) => OCCUPYING_APPOINTMENT_STATUSES.has(appointment.status));
  const busyRanges = [...occupyingAppointments, ...(input.externalBusyPeriods ?? [])].map((range) => ({
    startMs: new Date(range.start_at).getTime(),
    endMs: new Date(range.end_at).getTime(),
  }));

  function hasConflict(candidateStartMs: number, candidateEndMs: number): boolean {
    const bufferedStartMs = candidateStartMs - bufferMs;
    const bufferedEndMs = candidateEndMs + bufferMs;
    return busyRanges.some((range) => range.startMs < bufferedEndMs && range.endMs > bufferedStartMs);
  }

  const slots: Slot[] = [];
  let { year, month, day } = localDateParts(input.dateRangeStart, input.timeZone);

  // Bounded by MAX_DATE_RANGE_DAYS above (+1 for a partial first/last day) -
  // this loop cannot run away even if the date-math below had a defect.
  for (let dayIndex = 0; dayIndex <= MAX_DATE_RANGE_DAYS + 1; dayIndex++) {
    const dayStartInstantMs = zonedWallTimeToUtc(year, month, day, 0, input.timeZone).getTime();
    if (dayStartInstantMs >= dateRangeEndMs) break;

    const hourRow = openHoursByDay.get(dayOfWeekName(year, month, day));
    if (hourRow) {
      const openMinutes = parseTimeToMinutes(hourRow.open_time);
      const closeMinutes = parseTimeToMinutes(hourRow.close_time);

      if (openMinutes !== null && closeMinutes !== null && closeMinutes > openMinutes) {
        const dayOpenMs = zonedWallTimeToUtc(year, month, day, openMinutes, input.timeZone).getTime();
        const dayCloseMs = zonedWallTimeToUtc(year, month, day, closeMinutes, input.timeZone).getTime();

        for (let candidateStartMs = dayOpenMs; candidateStartMs + durationMs <= dayCloseMs; candidateStartMs += durationMs) {
          const candidateEndMs = candidateStartMs + durationMs;

          if (candidateStartMs < earliestStartMs) continue;
          if (candidateStartMs < dateRangeStartMs || candidateStartMs >= dateRangeEndMs) continue;
          if (hasConflict(candidateStartMs, candidateEndMs)) continue;

          slots.push({ start_at: new Date(candidateStartMs).toISOString(), end_at: new Date(candidateEndMs).toISOString() });
        }
      }
    }

    // Advance to the next organization-local calendar day - pure Y/M/D
    // arithmetic on a UTC-midnight representation of the calendar date
    // itself (not a zoned instant), so this step is never affected by DST.
    const nextDayUtc = new Date(Date.UTC(year, month - 1, day) + 86_400_000);
    year = nextDayUtc.getUTCFullYear();
    month = nextDayUtc.getUTCMonth() + 1;
    day = nextDayUtc.getUTCDate();
  }

  return { status: "available", slots };
}

export type AvailabilityQuery = {
  organizationId: string;
  dateRangeStart: Date;
  dateRangeEnd: Date;
  /** Stage 4 boundary - real callers omit this until Google Calendar sync exists. */
  externalBusyPeriods?: ExternalBusyPeriod[];
};

/**
 * The I/O loader: resolves every input computeAvailableSlots needs from the
 * database, scoped to `query.organizationId` exactly like every other
 * organization-scoped read in this codebase - the caller is responsible for
 * having already resolved that id server-side (session, service-role
 * webhook context, etc.), never from anything client-supplied. Reuses the
 * exact existing settings readers (getBookingSettings/getBusinessHours/
 * getOrganizationTimezone) rather than re-querying those tables directly.
 *
 * The appointments read reuses lib/appointments/overlap.ts's own
 * range-overlap predicate (start_at < rangeEnd AND end_at > rangeStart) -
 * applied once for the whole requested window here, rather than once per
 * candidate slot the way checkAppointmentOverlap() checks a single range.
 * Calling checkAppointmentOverlap() itself per candidate would be a
 * redundant per-slot round trip and would also require Supabase access
 * inside the pure layer, which this file's own design deliberately avoids.
 * The status filter is intentionally scoped at the query level too (a
 * performance optimization - no reason to fetch rows the pure layer would
 * just discard) even though computeAvailableSlots re-applies the same
 * filter itself as the actual enforcement point - see AvailabilityInput's
 * own comment.
 *
 * GOOGLE CALENDAR (Stage 4): if this organization has a Google Calendar
 * connection, its busy periods are fetched fresh on every call - via
 * lib/calendar/connection.ts's getCalendarBusyPeriods(), which internally
 * refreshes the access token if needed and marks the connection healthy/
 * unhealthy as a side effect of this same call, exactly like
 * checkConnectionHealth() already does. There is no fast path that skips
 * this fetch merely because the connection's last-known `status` says
 * 'connected' - a stale status column is never trusted over an actual,
 * live attempt (the same "re-check live, never trust cached state"
 * discipline this codebase already applies to business hours/automation
 * mode/appointment eligibility elsewhere). booking_enabled/business_hours
 * are checked here BEFORE that live call specifically to avoid an
 * unnecessary Google API request (and a possible false "unhealthy" status
 * write) when booking is not even active - computeAvailableSlots() below
 * re-checks both anyway, so this is a performance/UX optimization on top
 * of the real enforcement point, never a second, divergent one.
 *
 * `calendarProvider` defaults to the real googleCalendarProvider and is
 * only ever overridden by tests, matching lib/calendar/connection.ts's own
 * established seam for testing without a real Google API call.
 */
export async function getAvailableSlots(
  supabase: SupabaseClient,
  query: AvailabilityQuery,
  now: Date = new Date(),
  calendarProvider: CalendarProvider = googleCalendarProvider,
): Promise<AvailabilityResult> {
  const [bookingSettings, businessHours, timeZone, connection] = await Promise.all([
    getBookingSettings(supabase, query.organizationId),
    getBusinessHours(supabase, query.organizationId),
    getOrganizationTimezone(supabase, query.organizationId),
    getCalendarConnection(supabase, query.organizationId),
  ]);

  if (!bookingSettings.booking_enabled) {
    return { status: "booking_disabled" };
  }
  if (businessHours.length === 0) {
    return { status: "business_hours_not_configured" };
  }

  const { data: appointmentRows } = await supabase
    .from("appointments")
    .select("start_at, end_at, status")
    .eq("organization_id", query.organizationId)
    .in("status", ["scheduled", "confirmed", "completed"])
    .lt("start_at", query.dateRangeEnd.toISOString())
    .gt("end_at", query.dateRangeStart.toISOString());

  let externalBusyPeriods: ExternalBusyPeriod[] | undefined = query.externalBusyPeriods;

  if (connection) {
    if (!connection.calendarId) {
      return { status: "calendar_unavailable", reason: "Google Calendar is connected, but no calendar has been selected yet." };
    }

    const busyResult = await getCalendarBusyPeriods(connection.id, connection.calendarId, query.dateRangeStart, query.dateRangeEnd, calendarProvider);
    if (!busyResult.ok) {
      return { status: "calendar_unavailable", reason: busyResult.error };
    }

    externalBusyPeriods = busyResult.value;
  }

  return computeAvailableSlots(
    {
      bookingSettings,
      businessHours,
      timeZone: timeZone ?? "UTC",
      existingAppointments: (appointmentRows ?? []) as { start_at: string; end_at: string; status: AppointmentStatus }[],
      externalBusyPeriods,
      dateRangeStart: query.dateRangeStart,
      dateRangeEnd: query.dateRangeEnd,
    },
    now,
  );
}

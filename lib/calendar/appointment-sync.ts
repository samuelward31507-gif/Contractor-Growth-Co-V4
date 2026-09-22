import type { SupabaseClient } from "@supabase/supabase-js";
import { getAppointment, type Appointment } from "@/lib/appointments/queries";
import { getCalendarConnection, createCalendarEvent, updateCalendarEvent, deleteCalendarEvent } from "./connection";
import { googleCalendarProvider } from "./google";
import type { CalendarProvider, CalendarEventInput } from "./provider";

/**
 * Phase 1 Scheduling Foundation, Stage 5: syncs a Trackpr appointment to
 * Google Calendar. Trackpr is always the source of truth - every function
 * here is called AFTER the corresponding Trackpr write (insert/update/
 * delete) has already succeeded, and a sync failure here never undoes or
 * blocks that write. Each function returns `{ warning?: string }` - an
 * empty object means "nothing the user needs to know" (no connection, or
 * sync succeeded cleanly); a `warning` is a safe, non-sensitive message
 * app/(app)/appointments/actions.ts surfaces back through the existing
 * AppointmentFormState/DeleteAppointmentState shape, never a raw Google
 * error and never anything logged to the client - only a fixed,
 * pre-written sentence per failure class, matching lib/calendar/google.ts's
 * own safeErrorForStatus() convention.
 *
 * WHY NO NEW SCHEMA/INCIDENT MECHANISM: a "calendar sync failed" signal
 * needs (1) immediate feedback to the person who just created/edited the
 * appointment, and (2) durable visibility if they don't see that mesage.
 * (1) is the `warning` string returned here - zero schema change, an
 * additive optional field on the existing action-state types. (2) is
 * already fully covered by the EXISTING calendar_connections.status/
 * last_error mechanism (Stage 3/4) for connection-level failures (expired
 * token, provider outage) - every function below reuses
 * createCalendarEvent/updateCalendarEvent/deleteCalendarEvent, which
 * already record exactly that. The automation_incidents table was
 * considered and rejected: its `category` column has a DB-level CHECK
 * constraint (see 20260919160000_automation_health_and_alerting.sql) whose
 * existing values (n8n_dispatch_failed, sms_send_failed, etc.) are all
 * specific to the n8n/SMS automation pipeline - reusing one of those for a
 * Google Calendar failure would be actively misleading to whoever reads
 * it, and adding a new category value would require widening that CHECK
 * constraint, i.e. a migration this stage's own instructions say to avoid
 * unless genuinely necessary. It is not necessary here - the two
 * mechanisms above are a complete, honest fit without one.
 */

/**
 * Deliberately minimal, non-inventing content: `summary` is the
 * appointment's own `title` field verbatim (exactly what the contractor
 * already typed and already sees in Trackpr's own Appointments list -
 * never reconstructed or guessed), and `description` adds only the
 * contact's name if one is already attached to the appointment. Nothing
 * from `appointment.lead` (service/source/status/temperature/
 * estimated_value - qualification data) is ever read here, even though
 * the Appointment type carries it - this function simply never looks at
 * that field.
 */
function buildEventInput(calendarId: string, appointment: Appointment): CalendarEventInput {
  const contactName = appointment.contact ? [appointment.contact.first_name, appointment.contact.last_name].filter(Boolean).join(" ").trim() : "";

  return {
    calendarId,
    start_at: appointment.start_at,
    end_at: appointment.end_at,
    summary: appointment.title,
    description: contactName ? `Trackpr appointment for ${contactName}.` : undefined,
  };
}

const GENERIC_SYNC_WARNING = "This appointment was saved, but syncing it to Google Calendar needs attention. Check your calendar connection in Settings.";

/**
 * Called once, immediately after a NEW appointment's Trackpr insert has
 * already succeeded. Idempotent: if this appointment already has an
 * external_event_id (e.g. this function is somehow invoked twice for the
 * same appointment), it does nothing rather than create a second Google
 * event - the stable identity checked is the Trackpr appointment's own
 * row, never anything supplied by a caller.
 */
export async function syncAppointmentCreatedToGoogle(
  supabase: SupabaseClient,
  organizationId: string,
  appointmentId: string,
  provider: CalendarProvider = googleCalendarProvider,
): Promise<{ warning?: string }> {
  const connection = await getCalendarConnection(supabase, organizationId);
  if (!connection) return {};

  if (!connection.calendarId) {
    return { warning: "This appointment was created. Google Calendar is connected, but no calendar has been selected yet in Settings, so it wasn't added to your calendar." };
  }

  const { data: existing } = await supabase.from("appointments").select("external_event_id").eq("id", appointmentId).eq("organization_id", organizationId).maybeSingle();
  if (existing?.external_event_id) return {};

  const appointment = await getAppointment(supabase, organizationId, appointmentId);
  if (!appointment) return {};

  const result = await createCalendarEvent(connection.id, buildEventInput(connection.calendarId, appointment), provider);
  if (!result.ok) {
    console.error("[calendar][sync] failed to create Google Calendar event for a new appointment", { organizationId, appointmentId, error: result.error });
    return { warning: GENERIC_SYNC_WARNING };
  }

  const { error: persistError } = await supabase
    .from("appointments")
    .update({ external_event_id: result.value.eventId, external_calendar_id: result.value.calendarId })
    .eq("id", appointmentId)
    .eq("organization_id", organizationId);

  if (persistError) {
    console.error("[calendar][sync] Google event created but failed to persist external ids", { organizationId, appointmentId, error: persistError.message });
    return { warning: "This appointment was created and added to Google Calendar, but we couldn't fully record the sync. Please verify it in your calendar." };
  }

  return {};
}

/**
 * Called after an EXISTING appointment's Trackpr update has already
 * succeeded. Only acts if the appointment already has a synced external
 * event - per this stage's own explicit instruction, an appointment that
 * was never synced (created before a calendar was connected, or while
 * none was selected) is never retroactively synced just because it
 * happened to also be edited; that would be a surprising side effect of
 * an unrelated change.
 */
export async function syncAppointmentUpdatedToGoogle(
  supabase: SupabaseClient,
  organizationId: string,
  appointmentId: string,
  provider: CalendarProvider = googleCalendarProvider,
): Promise<{ warning?: string }> {
  const { data: row } = await supabase
    .from("appointments")
    .select("external_event_id, external_calendar_id")
    .eq("id", appointmentId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (!row?.external_event_id || !row.external_calendar_id) return {};

  const connection = await getCalendarConnection(supabase, organizationId);
  if (!connection) {
    return { warning: "This appointment was updated, but the change could not be synced to Google Calendar because no calendar is currently connected." };
  }

  const appointment = await getAppointment(supabase, organizationId, appointmentId);
  if (!appointment) return {};

  const result = await updateCalendarEvent(connection.id, row.external_calendar_id, row.external_event_id, buildEventInput(row.external_calendar_id, appointment), provider);
  if (!result.ok) {
    console.error("[calendar][sync] failed to update the Google Calendar event for an edited appointment", { organizationId, appointmentId, error: result.error });
    return { warning: GENERIC_SYNC_WARNING };
  }

  return {};
}

/**
 * Called after an appointment has been intentionally deleted OR cancelled
 * (both are, in this domain, "the appointment no longer needs to occupy
 * time on the contractor's calendar" - see this stage's own instructions).
 * Takes the external ids directly rather than an appointmentId, since for
 * a physical delete the Trackpr row is already gone by the time this
 * runs - there is nothing left to look them up from.
 */
export async function syncAppointmentRemovedFromGoogle(
  supabase: SupabaseClient,
  organizationId: string,
  externalEventId: string,
  externalCalendarId: string,
  provider: CalendarProvider = googleCalendarProvider,
): Promise<{ warning?: string }> {
  const connection = await getCalendarConnection(supabase, organizationId);
  if (!connection) {
    return { warning: "This appointment was removed, but its linked Google Calendar event could not be removed because no calendar is currently connected." };
  }

  const result = await deleteCalendarEvent(connection.id, externalCalendarId, externalEventId, provider);
  if (!result.ok) {
    console.error("[calendar][sync] failed to delete the Google Calendar event for a removed appointment", { organizationId, externalEventId, error: result.error });
    return { warning: "This appointment was removed, but removing it from Google Calendar needs attention. Check your calendar connection in Settings." };
  }

  return {};
}

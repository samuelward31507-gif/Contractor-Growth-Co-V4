import type { SupabaseClient } from "@supabase/supabase-js";
import { getAvailableSlots, type AvailabilityResult } from "./availability";
import { syncAppointmentCreatedToGoogle } from "@/lib/calendar/appointment-sync";
import { createAutomationEventAsService } from "@/lib/automation/events";
import { startWorkflowExecutionAsService, completeWorkflowExecutionAsService, failWorkflowExecutionAsService } from "@/lib/automation/executions";
import { emitAppointmentLifecycleEventAsService } from "@/lib/automation/appointments";
import { googleCalendarProvider } from "@/lib/calendar/google";
import type { CalendarProvider } from "@/lib/calendar/provider";
import type { SendSmsInput, SendSmsResult } from "@/lib/automation/sms";
import { computeConfirmationInvalidationOnTimeChange } from "@/lib/appointments/confirmation";

/**
 * Phase 1 Scheduling Foundation, Stage 6: the AI-facing booking interface.
 * This is the ONLY module the AI/n8n system is meant to call for
 * scheduling - it never calculates availability itself, never inspects
 * Google Calendar, never sees Google event metadata. Both functions below
 * are thin, deliberately unglamorous wrappers around infrastructure every
 * earlier stage already built and tested (getAvailableSlots from Stage 2/4,
 * the appointments table + Stage 1's exclusion constraint,
 * syncAppointmentCreatedToGoogle from Stage 5, and the existing
 * automation_events/workflow_executions idempotency primitives) - nothing
 * new is invented here beyond the composition itself.
 *
 * NOT WIRED INTO n8n YET - see this file's own report for why. Both
 * functions are fully functional, fully tested, and callable from any
 * future service-role context (a webhook route, a callback handler) - what
 * does NOT exist yet is the n8n workflow itself populating a booking
 * decision into the existing callback contract (AiResult has no
 * booking-intent field today - see app/api/automation/n8n-callback/route.ts).
 * That is an n8n change, which this stage's own instructions say to STOP
 * and report rather than make.
 */

export type BookingSlot = { start_at: string; end_at: string };

/**
 * Returns exactly what the AI needs to present times to a customer, and
 * nothing else - this is getAvailableSlots() (Stage 2/4) completely
 * unchanged, re-exported under the name this stage's own instructions
 * asked for. Its "available" branch's slots are already only
 * {start_at, end_at} - there is no Google event title/attendee/description/
 * location field anywhere in this type for a caller to even try to read.
 */
export async function getAvailableBookingSlots(
  supabase: SupabaseClient,
  organizationId: string,
  dateRangeStart: Date,
  dateRangeEnd: Date,
  // Never supplied by production callers (n8n/AI always gets the real
  // Google-backed result) - exists only so tests can inject a fake
  // CalendarProvider, matching the exact seam getAvailableSlots and
  // syncAppointmentCreatedToGoogle already expose.
  calendarProvider: CalendarProvider = googleCalendarProvider,
): Promise<AvailabilityResult> {
  return getAvailableSlots(supabase, { organizationId, dateRangeStart, dateRangeEnd }, undefined, calendarProvider);
}

export type BookAppointmentInput = {
  organizationId: string;
  contactId: string;
  leadId?: string | null;
  /** ISO 8601 UTC - must exactly match one of getAvailableBookingSlots's own previously-returned slots; never trusted as freeform input. */
  startAt: string;
  endAt: string;
  title: string;
  notes?: string | null;
  /**
   * Deterministic, caller-derived - e.g. `booking:${conversationId}:${startAt}`
   * - matching lib/automation/events.ts's own established idempotencyKey
   * convention exactly. A retried call with the same key replays the
   * original outcome rather than attempting to book again.
   */
  idempotencyKey: string;
};

export type BookAppointmentFailureReason =
  | "slot_unavailable"
  | "invalid_contact"
  | "booking_disabled"
  | "organization_not_active"
  | "configuration_error"
  | "internal_error";

export type BookAppointmentResult =
  | {
      success: true;
      appointmentId: string;
      startAt: string;
      endAt: string;
      timezone: string;
      /**
       * "synced": either a Google Calendar event was created, or no
       * calendar is connected at all - both are a fully valid, expected
       * outcome with nothing for the caller to act on.
       * syncAppointmentCreatedToGoogle's own return shape ({warning?})
       * can't distinguish those two cases from each other, only from a
       * genuine failure, so neither can this type - only "did something
       * need attention" is ever meaningfully knowable here.
       * "needs_attention": a calendar is connected but the sync failed -
       * see appointment-sync.ts's own warning for detail (never exposed
       * here, only this coarse status).
       */
      calendarSyncStatus: "synced" | "needs_attention";
    }
  | { success: false; reason: BookAppointmentFailureReason };

const BOOKING_EVENT_TYPE = "appointment.booking_requested";
const BOOKING_WORKFLOW_NAME = "appointment_booking";

type BookingOutcomeMetadata =
  | { outcome: "success"; appointment_id: string; start_at: string; end_at: string; calendar_sync_status: "synced" | "needs_attention" }
  | { outcome: "failure"; reason: BookAppointmentFailureReason };

function resultFromMetadata(metadata: Record<string, unknown> | null, timezone: string): BookAppointmentResult {
  const outcome = metadata as BookingOutcomeMetadata | null;
  if (outcome?.outcome === "success") {
    return { success: true, appointmentId: outcome.appointment_id, startAt: outcome.start_at, endAt: outcome.end_at, timezone, calendarSyncStatus: outcome.calendar_sync_status };
  }
  if (outcome?.outcome === "failure") {
    return { success: false, reason: outcome.reason };
  }
  // A prior attempt exists but never reached a recorded outcome (e.g. a
  // crash mid-execution) - fails closed rather than guessing.
  return { success: false, reason: "internal_error" };
}

/**
 * Books an appointment on behalf of the AI/n8n system - always via
 * service-role (this has no Supabase Auth session to check, matching
 * every other *AsService caller in this codebase - the n8n callback route,
 * the inbound SMS webhook). organizationId/contactId are never trusted
 * merely because they were supplied; both are independently re-verified
 * against the database below (contact ownership) and re-derived where
 * possible (timezone, availability), never assumed from the caller's
 * input alone.
 *
 * ORDER OF OPERATIONS (mirrors this stage's own required flow exactly):
 * 1. organization payment authorization (service-role bypasses RLS, so this
 *    must be checked explicitly here - the one place in this function that
 *    isn't already covered by an existing gate).
 * 2. Idempotency via createAutomationEventAsService's existing key
 *    mechanism - a duplicate replays the original recorded outcome instead
 *    of re-attempting anything.
 * 3. Contact ownership re-verification.
 * 4. A FRESH availability re-check for the exact requested slot - this is
 *    also what makes "the AI cannot book a time not returned by
 *    availability" true: the requested slot must exactly match one of
 *    getAvailableSlots's own current output, not merely "not conflict".
 * 5. The Trackpr insert - Stage 1's appointments_no_overlap exclusion
 *    constraint is the final, authoritative concurrency guarantee under-
 *    neath step 4's own best-effort check.
 * 6. Google Calendar sync (Stage 5, completely unchanged, best-effort).
 */
export async function bookAppointment(
  supabase: SupabaseClient,
  input: BookAppointmentInput,
  // Never supplied by production callers - same testing-only seam as
  // getAvailableBookingSlots above, threaded through to both the
  // availability recheck and the Google sync call below so a test can
  // simulate a healthy recheck with a subsequently-failing sync.
  calendarProvider: CalendarProvider = googleCalendarProvider,
): Promise<BookAppointmentResult> {
  const { data: organization } = await supabase.from("organizations").select("payment_status, timezone").eq("id", input.organizationId).maybeSingle();
  const timezone = organization?.timezone ?? "UTC";

  if (organization?.payment_status !== "active") {
    return { success: false, reason: "organization_not_active" };
  }

  const eventResult = await createAutomationEventAsService(supabase, input.organizationId, {
    eventType: BOOKING_EVENT_TYPE,
    entityType: "contact",
    entityId: input.contactId,
    payload: { contact_id: input.contactId, lead_id: input.leadId ?? null, start_at: input.startAt, end_at: input.endAt, title: input.title },
    idempotencyKey: input.idempotencyKey,
  });

  if (!eventResult.ok) {
    return { success: false, reason: "internal_error" };
  }
  if (eventResult.skipped) {
    return { success: false, reason: "booking_disabled" };
  }

  if (eventResult.duplicate) {
    const { data: existingExecution } = await supabase
      .from("workflow_executions")
      .select("status, metadata")
      .eq("automation_event_id", eventResult.event.id)
      .order("attempt", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!existingExecution || existingExecution.status === "running") {
      // Extremely rare: a concurrent duplicate request is still being
      // processed right now. Never a reason to attempt a second booking.
      return { success: false, reason: "internal_error" };
    }
    return resultFromMetadata(existingExecution.metadata as Record<string, unknown> | null, timezone);
  }

  const executionResult = await startWorkflowExecutionAsService(supabase, eventResult.event.id, BOOKING_WORKFLOW_NAME);
  if (!executionResult.ok) {
    return { success: false, reason: "internal_error" };
  }
  const executionId = executionResult.execution.id;

  async function finishWithFailure(reason: BookAppointmentFailureReason): Promise<BookAppointmentResult> {
    const metadata: BookingOutcomeMetadata = { outcome: "failure", reason };
    const completed = await completeWorkflowExecutionAsService(supabase, executionId, metadata);
    if (!completed.ok) {
      await failWorkflowExecutionAsService(supabase, executionId, `booking failed: ${reason}`, "workflow_failed");
    }
    return { success: false, reason };
  }

  const { data: contact } = await supabase.from("contacts").select("id").eq("id", input.contactId).eq("organization_id", input.organizationId).maybeSingle();
  if (!contact) {
    return finishWithFailure("invalid_contact");
  }

  // Step 4: fresh availability re-check, scoped tightly around the
  // requested slot with a small safety margin past its own end - never
  // trusts that a slot offered earlier in the conversation is still valid.
  const recheckEnd = new Date(new Date(input.endAt).getTime() + 60_000);
  const availability = await getAvailableSlots(supabase, { organizationId: input.organizationId, dateRangeStart: new Date(input.startAt), dateRangeEnd: recheckEnd }, undefined, calendarProvider);

  if (availability.status !== "available") {
    // Distinguishes "try a different time" (slot_unavailable - never true
    // here, since a non-'available' status means no slots were computed at
    // all) from "something about this organization's setup needs staff
    // attention, no time will work right now" - booking_disabled (the org
    // turned off automated booking) and configuration_error (business
    // hours never configured, invalid settings, or the connected calendar
    // is currently unhealthy) are meaningfully different situations for a
    // human to act on, per this stage's own "human handoff" requirement.
    return finishWithFailure(availability.status === "booking_disabled" ? "booking_disabled" : "configuration_error");
  }
  const slotStillOffered = availability.slots.some((slot) => slot.start_at === input.startAt && slot.end_at === input.endAt);
  if (!slotStillOffered) {
    return finishWithFailure("slot_unavailable");
  }

  const { data: appointment, error: insertError } = await supabase
    .from("appointments")
    .insert({
      organization_id: input.organizationId,
      contact_id: input.contactId,
      lead_id: input.leadId ?? null,
      title: input.title,
      start_at: input.startAt,
      end_at: input.endAt,
      status: "scheduled",
      notes: input.notes ?? null,
    })
    .select("id")
    .single();

  if (insertError || !appointment) {
    // Stage 1's exclusion constraint (23P01) is the authoritative
    // concurrency guarantee underneath the availability re-check above -
    // a race that slips past that check still cannot create an
    // overlapping appointment, and lands here as the same safe
    // "slot_unavailable" result the recheck itself would have given.
    const reason: BookAppointmentFailureReason = insertError?.code === "23P01" ? "slot_unavailable" : "internal_error";
    return finishWithFailure(reason);
  }

  const syncResult = await syncAppointmentCreatedToGoogle(supabase, input.organizationId, appointment.id, calendarProvider);
  const calendarSyncStatus: "synced" | "needs_attention" = syncResult.warning ? "needs_attention" : "synced";

  const metadata: BookingOutcomeMetadata = { outcome: "success", appointment_id: appointment.id, start_at: input.startAt, end_at: input.endAt, calendar_sync_status: calendarSyncStatus };
  const completed = await completeWorkflowExecutionAsService(supabase, executionId, metadata);
  if (!completed.ok) {
    // The appointment itself is already fully committed and synced by this
    // point - a failure to record the execution's own completion metadata
    // is never a reason to report booking failure to the caller.
    await failWorkflowExecutionAsService(supabase, executionId, "failed to record booking completion metadata", "workflow_failed");
  }

  return { success: true, appointmentId: appointment.id, startAt: input.startAt, endAt: input.endAt, timezone, calendarSyncStatus };
}

export type RescheduleAppointmentInput = {
  organizationId: string;
  contactId: string;
  appointmentId: string;
  /** ISO 8601 UTC - must exactly match one of getAvailableBookingSlots's own previously-returned slots; never trusted as freeform input. */
  startAt: string;
  endAt: string;
  /** Same convention as bookAppointment's idempotencyKey - e.g. `reschedule:${conversationId}:${startAt}`. */
  idempotencyKey: string;
};

export type RescheduleAppointmentFailureReason = "slot_unavailable" | "not_found" | "not_reschedulable" | "organization_not_active" | "configuration_error" | "internal_error";

export type RescheduleAppointmentResult =
  | { success: true; appointmentId: string; startAt: string; endAt: string; timezone: string }
  | { success: false; reason: RescheduleAppointmentFailureReason };

const RESCHEDULE_EVENT_TYPE = "appointment.reschedule_requested";
const RESCHEDULE_WORKFLOW_NAME = "appointment_reschedule";

type RescheduleOutcomeMetadata =
  | { outcome: "success"; appointment_id: string; start_at: string; end_at: string }
  | { outcome: "failure"; reason: RescheduleAppointmentFailureReason };

function rescheduleResultFromMetadata(metadata: Record<string, unknown> | null, timezone: string): RescheduleAppointmentResult {
  const outcome = metadata as RescheduleOutcomeMetadata | null;
  if (outcome?.outcome === "success") {
    return { success: true, appointmentId: outcome.appointment_id, startAt: outcome.start_at, endAt: outcome.end_at, timezone };
  }
  if (outcome?.outcome === "failure") {
    return { success: false, reason: outcome.reason };
  }
  return { success: false, reason: "internal_error" };
}

/**
 * Pass 1 (booking loop completion): reschedules an EXISTING appointment to a
 * new, freshly-availability-checked time - the update-in-place counterpart
 * to bookAppointment above, deliberately mirroring its exact order of
 * operations (payment gate, idempotency, ownership re-verification, a fresh
 * availability re-check, then the write) rather than inventing a divergent
 * shape. Scoped by organization AND contact together (never appointment id
 * alone), so one customer's message can never move another customer's
 * appointment.
 *
 * KNOWN, ACCEPTED LIMITATION: the availability re-check does not exclude
 * this appointment's own current (about-to-be-vacated) slot from conflict
 * detection - lib/scheduling/availability.ts's own conflict logic is left
 * completely unchanged rather than threading a new exclusion parameter
 * through a sensitive, already-heavily-tested subsystem for this one
 * caller. The only practical effect: a request to reschedule into a time
 * that overlaps the appointment's own current slot is reported as
 * unavailable even though it would actually be free once the reschedule
 * completes - always the safe direction (never double-books, only
 * occasionally over-cautious), and a genuinely rare case in practice, since
 * a customer rescheduling is by definition asking to move away from their
 * current time.
 *
 * The same Stage-1 appointments_no_overlap exclusion constraint that backs
 * bookAppointment's own concurrency guarantee applies identically to this
 * UPDATE (a real Postgres EXCLUDE constraint enforces itself on both INSERT
 * and UPDATE) - no new database protection is introduced, the existing one
 * is simply relied on again.
 */
export async function rescheduleAppointment(
  supabase: SupabaseClient,
  input: RescheduleAppointmentInput,
  calendarProvider: CalendarProvider = googleCalendarProvider,
  /** Test seam only - production callers must never pass this; see lib/messaging/outbound.ts. */
  sendSmsFn?: (smsInput: SendSmsInput) => Promise<SendSmsResult>,
): Promise<RescheduleAppointmentResult> {
  const { data: organization } = await supabase.from("organizations").select("payment_status, timezone").eq("id", input.organizationId).maybeSingle();
  const timezone = organization?.timezone ?? "UTC";

  if (organization?.payment_status !== "active") {
    return { success: false, reason: "organization_not_active" };
  }

  const eventResult = await createAutomationEventAsService(supabase, input.organizationId, {
    eventType: RESCHEDULE_EVENT_TYPE,
    entityType: "appointment",
    entityId: input.appointmentId,
    payload: { appointment_id: input.appointmentId, contact_id: input.contactId, start_at: input.startAt, end_at: input.endAt },
    idempotencyKey: input.idempotencyKey,
  });

  if (!eventResult.ok) {
    return { success: false, reason: "internal_error" };
  }
  if (eventResult.skipped) {
    return { success: false, reason: "not_reschedulable" };
  }

  if (eventResult.duplicate) {
    const { data: existingExecution } = await supabase
      .from("workflow_executions")
      .select("status, metadata")
      .eq("automation_event_id", eventResult.event.id)
      .order("attempt", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!existingExecution || existingExecution.status === "running") {
      return { success: false, reason: "internal_error" };
    }
    return rescheduleResultFromMetadata(existingExecution.metadata as Record<string, unknown> | null, timezone);
  }

  const executionResult = await startWorkflowExecutionAsService(supabase, eventResult.event.id, RESCHEDULE_WORKFLOW_NAME);
  if (!executionResult.ok) {
    return { success: false, reason: "internal_error" };
  }
  const executionId = executionResult.execution.id;

  async function finishWithFailure(reason: RescheduleAppointmentFailureReason): Promise<RescheduleAppointmentResult> {
    const metadata: RescheduleOutcomeMetadata = { outcome: "failure", reason };
    const completed = await completeWorkflowExecutionAsService(supabase, executionId, metadata);
    if (!completed.ok) {
      await failWorkflowExecutionAsService(supabase, executionId, `reschedule failed: ${reason}`, "workflow_failed");
    }
    return { success: false, reason };
  }

  const { data: existingAppointment } = await supabase
    .from("appointments")
    .select("id, status")
    .eq("id", input.appointmentId)
    .eq("organization_id", input.organizationId)
    .eq("contact_id", input.contactId)
    .maybeSingle();

  if (!existingAppointment) {
    return finishWithFailure("not_found");
  }
  if (existingAppointment.status !== "scheduled" && existingAppointment.status !== "confirmed") {
    return finishWithFailure("not_reschedulable");
  }

  const recheckEnd = new Date(new Date(input.endAt).getTime() + 60_000);
  const availability = await getAvailableSlots(supabase, { organizationId: input.organizationId, dateRangeStart: new Date(input.startAt), dateRangeEnd: recheckEnd }, undefined, calendarProvider);

  if (availability.status !== "available") {
    return finishWithFailure(availability.status === "booking_disabled" ? "not_reschedulable" : "configuration_error");
  }
  const slotStillOffered = availability.slots.some((slot) => slot.start_at === input.startAt && slot.end_at === input.endAt);
  if (!slotStillOffered) {
    return finishWithFailure("slot_unavailable");
  }

  // Pass 5B, Part A5: a reschedule always changes the time by definition
  // here (that's the whole point of this function), so any prior
  // confirmation for the old time must never silently carry over onto the
  // new one - see computeConfirmationInvalidationOnTimeChange's own comment.
  const invalidation = computeConfirmationInvalidationOnTimeChange(existingAppointment.status, true);

  const { data: updated, error: updateError } = await supabase
    .from("appointments")
    .update({ start_at: input.startAt, end_at: input.endAt, ...invalidation })
    .eq("id", input.appointmentId)
    .eq("organization_id", input.organizationId)
    .eq("contact_id", input.contactId)
    .in("status", ["scheduled", "confirmed"])
    .select("id")
    .maybeSingle();

  if (updateError || !updated) {
    // Same exclusion-constraint backstop bookAppointment's own insert
    // relies on - a race that slips past the recheck above still cannot
    // create an overlapping appointment.
    const reason: RescheduleAppointmentFailureReason = updateError?.code === "23P01" ? "slot_unavailable" : updateError ? "internal_error" : "not_found";
    return finishWithFailure(reason);
  }

  const metadata: RescheduleOutcomeMetadata = { outcome: "success", appointment_id: input.appointmentId, start_at: input.startAt, end_at: input.endAt };
  const completed = await completeWorkflowExecutionAsService(supabase, executionId, metadata);
  if (!completed.ok) {
    await failWorkflowExecutionAsService(supabase, executionId, "failed to record reschedule completion metadata", "workflow_failed");
  }

  await emitAppointmentLifecycleEventAsService(supabase, input.organizationId, input.appointmentId, "appointment.rescheduled", input.startAt, sendSmsFn);

  return { success: true, appointmentId: input.appointmentId, startAt: input.startAt, endAt: input.endAt, timezone };
}

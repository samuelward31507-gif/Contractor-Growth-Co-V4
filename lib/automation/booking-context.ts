import type { SupabaseClient } from "@supabase/supabase-js";
import { createAutomationEventAsService } from "./events";
import { startWorkflowExecutionAsService, completeWorkflowExecutionAsService } from "./executions";

/**
 * Pass 1 (booking loop completion): the durable, per-conversation memory
 * that lets a later customer reply ("2:30 works") resolve back to the exact
 * slots Trackpr most recently offered, and lets a reschedule request's
 * follow-up day/time reply be recognized as "for THIS appointment" rather
 * than a fresh booking. Deliberately reuses the existing
 * automation_events/workflow_executions tables and their existing
 * `metadata` jsonb column - no new table, no new column. Kept in its own
 * module (rather than inside the n8n-callback route or booking-reply.ts)
 * specifically to avoid a circular import: the route needs to WRITE
 * reschedule-aware offer metadata, and booking-reply.ts needs to READ it,
 * but booking-reply.ts also needs to import the route's own message
 * composers - this file has no dependency on either.
 */

export type BookingContext =
  | { type: "offer"; slots: { start_at: string; end_at: string }[]; title: string; rescheduleAppointmentId: string | null }
  | { type: "reschedule_awaiting_time"; appointmentId: string }
  | null;

type CheckAvailabilityMetadata = {
  booking_action?: string;
  availability_status?: string;
  offered_slots?: { start_at: string; end_at: string }[];
  offered_title?: string;
  reschedule_appointment_id?: string | null;
};

type RescheduleRequestedMetadata = {
  stage?: string;
  appointment_id?: string;
};

/**
 * Scans this conversation's most recent completed executions (newest
 * first) for the last relevant booking-context signal - either a
 * check_availability offer (with the real slots it actually presented) or
 * an open "customer asked to reschedule, awaiting a new day/time" request.
 * Whichever is more recent wins, exactly like every other "most recent
 * state" read in this codebase (e.g. getLastMessagesByConversation) - no
 * formal idempotency/expiry window, since the caller (booking-reply.ts)
 * always re-verifies live availability before acting on anything found
 * here, making a stale read safe by construction.
 */
export async function getRecentBookingContext(supabase: SupabaseClient, organizationId: string, conversationId: string): Promise<BookingContext> {
  const { data: events } = await supabase
    .from("automation_events")
    .select("id, event_type, created_at")
    .eq("organization_id", organizationId)
    .eq("entity_type", "conversation")
    .eq("entity_id", conversationId)
    .in("event_type", ["customer.message.received", "appointment.reschedule_requested", "appointment.availability_offered"])
    .order("created_at", { ascending: false })
    .limit(10);

  if (!events || events.length === 0) return null;

  const { data: executions } = await supabase
    .from("workflow_executions")
    .select("automation_event_id, metadata, started_at")
    .eq("organization_id", organizationId)
    .in(
      "automation_event_id",
      events.map((e) => e.id),
    )
    .eq("status", "completed")
    .order("started_at", { ascending: false });

  if (!executions) return null;

  const eventById = new Map(events.map((e) => [e.id, e]));

  for (const execution of executions) {
    const event = eventById.get(execution.automation_event_id);
    if (!event) continue;

    if (event.event_type === "appointment.reschedule_requested") {
      const metadata = (execution.metadata ?? {}) as RescheduleRequestedMetadata;
      if (metadata.stage === "awaiting_new_time" && metadata.appointment_id) {
        return { type: "reschedule_awaiting_time", appointmentId: metadata.appointment_id };
      }
      continue;
    }

    if (event.event_type === "customer.message.received") {
      const metadata = (execution.metadata ?? {}) as CheckAvailabilityMetadata;
      if (metadata.booking_action === "check_availability" && metadata.availability_status === "available" && metadata.offered_slots && metadata.offered_slots.length > 0) {
        return {
          type: "offer",
          slots: metadata.offered_slots,
          title: metadata.offered_title ?? "",
          rescheduleAppointmentId: metadata.reschedule_appointment_id ?? null,
        };
      }
    }

    if (event.event_type === "appointment.availability_offered") {
      const metadata = (execution.metadata ?? {}) as CheckAvailabilityMetadata;
      if (metadata.offered_slots && metadata.offered_slots.length > 0) {
        return {
          type: "offer",
          slots: metadata.offered_slots,
          title: metadata.offered_title ?? "",
          rescheduleAppointmentId: metadata.reschedule_appointment_id ?? null,
        };
      }
    }
  }

  return null;
}

/**
 * Records a fresh availability offer that did NOT originate from the normal
 * check_availability branch's own inbound customer.message.received event -
 * specifically, booking-reply.ts's "the slot you picked was just taken,
 * here's what's actually still open" re-offer. Its own dedicated event type
 * (rather than reusing customer.message.received, which requires a real
 * inbound-SMS event this synthetic re-offer doesn't have) keeps this fully
 * decoupled from the AI dispatch pipeline - Trackpr, not the AI, owns this
 * message end to end, exactly like every other deterministic composer in
 * this codebase.
 */
export async function recordFreshAvailabilityOffer(
  supabase: SupabaseClient,
  organizationId: string,
  conversationId: string,
  slots: { start_at: string; end_at: string }[],
  title: string,
  rescheduleAppointmentId: string | null,
): Promise<{ id: string } | null> {
  const eventResult = await createAutomationEventAsService(supabase, organizationId, {
    eventType: "appointment.availability_offered",
    entityType: "conversation",
    entityId: conversationId,
    payload: { conversation_id: conversationId },
    // Unique per call (not deduped across calls) - each stale-slot recovery
    // is a genuinely new offer, not a retry of a prior one.
    idempotencyKey: `appointment.availability_offered:${conversationId}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
  });
  if (!eventResult.ok || eventResult.duplicate || eventResult.skipped) return null;

  const executionResult = await startWorkflowExecutionAsService(supabase, eventResult.event.id, "appointment_availability_offered");
  if (!executionResult.ok) return null;

  await completeWorkflowExecutionAsService(supabase, executionResult.execution.id, {
    offered_slots: slots,
    offered_title: title,
    reschedule_appointment_id: rescheduleAppointmentId,
  });

  return { id: executionResult.execution.id };
}

/**
 * Opens a durable "this conversation asked to reschedule appointment X,
 * awaiting a new day/time" marker - read back by getRecentBookingContext
 * above once the customer names a day and the normal check_availability
 * flow runs. Idempotency key is anchored to the appointment's CURRENT
 * start_at, not just its id: a later, separate reschedule request for the
 * same appointment (after an earlier one already completed and changed
 * start_at) naturally gets a fresh key, while two "I need to reschedule"
 * messages sent back-to-back before anything else happens collapse into
 * one open request rather than flooding duplicate clarification sends.
 */
export async function openRescheduleContext(supabase: SupabaseClient, organizationId: string, conversationId: string, appointmentId: string, currentStartAtIso: string): Promise<{ opened: boolean }> {
  const eventResult = await createAutomationEventAsService(supabase, organizationId, {
    eventType: "appointment.reschedule_requested",
    entityType: "conversation",
    entityId: conversationId,
    payload: { appointment_id: appointmentId, conversation_id: conversationId },
    idempotencyKey: `appointment.reschedule_requested:${appointmentId}:${currentStartAtIso}`,
  });

  if (!eventResult.ok || eventResult.duplicate || eventResult.skipped) {
    return { opened: false };
  }

  const executionResult = await startWorkflowExecutionAsService(supabase, eventResult.event.id, "appointment_reschedule_context");
  if (!executionResult.ok) return { opened: false };

  await completeWorkflowExecutionAsService(supabase, executionResult.execution.id, { stage: "awaiting_new_time", appointment_id: appointmentId });
  return { opened: true };
}

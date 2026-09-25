import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { createAutomationEvent, createAutomationEventAsService } from "./events";
import { startWorkflowExecution, completeWorkflowExecution, failWorkflowExecution, startWorkflowExecutionAsService, completeWorkflowExecutionAsService } from "./executions";
import { triggerN8nWorkflow, type N8nWorkflowContract } from "./n8n";
import { evaluateOutboundGate } from "./outbound-gate";
import { sendOutboundMessage } from "@/lib/messaging/outbound";
import { findOrCreateOpenConversation } from "@/lib/conversations/queries";
import { getAppointment, type AppointmentStatus } from "@/lib/appointments/queries";
import { formatAppointmentDate, formatAppointmentTimeRange } from "@/lib/appointments/format";
import { getAiSettings, getBusinessProfile } from "@/lib/settings/queries";
import { notifyFounder } from "@/lib/notifications/founder";
import type { SendSmsInput, SendSmsResult } from "@/lib/automation/sms";

export const APPOINTMENT_CREATED_WORKFLOW = "appointment_created_followup";
export const APPOINTMENT_NO_SHOW_WORKFLOW = "appointment_no_show_followup";

export type AppointmentLifecycleEventType =
  | "appointment.completed"
  | "appointment.cancelled"
  | "appointment.rescheduled";

/**
 * Builds the shared, appointment-shaped automation_events.payload every
 * appointment automation event carries - the appointment's own facts, plus
 * whichever contact/conversation Trackpr resolved for messaging, so the
 * n8n-callback route (and the safe outbound gate) never has to re-derive
 * them from anything the AI/n8n could influence.
 */
function buildAppointmentPayload(
  appointment: NonNullable<Awaited<ReturnType<typeof getAppointment>>>,
  conversationId: string | null,
  timezone: string,
) {
  return {
    appointment_id: appointment.id,
    contact_id: appointment.contact_id,
    lead_id: appointment.lead_id,
    conversation_id: conversationId,
    title: appointment.title,
    start_at: appointment.start_at,
    end_at: appointment.end_at,
    status: appointment.status,
    notes: appointment.notes,
    // Pre-formatted in the organization's own timezone so n8n/the AI never
    // has to do timezone math itself (and can't get it wrong) - see
    // lib/appointments/format.ts, the same functions the Appointments UI
    // already renders with.
    date_label: formatAppointmentDate(appointment.start_at, timezone),
    time_label: formatAppointmentTimeRange(appointment.start_at, appointment.end_at, timezone),
  };
}

/**
 * Emits `appointment.created` and, on success, dispatches a confirmation
 * draft to n8n via the existing customer-facing workflow infrastructure.
 * Called from the appointments Server Action (app/(app)/appointments/actions.ts)
 * right after a successful insert - that action always has an authenticated
 * user session, so this uses the plain (non-service) event/execution helpers,
 * exactly like emitLeadCreatedFollowup did for the equivalent lead.created
 * flow. Never throws: a failure here must never fail appointment creation
 * itself (already committed by the caller).
 */
export async function emitAppointmentCreated(supabase: SupabaseClient, appointmentId: string): Promise<void> {
  const eventResult = await createAutomationEvent(supabase, {
    eventType: "appointment.created",
    entityType: "appointment",
    entityId: appointmentId,
    payload: { appointment_id: appointmentId },
    idempotencyKey: `appointment.created:${appointmentId}`,
  });

  if (!eventResult.ok) {
    console.error("[automation] failed to create appointment.created event", { appointmentId, error: eventResult.error });
    return;
  }
  if (eventResult.duplicate) return;
  if (eventResult.skipped) return;

  const organizationId = eventResult.event.organization_id;

  const appointment = await getAppointment(supabase, organizationId, appointmentId);
  if (!appointment) {
    console.error("[automation] appointment.created event created but appointment not found", { appointmentId });
    return;
  }

  const executionResult = await startWorkflowExecution(supabase, eventResult.event.id, APPOINTMENT_CREATED_WORKFLOW);
  if (!executionResult.ok) {
    console.error("[automation] failed to start appointment.created execution", { appointmentId, error: executionResult.error });
    return;
  }

  const businessProfile = await getBusinessProfile(supabase, organizationId);

  // Founder Notifications V1: fires once per genuinely new appointment.created
  // event - guarded by the `eventResult.duplicate`/`skipped` early returns
  // above, exactly the same idempotency every other automation in this
  // function already relies on. Independent of whether the customer-facing
  // AI confirmation message below ends up sent/blocked/failed - a booked
  // appointment is a booked appointment regardless of that message's fate.
  await notifyFounder(supabase, {
    organizationId,
    kind: "appointment_booked",
    summary: `"${appointment.title}" on ${formatAppointmentDate(appointment.start_at, businessProfile?.timezone ?? "UTC")}.`,
    detailPath: `/appointments/${appointmentId}`,
  });

  await dispatchAppointmentWorkflow(supabase, {
    organizationId,
    eventId: eventResult.event.id,
    eventType: "appointment.created",
    executionId: executionResult.execution.id,
    attempt: executionResult.execution.attempt,
    businessProfile,
    workflowName: APPOINTMENT_CREATED_WORKFLOW,
    appointment,
    asService: false,
  });
}

/**
 * Emits `appointment.no_show` and dispatches a reschedule-invitation draft
 * to n8n, mirroring emitAppointmentCreated. Called from the appointments
 * Server Action when an update transitions status into "no_show".
 */
export async function emitAppointmentNoShow(supabase: SupabaseClient, appointmentId: string): Promise<void> {
  const eventResult = await createAutomationEvent(supabase, {
    eventType: "appointment.no_show",
    entityType: "appointment",
    entityId: appointmentId,
    payload: { appointment_id: appointmentId },
    idempotencyKey: `appointment.no_show:${appointmentId}`,
  });

  if (!eventResult.ok) {
    console.error("[automation] failed to create appointment.no_show event", { appointmentId, error: eventResult.error });
    return;
  }
  if (eventResult.duplicate) return;
  if (eventResult.skipped) return;

  const organizationId = eventResult.event.organization_id;

  const appointment = await getAppointment(supabase, organizationId, appointmentId);
  if (!appointment) {
    console.error("[automation] appointment.no_show event created but appointment not found", { appointmentId });
    return;
  }

  const executionResult = await startWorkflowExecution(supabase, eventResult.event.id, APPOINTMENT_NO_SHOW_WORKFLOW);
  if (!executionResult.ok) {
    console.error("[automation] failed to start appointment.no_show execution", { appointmentId, error: executionResult.error });
    return;
  }

  await dispatchAppointmentWorkflow(supabase, {
    organizationId,
    eventId: eventResult.event.id,
    eventType: "appointment.no_show",
    executionId: executionResult.execution.id,
    attempt: executionResult.execution.attempt,
    workflowName: APPOINTMENT_NO_SHOW_WORKFLOW,
    appointment,
    asService: false,
  });
}

async function dispatchAppointmentWorkflow(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    eventId: string;
    eventType: "appointment.created" | "appointment.no_show";
    executionId: string;
    attempt: number;
    workflowName: string;
    appointment: NonNullable<Awaited<ReturnType<typeof getAppointment>>>;
    asService: boolean;
    /** Reuses an already-fetched profile (see emitAppointmentCreated, which needs it earlier for the founder notification too) rather than fetching it a second time. Fetched here when omitted. */
    businessProfile?: Awaited<ReturnType<typeof getBusinessProfile>>;
  },
): Promise<void> {
  const { organizationId, appointment } = input;

  const [aiSettings, businessProfile] = await Promise.all([
    getAiSettings(supabase, organizationId),
    input.businessProfile !== undefined ? Promise.resolve(input.businessProfile) : getBusinessProfile(supabase, organizationId),
  ]);

  const timezone = businessProfile?.timezone ?? "UTC";

  let conversationId: string | null = null;
  let contact: { id: string; first_name: string | null; last_name: string | null; phone: string | null; email: string | null } | null = null;

  if (appointment.contact_id) {
    contact = appointment.contact
      ? {
          id: appointment.contact.id,
          first_name: appointment.contact.first_name,
          last_name: appointment.contact.last_name,
          phone: appointment.contact.phone,
          email: appointment.contact.email,
        }
      : null;

    const conversation = await findOrCreateOpenConversation(
      supabase,
      organizationId,
      appointment.contact_id,
      "sms",
      appointment.lead_id,
    );
    conversationId = conversation?.id ?? null;
  }

  const contract: N8nWorkflowContract = {
    version: 1,
    event: {
      id: input.eventId,
      type: input.eventType,
      organization_id: organizationId,
      entity_type: "appointment",
      entity_id: appointment.id,
      payload: buildAppointmentPayload(appointment, conversationId, timezone),
    },
    execution: {
      id: input.executionId,
      workflow_name: input.workflowName,
      attempt: input.attempt,
    },
    context: {
      organization: {
        id: organizationId,
        name: businessProfile?.name ?? "",
        timezone,
      },
      ai: {
        enabled: aiSettings.ai_enabled,
        tone: aiSettings.tone,
        business_introduction: aiSettings.business_introduction,
        general_instructions: aiSettings.general_instructions,
      },
      contact,
    },
  };

  after(async () => {
    const dispatch = await triggerN8nWorkflow(contract);
    if (!dispatch.ok) {
      const failed = await failWorkflowExecution(supabase, input.executionId, dispatch.error, "n8n_dispatch_failed");
      if (!failed.ok) {
        console.error("[automation] failed to record appointment workflow dispatch failure", {
          executionId: input.executionId,
          dispatchError: dispatch.error,
          recordError: failed.error,
        });
      }
    }
  });
}

/**
 * Growth System Completion Pass 1: deterministic, Trackpr-composed message
 * bodies for the two lifecycle transitions that now send a customer-facing
 * message (cancelled/rescheduled) - never AI/n8n-drafted, matching this
 * codebase's own established precedent (composeReminderBody) that simple,
 * fact-only lifecycle notifications are pure fact-recitation with no
 * judgment call for a model to make.
 */
function composeCancellationBody(appointment: { title: string }, timezone: string, startAt: string): string {
  return `Your appointment "${appointment.title}" on ${formatAppointmentDate(startAt, timezone)} has been cancelled. Reply if you'd like to reschedule. Reply STOP to opt out of texts.`;
}

function composeRescheduledBody(appointment: { title: string }, timezone: string, startAt: string, endAt: string): string {
  return `Your appointment "${appointment.title}" has been moved to ${formatAppointmentDate(startAt, timezone)} at ${formatAppointmentTimeRange(startAt, endAt, timezone)}. Reply STOP to opt out of texts.`;
}

const CANCELLED_ELIGIBLE_STATUSES: AppointmentStatus[] = ["cancelled"];
const RESCHEDULED_ELIGIBLE_STATUSES: AppointmentStatus[] = ["scheduled", "confirmed"];

/**
 * Growth System Completion Pass 1: sends the deterministic cancellation/
 * reschedule notification through the exact same gate + sendOutboundMessage
 * path every other automated message uses - opt-out, duplicate-send
 * protection, and live appointment-status re-verification are all still
 * enforced, even though this message is never AI-drafted. Never blocks or
 * fails the lifecycle event itself (already recorded by the caller) - a
 * failure here is logged, not thrown.
 *
 * Deliberately uses its own internal service-role client rather than the
 * caller's (which, for emitAppointmentLifecycleEvent, is always a real user
 * session - see that function's own comment) - `messages` has no RLS UPDATE
 * policy at all (only service-role/the n8n-callback route ever transitions a
 * message from queued to sent/failed), so sendOutboundMessage's own status
 * update would silently affect zero rows under a session client. This
 * mirrors the exact same reasoning lib/calendar/connection.ts's
 * getFreshAccessToken already established for a privileged operation reached
 * from a caller that might only have a session client.
 */
async function sendAppointmentLifecycleMessage(
  organizationId: string,
  appointmentId: string,
  eventType: "appointment.cancelled" | "appointment.rescheduled",
  executionId: string,
  /** Test seam only - production callers must never pass this; see lib/messaging/outbound.ts. */
  sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult>,
): Promise<void> {
  const service = createServiceRoleClient();

  const fullAppointment = await getAppointment(service, organizationId, appointmentId);
  if (!fullAppointment) return;

  const businessProfile = await getBusinessProfile(service, organizationId);
  const timezone = businessProfile?.timezone ?? "UTC";

  let conversationId: string | null = null;
  if (fullAppointment.contact_id) {
    const conversation = await findOrCreateOpenConversation(service, organizationId, fullAppointment.contact_id, "sms", fullAppointment.lead_id);
    conversationId = conversation?.id ?? null;
  }

  const body =
    eventType === "appointment.cancelled"
      ? composeCancellationBody(fullAppointment, timezone, fullAppointment.start_at)
      : composeRescheduledBody(fullAppointment, timezone, fullAppointment.start_at, fullAppointment.end_at);

  const eligibleStatuses = eventType === "appointment.cancelled" ? CANCELLED_ELIGIBLE_STATUSES : RESCHEDULED_ELIGIBLE_STATUSES;

  const gateResult = await evaluateOutboundGate(service, {
    organizationId,
    executionId,
    contactId: fullAppointment.contact_id,
    conversationId,
    leadId: fullAppointment.lead_id,
    aiResult: { should_send: true, response_message: body, needs_human: false },
    appointmentId,
    appointmentEligibleStatuses: eligibleStatuses,
  });

  if (!gateResult.allowed) {
    console.error(`[automation] ${eventType} message blocked`, { appointmentId, reason: gateResult.reason });
    return;
  }

  const sendResult = await sendOutboundMessage(service, {
    organizationId,
    contactId: gateResult.contactId,
    conversationId: gateResult.conversationId,
    channel: "sms",
    body: gateResult.body,
    senderType: "ai",
    workflowExecutionId: executionId,
    sendSmsFn,
  });

  if (!sendResult.ok) {
    console.error(`[automation] failed to send ${eventType} message`, { appointmentId, error: sendResult.error });
  }
}

/**
 * Records the appointment.completed/appointment.cancelled/
 * appointment.rescheduled automation event. appointment.completed remains
 * lifecycle-only (created, started, completed, no message - unchanged, per
 * the original Phase 4.4 decision). appointment.cancelled and
 * appointment.rescheduled now ALSO send a deterministic, Trackpr-composed
 * customer notification (Growth System Completion Pass 1) - see
 * sendAppointmentLifecycleMessage above. `idempotencySuffix` lets
 * rescheduled events key on the appointment's current `updated_at` (the
 * smallest reliable "revision" proxy the existing schema supports), since
 * completed/cancelled don't need one (a given appointment can only complete
 * or get cancelled once) - this is also what prevents a duplicate message: a
 * retried/replayed call for the exact same transition resolves to the same
 * automation_events row (`eventResult.duplicate`) and is skipped below,
 * exactly like every other automation in this codebase.
 */
export async function emitAppointmentLifecycleEvent(
  supabase: SupabaseClient,
  appointmentId: string,
  eventType: AppointmentLifecycleEventType,
  idempotencySuffix?: string,
  /** Test seam only - production callers must never pass this; see lib/messaging/outbound.ts. */
  sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult>,
): Promise<void> {
  const idempotencyKey = idempotencySuffix
    ? `${eventType}:${appointmentId}:${idempotencySuffix}`
    : `${eventType}:${appointmentId}`;

  const eventResult = await createAutomationEvent(supabase, {
    eventType,
    entityType: "appointment",
    entityId: appointmentId,
    payload: { appointment_id: appointmentId },
    idempotencyKey,
  });

  if (!eventResult.ok) {
    console.error(`[automation] failed to create ${eventType} event`, { appointmentId, error: eventResult.error });
    return;
  }
  if (eventResult.duplicate) return;
  if (eventResult.skipped) return;

  const executionResult = await startWorkflowExecution(supabase, eventResult.event.id, `${eventType.replace(".", "_")}_lifecycle`);
  if (!executionResult.ok) {
    console.error(`[automation] failed to start ${eventType} execution`, { appointmentId, error: executionResult.error });
    return;
  }

  if (eventType === "appointment.cancelled" || eventType === "appointment.rescheduled") {
    await sendAppointmentLifecycleMessage(eventResult.event.organization_id, appointmentId, eventType, executionResult.execution.id, sendSmsFn);
  }

  const completed = await completeWorkflowExecution(supabase, executionResult.execution.id, {
    lifecycle_only: true,
    appointment_id: appointmentId,
  });
  if (!completed.ok) {
    console.error(`[automation] failed to complete ${eventType} execution`, { appointmentId, error: completed.error });
  }
}

/**
 * Pass 1 (booking loop completion): the *AsService twin of
 * emitAppointmentLifecycleEvent above, for callers with no Supabase Auth
 * session - lib/automation/booking-reply.ts's deterministic cancel/reschedule
 * handling, itself triggered from the inbound SMS webhook (Twilio-
 * authenticated, not a user JWT). Same lifecycle-only shape; the message
 * dispatch for cancelled/rescheduled reuses sendAppointmentLifecycleMessage
 * completely unchanged - that function already creates its own service-role
 * client internally regardless of caller context, so it needs no AsService
 * variant of its own.
 */
export async function emitAppointmentLifecycleEventAsService(
  supabase: SupabaseClient,
  organizationId: string,
  appointmentId: string,
  eventType: AppointmentLifecycleEventType,
  idempotencySuffix?: string,
  /** Test seam only - production callers must never pass this; see lib/messaging/outbound.ts. */
  sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult>,
): Promise<void> {
  const idempotencyKey = idempotencySuffix
    ? `${eventType}:${appointmentId}:${idempotencySuffix}`
    : `${eventType}:${appointmentId}`;

  const eventResult = await createAutomationEventAsService(supabase, organizationId, {
    eventType,
    entityType: "appointment",
    entityId: appointmentId,
    payload: { appointment_id: appointmentId },
    idempotencyKey,
  });

  if (!eventResult.ok) {
    console.error(`[automation] failed to create ${eventType} event`, { appointmentId, error: eventResult.error });
    return;
  }
  if (eventResult.duplicate) return;
  if (eventResult.skipped) return;

  const executionResult = await startWorkflowExecutionAsService(supabase, eventResult.event.id, `${eventType.replace(".", "_")}_lifecycle`);
  if (!executionResult.ok) {
    console.error(`[automation] failed to start ${eventType} execution`, { appointmentId, error: executionResult.error });
    return;
  }

  if (eventType === "appointment.cancelled" || eventType === "appointment.rescheduled") {
    await sendAppointmentLifecycleMessage(eventResult.event.organization_id, appointmentId, eventType, executionResult.execution.id, sendSmsFn);
  }

  const completed = await completeWorkflowExecutionAsService(supabase, executionResult.execution.id, {
    lifecycle_only: true,
    appointment_id: appointmentId,
  });
  if (!completed.ok) {
    console.error(`[automation] failed to complete ${eventType} execution`, { appointmentId, error: completed.error });
  }
}

export type CancelAppointmentAsServiceResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "not_cancellable" };

/**
 * Pass 1: the deterministic, service-role-safe appointment cancellation used
 * by lib/automation/booking-reply.ts's customer-initiated cancel flow.
 * Deliberately narrow: only cancels an appointment already in
 * scheduled/confirmed status, scoped by organization AND contact together
 * (never appointment id alone) so one customer's message can never affect
 * another customer's appointment. The conditional UPDATE itself is the
 * idempotency guard - a duplicate/replayed cancel request for an
 * already-cancelled appointment matches zero rows and is a safe no-op,
 * exactly like every other conditional-guard lock in this codebase.
 */
export async function cancelAppointmentAsService(
  supabase: SupabaseClient,
  organizationId: string,
  contactId: string,
  appointmentId: string,
  /** Test seam only - production callers must never pass this. */
  sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult>,
): Promise<CancelAppointmentAsServiceResult> {
  const { data: cancelledRow, error } = await supabase
    .from("appointments")
    .update({ status: "cancelled" })
    .eq("id", appointmentId)
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .in("status", ["scheduled", "confirmed"])
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("[automation] failed to cancel appointment", { appointmentId, organizationId, error: error.message });
    return { ok: false, reason: "not_cancellable" };
  }
  if (!cancelledRow) {
    return { ok: false, reason: "not_found" };
  }

  await emitAppointmentLifecycleEventAsService(supabase, organizationId, appointmentId, "appointment.cancelled", undefined, sendSmsFn);
  return { ok: true };
}

import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAutomationEvent } from "./events";
import { startWorkflowExecution, completeWorkflowExecution, failWorkflowExecution } from "./executions";
import { triggerN8nWorkflow, type N8nWorkflowContract } from "./n8n";
import { findOrCreateOpenConversation } from "@/lib/conversations/queries";
import { getAppointment } from "@/lib/appointments/queries";
import { formatAppointmentDate, formatAppointmentTimeRange } from "@/lib/appointments/format";
import { getAiSettings, getBusinessProfile } from "@/lib/settings/queries";

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

  await dispatchAppointmentWorkflow(supabase, {
    organizationId,
    eventId: eventResult.event.id,
    eventType: "appointment.created",
    executionId: executionResult.execution.id,
    attempt: executionResult.execution.attempt,
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
  },
): Promise<void> {
  const { organizationId, appointment } = input;

  const [aiSettings, businessProfile] = await Promise.all([
    getAiSettings(supabase, organizationId),
    getBusinessProfile(supabase, organizationId),
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
 * Records a lifecycle-only appointment automation event: created,
 * immediately started, immediately completed, with no AI generation and no
 * outbound message this phase. Used for appointment.completed,
 * appointment.cancelled, and appointment.rescheduled - none of which have an
 * explicit messaging requirement in Phase 4.4 (see the phase report for the
 * reasoning), but all of which still need a real, idempotent, queryable
 * automation-event record the same way every other lifecycle transition
 * does. `idempotencySuffix` lets rescheduled events key on the appointment's
 * current `updated_at` (the smallest reliable "revision" proxy the existing
 * schema supports - see the migration-free reasoning in the phase report),
 * since completed/cancelled don't need one (a given appointment can only
 * complete or get cancelled once).
 */
export async function emitAppointmentLifecycleEvent(
  supabase: SupabaseClient,
  appointmentId: string,
  eventType: AppointmentLifecycleEventType,
  idempotencySuffix?: string,
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

  const completed = await completeWorkflowExecution(supabase, executionResult.execution.id, {
    lifecycle_only: true,
    appointment_id: appointmentId,
  });
  if (!completed.ok) {
    console.error(`[automation] failed to complete ${eventType} execution`, { appointmentId, error: completed.error });
  }
}

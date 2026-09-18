import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAutomationEvent } from "./events";
import { startWorkflowExecution, completeWorkflowExecution, failWorkflowExecution } from "./executions";
import { triggerN8nWorkflow, type N8nWorkflowContract } from "./n8n";
import { findOrCreateOpenConversation } from "@/lib/conversations/queries";
import { getEstimate } from "@/lib/estimates/queries";
import { getAiSettings, getBusinessProfile } from "@/lib/settings/queries";

export const ESTIMATE_SENT_WORKFLOW = "estimate_sent_followup";

export type EstimateLifecycleEventType = "estimate.accepted" | "estimate.declined";

/**
 * Emits `estimate.sent` and dispatches an AI-drafted notification to n8n,
 * mirroring emitAppointmentCreated exactly. Called from
 * app/(app)/estimates/actions.ts's sendEstimate() - always has an
 * authenticated user session, so this uses the plain (non-service)
 * event/execution helpers. Never throws: a failure here must never fail the
 * estimate send itself (already committed by the caller).
 */
export async function emitEstimateSent(supabase: SupabaseClient, estimateId: string): Promise<void> {
  const eventResult = await createAutomationEvent(supabase, {
    eventType: "estimate.sent",
    entityType: "estimate",
    entityId: estimateId,
    payload: { estimate_id: estimateId },
    idempotencyKey: `estimate.sent:${estimateId}`,
  });

  if (!eventResult.ok) {
    console.error("[automation] failed to create estimate.sent event", { estimateId, error: eventResult.error });
    return;
  }
  if (eventResult.duplicate) return;

  const organizationId = eventResult.event.organization_id;

  const estimate = await getEstimate(supabase, organizationId, estimateId);
  if (!estimate) {
    console.error("[automation] estimate.sent event created but estimate not found", { estimateId });
    return;
  }

  const executionResult = await startWorkflowExecution(supabase, eventResult.event.id, ESTIMATE_SENT_WORKFLOW);
  if (!executionResult.ok) {
    console.error("[automation] failed to start estimate.sent execution", { estimateId, error: executionResult.error });
    return;
  }

  const [aiSettings, businessProfile] = await Promise.all([
    getAiSettings(supabase, organizationId),
    getBusinessProfile(supabase, organizationId),
  ]);

  let conversationId: string | null = null;
  let contact: { id: string; first_name: string | null; last_name: string | null; phone: string | null; email: string | null } | null = null;

  if (estimate.contact_id) {
    const { getContact } = await import("@/lib/contacts/queries");
    const fetchedContact = await getContact(supabase, organizationId, estimate.contact_id);
    contact = fetchedContact
      ? {
          id: fetchedContact.id,
          first_name: fetchedContact.first_name,
          last_name: fetchedContact.last_name,
          phone: fetchedContact.phone,
          email: fetchedContact.email,
        }
      : null;

    const conversation = await findOrCreateOpenConversation(
      supabase,
      organizationId,
      estimate.contact_id,
      "sms",
      estimate.lead_id,
    );
    conversationId = conversation?.id ?? null;
  }

  const contract: N8nWorkflowContract = {
    version: 1,
    event: {
      id: eventResult.event.id,
      type: "estimate.sent",
      organization_id: organizationId,
      entity_type: "estimate",
      entity_id: estimateId,
      payload: {
        estimate_id: estimateId,
        contact_id: estimate.contact_id,
        lead_id: estimate.lead_id,
        conversation_id: conversationId,
        title: estimate.title,
        status: estimate.status,
      },
    },
    execution: {
      id: executionResult.execution.id,
      workflow_name: ESTIMATE_SENT_WORKFLOW,
      attempt: executionResult.execution.attempt,
    },
    context: {
      organization: {
        id: organizationId,
        name: businessProfile?.name ?? "",
        timezone: businessProfile?.timezone ?? "UTC",
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

  const executionId = executionResult.execution.id;
  after(async () => {
    const dispatch = await triggerN8nWorkflow(contract);
    if (!dispatch.ok) {
      const failed = await failWorkflowExecution(supabase, executionId, dispatch.error);
      if (!failed.ok) {
        console.error("[automation] failed to record estimate.sent dispatch failure", {
          executionId,
          dispatchError: dispatch.error,
          recordError: failed.error,
        });
      }
    }
  });
}

/**
 * Records a lifecycle-only estimate automation event: created, immediately
 * started, immediately completed, no AI generation, no outbound message.
 * Used for estimate.accepted and estimate.declined, both triggered from
 * app/(app)/estimates/actions.ts (an authenticated user session, hence the
 * plain non-service event/execution helpers below) - neither has an
 * explicit messaging requirement in Phase 4.5, mirroring Phase 4.4's
 * identical treatment of appointment.completed/cancelled.
 *
 * estimate.expired is NOT emitted through this function - it fires from
 * the follow-up cron processor (lib/automation/estimate-followups.ts),
 * which has no user session and needs the *AsService RPC variants instead,
 * exactly the same session-vs-service-role split Phase 4.4 already
 * established between emitAppointmentLifecycleEvent (session) and
 * processAppointmentReminders (service-role).
 */
export async function emitEstimateLifecycleEvent(
  supabase: SupabaseClient,
  estimateId: string,
  eventType: EstimateLifecycleEventType,
): Promise<void> {
  const idempotencyKey = `${eventType}:${estimateId}`;

  const eventResult = await createAutomationEvent(supabase, {
    eventType,
    entityType: "estimate",
    entityId: estimateId,
    payload: { estimate_id: estimateId },
    idempotencyKey,
  });

  if (!eventResult.ok) {
    console.error(`[automation] failed to create ${eventType} event`, { estimateId, error: eventResult.error });
    return;
  }
  if (eventResult.duplicate) return;

  const executionResult = await startWorkflowExecution(supabase, eventResult.event.id, `${eventType.replace(".", "_")}_lifecycle`);
  if (!executionResult.ok) {
    console.error(`[automation] failed to start ${eventType} execution`, { estimateId, error: executionResult.error });
    return;
  }

  const completed = await completeWorkflowExecution(supabase, executionResult.execution.id, {
    lifecycle_only: true,
    estimate_id: estimateId,
  });
  if (!completed.ok) {
    console.error(`[automation] failed to complete ${eventType} execution`, { estimateId, error: completed.error });
  }
}

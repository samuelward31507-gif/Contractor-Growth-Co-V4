import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAutomationEvent, createAutomationEventAsService } from "./events";
import { startWorkflowExecution, completeWorkflowExecution, failWorkflowExecution, startWorkflowExecutionAsService, completeWorkflowExecutionAsService } from "./executions";
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
  // The estimate and its contact's open SMS conversation are resolved BEFORE
  // the event is created, so the stored payload carries contact_id and
  // conversation_id - the n8n callback re-derives send context only from the
  // stored event, and automation_events has no UPDATE policy to add them
  // afterward. Same pattern as emitPostJobFollowup. lead_id is deliberately
  // not stored (the outbound gate would then also require the conversation's
  // lead_id to match). The organization is read from the estimate itself
  // (RLS-scoped to the caller's organization).
  const { data: estimateOrg } = await supabase.from("estimates").select("organization_id").eq("id", estimateId).maybeSingle();
  const estimate = estimateOrg?.organization_id ? await getEstimate(supabase, estimateOrg.organization_id as string, estimateId) : null;
  if (!estimate) {
    console.error("[automation] estimate.sent requested but estimate not found", { estimateId });
    return;
  }
  const conversation = estimate.contact_id
    ? await findOrCreateOpenConversation(supabase, estimate.organization_id, estimate.contact_id, "sms", estimate.lead_id)
    : null;
  const conversationId = conversation?.id ?? null;

  const eventResult = await createAutomationEvent(supabase, {
    eventType: "estimate.sent",
    entityType: "estimate",
    entityId: estimateId,
    payload: { estimate_id: estimateId, contact_id: estimate.contact_id, conversation_id: conversationId },
    idempotencyKey: `estimate.sent:${estimateId}`,
  });

  if (!eventResult.ok) {
    console.error("[automation] failed to create estimate.sent event", { estimateId, error: eventResult.error });
    return;
  }
  if (eventResult.duplicate) return;
  if (eventResult.skipped) return;

  const organizationId = eventResult.event.organization_id;

  const executionResult = await startWorkflowExecution(supabase, eventResult.event.id, ESTIMATE_SENT_WORKFLOW);
  if (!executionResult.ok) {
    console.error("[automation] failed to start estimate.sent execution", { estimateId, error: executionResult.error });
    return;
  }

  const [aiSettings, businessProfile] = await Promise.all([
    getAiSettings(supabase, organizationId),
    getBusinessProfile(supabase, organizationId),
  ]);

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
      const failed = await failWorkflowExecution(supabase, executionId, dispatch.error, "n8n_dispatch_failed");
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
  if (eventResult.skipped) return;

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

/**
 * E1 (pre-launch lead-leak audit): the *AsService twin of
 * emitEstimateLifecycleEvent above, for the one caller with no Supabase Auth
 * session - lib/automation/estimate-reply.ts's classifyAndProcessEstimateReply,
 * itself called from the inbound SMS webhook (Twilio-authenticated, not a
 * user JWT). Same lifecycle-only shape (create, start, immediately complete,
 * no AI generation, no outbound message here) as the session variant -
 * kept as its own function rather than a shared internal helper, matching
 * this codebase's established *AsService-sibling convention throughout
 * lib/automation/*.
 */
export async function emitEstimateLifecycleEventAsService(
  supabase: SupabaseClient,
  organizationId: string,
  estimateId: string,
  eventType: EstimateLifecycleEventType,
): Promise<void> {
  const idempotencyKey = `${eventType}:${estimateId}`;

  const eventResult = await createAutomationEventAsService(supabase, organizationId, {
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
  if (eventResult.skipped) return;

  const executionResult = await startWorkflowExecutionAsService(supabase, eventResult.event.id, `${eventType.replace(".", "_")}_lifecycle`);
  if (!executionResult.ok) {
    console.error(`[automation] failed to start ${eventType} execution`, { estimateId, error: executionResult.error });
    return;
  }

  const completed = await completeWorkflowExecutionAsService(supabase, executionResult.execution.id, {
    lifecycle_only: true,
    estimate_id: estimateId,
  });
  if (!completed.ok) {
    console.error(`[automation] failed to complete ${eventType} execution`, { estimateId, error: completed.error });
  }
}

import type { SupabaseClient } from "@supabase/supabase-js";
import { triggerN8nWorkflow, type N8nWorkflowContract } from "./n8n";
import { failWorkflowExecution } from "./executions";
import { getAiSettings, getBusinessProfile } from "@/lib/settings/queries";
import { getContact } from "@/lib/contacts/queries";

export type RetryEventContext = {
  id: string;
  organizationId: string;
  eventType: string;
  entityType: string | null;
  entityId: string | null;
  payload: Record<string, unknown>;
};

export type RetryExecutionContext = {
  id: string;
  workflow_name: string;
  attempt: number;
};

/**
 * Generic n8n redispatch for a retried execution.
 *
 * SAFETY-VERIFIED FOR EXACTLY ONE WORKFLOW: lead_created_followup
 * (instant-lead-followup). A post-Phase-E audit (see the Phase E review
 * report) compared this function's reconstruction against every
 * n8n-dispatched automation's actual event-creation code and found that for
 * every OTHER n8n workflow (customer_reply_followup, appointment_created_
 * followup, appointment_no_show_followup, estimate_sent_followup,
 * job_created_followup, post_job_followup, lead_lost_nurture_followup,
 * lead_reactivation_followup), the automation_events.payload column this
 * function reconstructs `contract.event.payload` from is NOT the same
 * object the original dispatch sent to n8n - the original always fetches a
 * far richer payload fresh from the entity's own table (appointment/job/
 * estimate details, conversation history, lead service/source/summary,
 * etc.) at dispatch time and never persists that richer object back to
 * automation_events. Sending this function's reconstruction for any of
 * those workflows would deliver an impoverished contract to n8n, silently
 * degrading or breaking the AI's draft.
 *
 * lead_created_followup is the sole exception: lead-followup.ts's stored
 * automation_events.payload is passed to its own contract's event.payload
 * completely unchanged (`payload: eventResult.event.payload`), so this
 * function's reconstruction is byte-for-byte faithful for that one
 * workflow. lib/automation/retry-eligibility.ts's SAFE_RETRY_AUTOMATION_IDS
 * allowlist is the actual enforcement point - it only ever lets this
 * function be reached for that one verified-safe case. This function is
 * intentionally left in place, generic and documented, as the correct
 * starting point for a future phase that enriches every automation_events
 * payload to match its real contract - not deleted, but not safe to call
 * for anything the eligibility gate doesn't already allow through.
 *
 * Runs with the caller's own session client (retry always runs in a real
 * admin session, never a webhook/cron context), so a synchronous dispatch
 * failure is recorded via the session-scoped failWorkflowExecution (which
 * re-verifies is_org_member), not the AsService variant.
 */
export async function redispatchToN8n(
  supabase: SupabaseClient,
  event: RetryEventContext,
  execution: RetryExecutionContext,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const [aiSettings, businessProfile] = await Promise.all([
    getAiSettings(supabase, event.organizationId),
    getBusinessProfile(supabase, event.organizationId),
  ]);

  const contactId = typeof event.payload?.contact_id === "string" ? (event.payload.contact_id as string) : null;
  const contact = contactId ? await getContact(supabase, event.organizationId, contactId) : null;

  const contract: N8nWorkflowContract = {
    version: 1,
    event: {
      id: event.id,
      type: event.eventType,
      organization_id: event.organizationId,
      entity_type: event.entityType,
      entity_id: event.entityId,
      payload: event.payload,
    },
    execution: {
      id: execution.id,
      workflow_name: execution.workflow_name,
      attempt: execution.attempt,
    },
    context: {
      organization: {
        id: event.organizationId,
        name: businessProfile?.name ?? "",
        timezone: businessProfile?.timezone ?? "UTC",
      },
      ai: {
        enabled: aiSettings.ai_enabled,
        tone: aiSettings.tone,
        business_introduction: aiSettings.business_introduction,
        general_instructions: aiSettings.general_instructions,
      },
      contact: contact
        ? { id: contact.id, first_name: contact.first_name, last_name: contact.last_name, phone: contact.phone, email: contact.email }
        : null,
    },
  };

  const dispatch = await triggerN8nWorkflow(contract);
  if (!dispatch.ok) {
    await failWorkflowExecution(supabase, execution.id, dispatch.error, "n8n_dispatch_failed");
    return { ok: false, error: dispatch.error };
  }
  return { ok: true };
}

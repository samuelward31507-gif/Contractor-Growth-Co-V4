import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAutomationEvent } from "./events";
import { startWorkflowExecution, failWorkflowExecution } from "./executions";
import { triggerN8nWorkflow, type N8nWorkflowContract } from "./n8n";
import { getContact } from "@/lib/contacts/queries";
import { findOrCreateOpenConversation } from "@/lib/conversations/queries";
import { getAiSettings, getBusinessProfile } from "@/lib/settings/queries";
import type { LeadStatus, LeadTemperature } from "@/lib/leads/queries";

export const LEAD_CREATED_FOLLOWUP_WORKFLOW = "lead_created_followup";

export type LeadCreatedInput = {
  leadId: string;
  contactId: string;
  organizationId: string;
  source: string | null;
  service: string;
  status: LeadStatus;
  temperature: LeadTemperature;
  estimatedValue: number | null;
};

/**
 * Emits `lead.created` and, if that succeeds, starts the
 * lead_created_followup workflow execution and dispatches it to n8n.
 *
 * Called from createLead() right after the insert succeeds, using the same
 * already-authenticated request-scoped supabase client - createAutomationEvent
 * and startWorkflowExecution both require a real auth.uid(), which this
 * request already has. This function never throws: a failure here must never
 * fail lead creation, since the lead row is the source of truth and the
 * automation is best-effort infrastructure layered on top of it. Failures
 * are logged server-side so they're visible in production logs rather than
 * silently disappearing.
 */
export async function emitLeadCreatedFollowup(
  supabase: SupabaseClient,
  input: LeadCreatedInput,
): Promise<void> {
  // Instant Lead Follow-Up V1 (Safe Automatic SMS): the conversation is
  // found/created *before* the event is stored, and its id is included in
  // the persisted automation_events.payload - not only in the transient
  // n8n dispatch contract - because the n8n callback route derives
  // contactId/conversationId for the outbound gate from the DATABASE row's
  // payload (a fresh join on workflow_executions.automation_events), never
  // from anything embedded in the callback request body itself. Omitting
  // it here (as this function previously did, when should_send was always
  // hardcoded false in n8n and nothing ever needed it) would make every
  // real send attempt fail closed on "missing_conversation_id" - confirmed
  // by a real, controlled draft-workflow execution during this feature's
  // implementation, not assumed.
  const conversation = await findOrCreateOpenConversation(supabase, input.organizationId, input.contactId, "sms", input.leadId);

  const eventResult = await createAutomationEvent(supabase, {
    eventType: "lead.created",
    entityType: "lead",
    entityId: input.leadId,
    payload: {
      lead_id: input.leadId,
      contact_id: input.contactId,
      conversation_id: conversation?.id ?? null,
      organization_id: input.organizationId,
      source: input.source,
      service: input.service,
      status: input.status,
      temperature: input.temperature,
      estimated_value: input.estimatedValue,
    },
    // Deterministic and derivable again from the lead id alone, so a retried
    // request or a future reconciliation pass can call this again for the
    // same lead without ever creating a second lead.created event.
    idempotencyKey: `lead.created:${input.leadId}`,
  });

  if (!eventResult.ok) {
    console.error("[automation] failed to create lead.created event", { leadId: input.leadId, error: eventResult.error });
    return;
  }

  if (eventResult.duplicate) {
    // An event for this lead id already existed - a workflow execution was
    // already started the first time this ran. Starting a second one here
    // would be duplicate work, not a retry.
    return;
  }
  if (eventResult.skipped) return;

  const executionResult = await startWorkflowExecution(
    supabase,
    eventResult.event.id,
    LEAD_CREATED_FOLLOWUP_WORKFLOW,
  );

  if (!executionResult.ok) {
    console.error("[automation] failed to start workflow execution", {
      eventId: eventResult.event.id,
      error: executionResult.error,
    });
    return;
  }

  const executionId = executionResult.execution.id;
  const attempt = executionResult.execution.attempt;
  const eventId = eventResult.event.id;

  const [contact, aiSettings, businessProfile] = await Promise.all([
    getContact(supabase, input.organizationId, input.contactId),
    getAiSettings(supabase, input.organizationId),
    getBusinessProfile(supabase, input.organizationId),
  ]);

  const contract: N8nWorkflowContract = {
    version: 1,
    event: {
      id: eventId,
      type: "lead.created",
      organization_id: input.organizationId,
      entity_type: "lead",
      entity_id: input.leadId,
      payload: eventResult.event.payload,
    },
    execution: {
      id: executionId,
      workflow_name: LEAD_CREATED_FOLLOWUP_WORKFLOW,
      attempt,
    },
    context: {
      organization: {
        id: input.organizationId,
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
        ? {
            id: contact.id,
            first_name: contact.first_name,
            last_name: contact.last_name,
            phone: contact.phone,
            email: contact.email,
          }
        : null,
    },
  };

  // The DB work above (event + execution) is fast and already committed by
  // this point - only the outbound network call to n8n is deferred, so lead
  // creation is never slowed down by, or coupled to, an external system's
  // latency or an outage. Any failure to dispatch (unconfigured, network
  // error, non-2xx response) is recorded as a failed execution here - the
  // execution can never be left silently "running" because of a dispatch
  // failure, only because n8n accepted the request and its own workflow
  // hasn't called back yet (a separate, documented limitation).
  after(async () => {
    const dispatch = await triggerN8nWorkflow(contract);
    if (!dispatch.ok) {
      const failed = await failWorkflowExecution(supabase, executionId, dispatch.error);
      if (!failed.ok) {
        console.error("[automation] failed to record dispatch failure", {
          executionId,
          dispatchError: dispatch.error,
          recordError: failed.error,
        });
      }
    }
  });
}

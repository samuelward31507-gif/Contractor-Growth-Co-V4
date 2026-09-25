import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAutomationEvent, createAutomationEventAsService } from "./events";
import { startWorkflowExecution, failWorkflowExecution, startWorkflowExecutionAsService, failWorkflowExecutionAsService } from "./executions";
import { triggerN8nWorkflow, type N8nWorkflowContract } from "./n8n";
import { getAutomationForWorkflowName } from "./catalog";
import { recordAutomationHealthSignal } from "../automation-health/service";
import { getContact } from "@/lib/contacts/queries";
import { findOrCreateOpenConversation } from "@/lib/conversations/queries";
import { getAiSettings, getBusinessProfile } from "@/lib/settings/queries";
import type { LeadStatus, LeadTemperature } from "@/lib/leads/queries";
import type { OrganizationVertical } from "@/lib/auth/organization";

export const LEAD_CREATED_FOLLOWUP_WORKFLOW = "lead_created_followup";

/** L4 (pre-launch lead-leak audit): resolved once, reused by both failure-signal call sites in both functions below. */
const LEAD_CREATED_AUTOMATION = getAutomationForWorkflowName(LEAD_CREATED_FOLLOWUP_WORKFLOW);

/**
 * L4: the lead itself is already durably committed by the time either
 * emitLeadCreatedFollowup or emitLeadCreatedFollowupAsService can fail (see
 * each function's own header comment) - if the automation_event RPC or the
 * subsequent workflow-execution-start RPC then fails, nothing durable ever
 * recorded that fact anywhere else: the existing stuck-execution health scan
 * (app/api/automation/health/route.ts) only ever looks at workflow_executions
 * rows already in status='running', which don't exist for either failure
 * boundary here. Reuses the existing n8n_dispatch_failed category (this IS a
 * failure to get the lead's automation dispatched, just at an earlier step
 * than the n8n network call itself) rather than adding a new one.
 * Fingerprinted on the lead id alone (not the failure stage) so a lead that
 * fails repeatedly - at either boundary, across retries - collapses into one
 * incident whose occurrence_count increments and whose metadata reflects the
 * most recent failure, exactly like every other category's own dedup
 * behavior, never a flood. Best-effort and non-throwing throughout -
 * recordAutomationHealthSignal itself already never throws, and this
 * function never awaits it in a way that could let a signal-recording
 * failure change lead-creation's own success/failure outcome.
 */
async function emitLeadDispatchFailureSignal(
  supabase: SupabaseClient,
  input: { organizationId: string; leadId: string; eventId?: string; failureStage: "event_creation" | "workflow_execution_start"; error: string },
): Promise<void> {
  await recordAutomationHealthSignal(supabase, {
    organizationId: input.organizationId,
    category: "n8n_dispatch_failed",
    severity: "warning",
    fingerprintContext: input.leadId,
    title: `${LEAD_CREATED_AUTOMATION?.name ?? LEAD_CREATED_FOLLOWUP_WORKFLOW} dispatch failed`,
    description: input.error,
    automationId: LEAD_CREATED_AUTOMATION?.id ?? null,
    metadata: {
      leadId: input.leadId,
      organizationId: input.organizationId,
      eventId: input.eventId ?? null,
      failureStage: input.failureStage,
      error: input.error,
    },
  });
}

/**
 * Gym Phase 2B.1: resolves organizations.vertical directly by id, rather
 * than via lib/auth/organization.ts's getUserOrganization (which needs a
 * user id emitLeadCreatedFollowupAsService's caller doesn't have - see that
 * function's own comment on why it can't use a session-scoped lookup).
 * Fails closed to "contractor" for a missing/unrecognized value, mirroring
 * lib/auth/organization.ts's own resolveOrganization() convention exactly.
 */
export async function resolveOrganizationVertical(supabase: SupabaseClient, organizationId: string): Promise<OrganizationVertical> {
  const { data } = await supabase.from("organizations").select("vertical").eq("id", organizationId).maybeSingle();
  return data?.vertical === "gym" ? "gym" : "contractor";
}

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
    await emitLeadDispatchFailureSignal(supabase, { organizationId: input.organizationId, leadId: input.leadId, failureStage: "event_creation", error: eventResult.error });
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
    await emitLeadDispatchFailureSignal(supabase, { organizationId: input.organizationId, leadId: input.leadId, eventId: eventResult.event.id, failureStage: "workflow_execution_start", error: executionResult.error });
    return;
  }

  const executionId = executionResult.execution.id;
  const attempt = executionResult.execution.attempt;
  const eventId = eventResult.event.id;

  const [contact, aiSettings, businessProfile, vertical] = await Promise.all([
    getContact(supabase, input.organizationId, input.contactId),
    getAiSettings(supabase, input.organizationId),
    getBusinessProfile(supabase, input.organizationId),
    resolveOrganizationVertical(supabase, input.organizationId),
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
        vertical,
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
      const failed = await failWorkflowExecution(supabase, executionId, dispatch.error, "n8n_dispatch_failed");
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

/**
 * First-Client Lead Capture: identical to emitLeadCreatedFollowup above,
 * except it uses the *AsService event/execution helpers throughout - for
 * exactly the same reason lib/automation/customer-reply.ts's
 * emitCustomerReplyFollowup does: this is called from an external-lead-intake
 * webhook route (app/api/leads/capture/[token]/route.ts), which has no
 * Supabase Auth session (the caller is an external lead source authenticated
 * by the organization's own intake token, not a logged-in user), so the
 * plain createAutomationEvent/startWorkflowExecution above - which require
 * auth.uid() - cannot be used here. Kept as its own complete function rather
 * than factored out into a shared helper, matching how this codebase already
 * keeps every other *AsService variant (events.ts, executions.ts,
 * customer-reply.ts) independently readable rather than introducing a new
 * shared-core abstraction.
 */
export async function emitLeadCreatedFollowupAsService(
  supabase: SupabaseClient,
  input: LeadCreatedInput,
): Promise<void> {
  const conversation = await findOrCreateOpenConversation(supabase, input.organizationId, input.contactId, "sms", input.leadId);

  const eventResult = await createAutomationEventAsService(supabase, input.organizationId, {
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
    idempotencyKey: `lead.created:${input.leadId}`,
  });

  if (!eventResult.ok) {
    console.error("[automation] failed to create lead.created event", { leadId: input.leadId, error: eventResult.error });
    await emitLeadDispatchFailureSignal(supabase, { organizationId: input.organizationId, leadId: input.leadId, failureStage: "event_creation", error: eventResult.error });
    return;
  }

  if (eventResult.duplicate) return;
  if (eventResult.skipped) return;

  const executionResult = await startWorkflowExecutionAsService(
    supabase,
    eventResult.event.id,
    LEAD_CREATED_FOLLOWUP_WORKFLOW,
  );

  if (!executionResult.ok) {
    console.error("[automation] failed to start workflow execution", {
      eventId: eventResult.event.id,
      error: executionResult.error,
    });
    await emitLeadDispatchFailureSignal(supabase, { organizationId: input.organizationId, leadId: input.leadId, eventId: eventResult.event.id, failureStage: "workflow_execution_start", error: executionResult.error });
    return;
  }

  const executionId = executionResult.execution.id;
  const attempt = executionResult.execution.attempt;
  const eventId = eventResult.event.id;

  const [contact, aiSettings, businessProfile, vertical] = await Promise.all([
    getContact(supabase, input.organizationId, input.contactId),
    getAiSettings(supabase, input.organizationId),
    getBusinessProfile(supabase, input.organizationId),
    resolveOrganizationVertical(supabase, input.organizationId),
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
        vertical,
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

  after(async () => {
    const dispatch = await triggerN8nWorkflow(contract);
    if (!dispatch.ok) {
      const failed = await failWorkflowExecutionAsService(supabase, executionId, dispatch.error, "n8n_dispatch_failed");
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

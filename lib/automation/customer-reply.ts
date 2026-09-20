import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAutomationEventAsService } from "./events";
import { startWorkflowExecutionAsService, failWorkflowExecutionAsService } from "./executions";
import { triggerN8nWorkflow, type N8nWorkflowContract } from "./n8n";
import { getAutomationConfig, readInboundCustomerReplyConfig, type InboundCustomerReplyConfig } from "./settings";
import { getMessages, type Message } from "@/lib/conversations/queries";
import { getContact } from "@/lib/contacts/queries";
import { getLead } from "@/lib/leads/queries";
import { getAiSettings, getBusinessProfile } from "@/lib/settings/queries";

export const CUSTOMER_REPLY_FOLLOWUP_WORKFLOW = "customer_reply_followup";

export type ContractRecentMessage = { direction: Message["direction"]; sender_type: Message["sender_type"]; body: string; created_at: string };

/**
 * The pure decision behind how many, and which, recent conversation
 * messages are included in the n8n contract - extracted so "the configured
 * recent_message_window is what decides the slice, not the old hardcoded
 * constant" can be unit tested directly, without a mocked Supabase client.
 * Always keeps the most recent messages (chronological tail), matching the
 * original `recentMessages.slice(-RECENT_MESSAGE_WINDOW)` behavior exactly.
 */
export function selectRecentMessages(messages: Message[], config: InboundCustomerReplyConfig): ContractRecentMessage[] {
  return messages.slice(-config.recent_message_window).map((message) => ({
    direction: message.direction,
    sender_type: message.sender_type,
    body: message.body,
    created_at: message.created_at,
  }));
}

export type CustomerReplyInput = {
  organizationId: string;
  contactId: string;
  conversationId: string;
  leadId: string | null;
  messageBody: string;
  /** Twilio MessageSid - the deterministic idempotency source for this event. */
  providerMessageId: string;
};

/**
 * Emits `customer.message.received` and, if that succeeds, starts the
 * customer_reply_followup workflow execution and dispatches it to n8n.
 *
 * Called from the inbound SMS webhook (app/api/webhooks/sms/inbound) after
 * it has already persisted the inbound message - and only for a normal
 * message, never for STOP/START/HELP. That route has no Supabase Auth
 * session (Twilio authenticates it via HMAC signature, not a user JWT), so
 * this uses the *AsService variants throughout, exactly like the n8n
 * callback route already does for execution completion. Mirrors
 * emitLeadCreatedFollowup's shape and guarantees: never throws, a failure
 * here must never fail inbound message persistence (already committed by
 * the caller), and the outbound n8n call is deferred via after() so the
 * webhook response to Twilio is never slowed down by it.
 */
export async function emitCustomerReplyFollowup(
  supabase: SupabaseClient,
  input: CustomerReplyInput,
): Promise<void> {
  // Fast-Track Production Readiness, Pass 2: durable needs_human lockout.
  // A conversation staff has taken over (ai_enabled:false, set automatically
  // the moment any prior AI result said needs_human, or manually via the
  // conversation's own "Disable AI" toggle) must never even be dispatched to
  // n8n for a fresh AI draft - the outbound gate would block the resulting
  // send anyway, but skipping dispatch entirely avoids burning an AI call
  // and an execution row for a conversation a human is already handling.
  const { data: lockedConversation } = await supabase
    .from("conversations")
    .select("ai_enabled")
    .eq("id", input.conversationId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();

  if (lockedConversation?.ai_enabled === false) return;

  const eventResult = await createAutomationEventAsService(supabase, input.organizationId, {
    eventType: "customer.message.received",
    entityType: "conversation",
    entityId: input.conversationId,
    payload: {
      conversation_id: input.conversationId,
      contact_id: input.contactId,
      lead_id: input.leadId,
      organization_id: input.organizationId,
      message_body: input.messageBody,
      provider_message_id: input.providerMessageId,
    },
    // Deterministic and derivable again from the inbound provider message id
    // alone, scoped to the organization by the RPC's own unique index - a
    // replayed/retried Twilio webhook delivery for the same MessageSid
    // resolves to the same automation_events row instead of a duplicate.
    idempotencyKey: `customer.message.received:${input.providerMessageId}`,
  });

  if (!eventResult.ok) {
    console.error("[automation] failed to create customer.message.received event", {
      providerMessageId: input.providerMessageId,
      error: eventResult.error,
    });
    return;
  }

  if (eventResult.duplicate) {
    // A replayed inbound webhook delivery - a workflow execution was already
    // started the first time this MessageSid arrived. Starting a second one
    // here would be duplicate work, not a retry.
    return;
  }
  if (eventResult.skipped) return;

  const executionResult = await startWorkflowExecutionAsService(
    supabase,
    eventResult.event.id,
    CUSTOMER_REPLY_FOLLOWUP_WORKFLOW,
  );

  if (!executionResult.ok) {
    console.error("[automation] failed to start customer reply workflow execution", {
      eventId: eventResult.event.id,
      error: executionResult.error,
    });
    return;
  }

  const executionId = executionResult.execution.id;
  const attempt = executionResult.execution.attempt;
  const eventId = eventResult.event.id;

  const [recentMessages, contact, lead, aiSettings, businessProfile, rawConfig] = await Promise.all([
    getMessages(supabase, input.organizationId, input.conversationId),
    getContact(supabase, input.organizationId, input.contactId),
    input.leadId ? getLead(supabase, input.organizationId, input.leadId) : Promise.resolve(null),
    getAiSettings(supabase, input.organizationId),
    getBusinessProfile(supabase, input.organizationId),
    getAutomationConfig(supabase, input.organizationId, "inbound-customer-reply"),
  ]);

  // Automation Configuration V2.1: only changes how many recent messages are
  // included in the AI's context below - no effect on event creation,
  // idempotency, execution creation, authorization, or anything past this
  // point (the outbound gate, content safety, opt-out, and send path are
  // untouched by this value).
  const boundedRecentMessages = selectRecentMessages(recentMessages, readInboundCustomerReplyConfig(rawConfig));

  const contract: N8nWorkflowContract = {
    version: 1,
    event: {
      id: eventId,
      type: "customer.message.received",
      organization_id: input.organizationId,
      entity_type: "conversation",
      entity_id: input.conversationId,
      payload: {
        conversation_id: input.conversationId,
        contact_id: input.contactId,
        lead_id: input.leadId,
        latest_message: input.messageBody,
        recent_messages: boundedRecentMessages,
        lead: lead
          ? {
              service: lead.service,
              status: lead.status,
              temperature: lead.temperature,
              ai_summary: lead.ai_summary,
            }
          : null,
      },
    },
    execution: {
      id: executionId,
      workflow_name: CUSTOMER_REPLY_FOLLOWUP_WORKFLOW,
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

  // The DB work above (event + execution) is already committed by this
  // point - only the outbound network call to n8n is deferred, so the
  // webhook's response to Twilio is never slowed down by, or coupled to, an
  // external system's latency or an outage. Any dispatch failure is
  // recorded as a failed execution here, matching emitLeadCreatedFollowup.
  after(async () => {
    const dispatch = await triggerN8nWorkflow(contract);
    if (!dispatch.ok) {
      const failed = await failWorkflowExecutionAsService(supabase, executionId, dispatch.error, "n8n_dispatch_failed");
      if (!failed.ok) {
        console.error("[automation] failed to record customer reply dispatch failure", {
          executionId,
          dispatchError: dispatch.error,
          recordError: failed.error,
        });
      }
    }
  });
}

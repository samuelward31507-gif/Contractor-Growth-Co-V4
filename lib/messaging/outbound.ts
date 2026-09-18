import type { SupabaseClient } from "@supabase/supabase-js";
import { findOrCreateOpenConversation, type ConversationChannel, type MessageSenderType } from "@/lib/conversations/queries";
import { sendSms } from "@/lib/automation/sms";

export type SendOutboundMessageInput = {
  organizationId: string;
  contactId: string;
  /** Reuses this conversation if given; otherwise finds/opens the contact's open thread on `channel`. */
  conversationId?: string | null;
  channel?: ConversationChannel;
  body: string;
  senderType?: MessageSenderType;
  /** Ties this message back to the exact automation run that produced it, when applicable. */
  workflowExecutionId?: string | null;
};

export type SendOutboundMessageResult =
  | { ok: true; messageId: string; conversationId: string; providerMessageId: string }
  | { ok: false; error: string; messageId: string | null; conversationId: string | null };

/**
 * The single path every outbound SMS send must go through, whatever
 * triggered it (n8n callback today, a future in-app compose action, a
 * future AI inbound-reply handler). Trackpr's `messages` table is always
 * updated before/after the provider call - `sendSms()` (still an
 * unconfigured stub) is only ever the transport, never the source of truth.
 * Works with either an RLS-scoped user-session client or a service-role
 * client; the caller is responsible for having already authorized the
 * request, exactly like every other function in this codebase that accepts
 * a bare `organizationId`.
 */
export async function sendOutboundMessage(
  supabase: SupabaseClient,
  input: SendOutboundMessageInput,
): Promise<SendOutboundMessageResult> {
  const channel: ConversationChannel = input.channel ?? "sms";
  const senderType: MessageSenderType = input.senderType ?? (input.workflowExecutionId ? "ai" : "user");

  const { data: contact } = await supabase
    .from("contacts")
    .select("phone, sms_opt_out")
    .eq("id", input.contactId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();

  if (!contact?.phone) {
    return { ok: false, error: "The contact has no phone number on file.", messageId: null, conversationId: null };
  }

  const conversation = input.conversationId
    ? { id: input.conversationId }
    : await findOrCreateOpenConversation(supabase, input.organizationId, input.contactId, channel);

  if (!conversation) {
    return { ok: false, error: "Could not find or open a conversation for this contact.", messageId: null, conversationId: null };
  }

  // Never contact the provider for an opted-out recipient - still recorded
  // as a failed attempt so there's a real audit trail of the block, not a
  // silent no-op.
  if (contact.sms_opt_out) {
    const { data: blocked } = await supabase
      .from("messages")
      .insert({
        organization_id: input.organizationId,
        conversation_id: conversation.id,
        direction: "outbound",
        sender_type: senderType,
        body: input.body,
        status: "failed",
        status_reason: "Recipient has opted out of SMS (STOP).",
        workflow_execution_id: input.workflowExecutionId ?? null,
      })
      .select("id")
      .single();

    return {
      ok: false,
      error: "Recipient has opted out of SMS.",
      messageId: blocked?.id ?? null,
      conversationId: conversation.id,
    };
  }

  const { data: queued, error: insertError } = await supabase
    .from("messages")
    .insert({
      organization_id: input.organizationId,
      conversation_id: conversation.id,
      direction: "outbound",
      sender_type: senderType,
      body: input.body,
      status: "queued",
      workflow_execution_id: input.workflowExecutionId ?? null,
    })
    .select("id")
    .single();

  if (insertError || !queued) {
    return { ok: false, error: "Could not record the outbound message.", messageId: null, conversationId: conversation.id };
  }

  const result = await sendSms({ organizationId: input.organizationId, to: contact.phone, body: input.body });

  if (!result.ok) {
    await supabase.from("messages").update({ status: "failed", status_reason: result.error }).eq("id", queued.id);
    return { ok: false, error: result.error, messageId: queued.id, conversationId: conversation.id };
  }

  await supabase
    .from("messages")
    .update({ status: "sent", provider_message_id: result.providerMessageId })
    .eq("id", queued.id);

  return { ok: true, messageId: queued.id, conversationId: conversation.id, providerMessageId: result.providerMessageId };
}

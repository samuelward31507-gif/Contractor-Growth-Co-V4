import type { SupabaseClient } from "@supabase/supabase-js";
import { findOrCreateOpenConversation, type ConversationChannel, type MessageSenderType } from "@/lib/conversations/queries";
import { sendSms, type SendSmsInput, type SendSmsResult } from "@/lib/automation/sms";
import { createServiceRoleClient } from "@/lib/supabase/service";

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
  /**
   * Test seam only - production callers must never pass this. Defaults to
   * the real Twilio-backed `sendSms`, so every production code path keeps
   * calling the real provider with no behavior change; a test can inject a
   * deterministic fake here instead of monkey-patching the provider module
   * or hitting Twilio's trial-account restrictions.
   */
  sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult>;
};

export type SendOutboundMessageResult =
  | { ok: true; messageId: string; conversationId: string; providerMessageId: string }
  | {
      ok: false;
      error: string;
      messageId: string | null;
      conversationId: string | null;
      /**
       * P0-B B2.8a: set only when the outbound unique index
       * (messages.workflow_execution_id, direction 'outbound') rejected this
       * insert because another request for the SAME execution already owns
       * its send (its row exists and is not yet 'sent'). Not a send failure:
       * the owner records the outcome - a caller must never fail the
       * execution on it.
       */
      duplicateInProgress?: true;
    };

/**
 * The single path every outbound SMS send must go through, whatever
 * triggered it (n8n callback today, a future in-app compose action, a
 * future AI inbound-reply handler). Trackpr's `messages` table is always
 * updated before/after the provider call - `sendSms()` (still an
 * unconfigured stub) is only ever the transport, never the source of truth.
 * Works with either an RLS-scoped user-session client or a service-role
 * client; the caller is responsible for having already authorized the
 * request, exactly like every other function in this codebase that accepts
 * a bare `organizationId`. Only the post-provider status update runs on an
 * internal service-role client (see recordProviderOutcome below).
 */
export async function sendOutboundMessage(
  supabase: SupabaseClient,
  input: SendOutboundMessageInput,
): Promise<SendOutboundMessageResult> {
  const channel: ConversationChannel = input.channel ?? "sms";
  const senderType: MessageSenderType = input.senderType ?? (input.workflowExecutionId ? "ai" : "user");

  const { data: contact } = await supabase
    .from("contacts")
    .select("phone, phone_normalized, sms_opt_out")
    .eq("id", input.contactId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();

  if (!contact?.phone) {
    return { ok: false, error: "The contact has no phone number on file.", messageId: null, conversationId: null };
  }
  // phone is stored as typed (often 10 digits); phone_normalized is the
  // E.164 form every contact writer keeps in sync. Fall back to phone for
  // rows that predate it.
  const destination: string = contact.phone_normalized ?? contact.phone;

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
    // A unique-violation on workflow_execution_id (outbound) means a
    // concurrent call for this exact automation run already won the race
    // and recorded its own message row - the DB constraint is the real
    // duplicate-send guarantee, this is just handling its result. Report
    // that existing send's outcome instead of erroring or ever calling the
    // provider a second time for the same execution.
    if (insertError?.code === "23505" && input.workflowExecutionId) {
      const { data: existing } = await supabase
        .from("messages")
        .select("id, status, provider_message_id")
        .eq("workflow_execution_id", input.workflowExecutionId)
        .eq("direction", "outbound")
        .maybeSingle();

      if (existing) {
        if (existing.status === "sent") {
          return {
            ok: true,
            messageId: existing.id,
            conversationId: conversation.id,
            providerMessageId: existing.provider_message_id ?? "",
          };
        }
        return {
          ok: false,
          error: "This workflow execution already has an outbound message in progress.",
          messageId: existing.id,
          conversationId: conversation.id,
          duplicateInProgress: true,
        };
      }
    }
    return { ok: false, error: "Could not record the outbound message.", messageId: null, conversationId: conversation.id };
  }

  const sendFn = input.sendSmsFn ?? sendSms;
  const result = await sendFn({ organizationId: input.organizationId, to: destination, body: input.body });

  if (!result.ok) {
    await recordProviderOutcome(queued.id, input.organizationId, {
      status: "failed",
      status_reason: result.error,
      ...(result.providerErrorCode ? { provider_error_code: result.providerErrorCode } : {}),
    });
    return { ok: false, error: result.error, messageId: queued.id, conversationId: conversation.id };
  }

  await recordProviderOutcome(queued.id, input.organizationId, { status: "sent", provider_message_id: result.providerMessageId });

  return { ok: true, messageId: queued.id, conversationId: conversation.id, providerMessageId: result.providerMessageId };
}

/**
 * Records the provider's result on the message row sendOutboundMessage just
 * inserted. Deliberately uses its own internal service-role client rather
 * than the caller's: `messages` has no RLS UPDATE policy at all, so under a
 * user-session caller (Retry, manual Run now, membership welcome) this
 * update would silently affect zero rows and leave the message `queued`
 * forever, without its provider_message_id. Same reasoning as
 * sendAppointmentLifecycleMessage in lib/automation/appointments.ts.
 *
 * Constrained to exactly that row - its id, its organization, and only
 * while it is still `queued` - so it can never change any other message or
 * rewrite one that has already reached a terminal state. Exported for
 * tests only. Never throws: the provider call has already happened, so a
 * failure here is logged (ids and status only - never body or phone), not
 * surfaced as a different send outcome.
 */
export async function recordProviderOutcome(
  messageId: string,
  organizationId: string,
  outcome: { status: "sent"; provider_message_id: string } | { status: "failed"; status_reason: string; provider_error_code?: string },
): Promise<boolean> {
  try {
    const service = createServiceRoleClient();
    const { data, error } = await service
      .from("messages")
      .update(outcome)
      .eq("id", messageId)
      .eq("organization_id", organizationId)
      .eq("status", "queued")
      .select("id");

    if (error || !data || data.length === 0) {
      console.error("[messaging] failed to record outbound provider outcome", {
        messageId,
        organizationId,
        status: outcome.status,
        error: error?.message ?? "no queued message matched",
      });
      return false;
    }
    return true;
  } catch (error) {
    console.error("[messaging] failed to record outbound provider outcome", {
      messageId,
      organizationId,
      status: outcome.status,
      error: error instanceof Error ? error.message : "unknown error",
    });
    return false;
  }
}

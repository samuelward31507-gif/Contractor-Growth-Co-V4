import type { SupabaseClient } from "@supabase/supabase-js";
import { matchSmsKeyword } from "@/lib/messaging/keywords";
import { processInboundCustomerMessage } from "@/lib/messaging/inbound-customer-message";

/**
 * TEST-only "Simulate Customer Reply": records a customer's inbound SMS reply
 * without Twilio, then runs the exact post-persistence path the real inbound
 * webhook runs (processInboundCustomerMessage) - so the reply reaches
 * customer_reply_followup -> n8n -> callback -> evaluateOutboundGate like any
 * real one. Nothing here sends anything: a TEST-mode organization's AI reply
 * is denied by the gate's own organization_not_live check, which this module
 * neither bypasses nor duplicates.
 *
 * Deliberately not reachable for STOP/START/HELP: in the real webhook those
 * are compliance keywords that write opt-out state or send a real, ungated
 * HELP reply, so a simulated message containing one is refused outright.
 */

/** Prefix that marks a stored message as simulated, never a real Twilio SID ("SM…"/"MM…"). */
export const SIMULATED_PROVIDER_MESSAGE_ID_PREFIX = "sim_";

export const SIMULATED_REPLY_MAX_LENGTH = 1600;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True only on a non-production deployment: a Vercel preview/development
 * build, or a local non-production server. Vercel Production - and any
 * self-hosted production build (NODE_ENV=production with no VERCEL_ENV) -
 * is always false.
 */
export function isCustomerReplySimulationEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.VERCEL_ENV) return env.VERCEL_ENV === "preview" || env.VERCEL_ENV === "development";
  return env.NODE_ENV !== "production";
}

/** Deterministic per form submission, so a double-submit resolves to the same message/event. */
export function simulatedProviderMessageId(simulationId: string): string {
  return `${SIMULATED_PROVIDER_MESSAGE_ID_PREFIX}${simulationId.toLowerCase()}`;
}

export type SimulatedReplyValidation = { ok: true; body: string } | { ok: false; error: string };

export function validateSimulatedReply(rawBody: string, simulationId: string): SimulatedReplyValidation {
  if (!UUID_PATTERN.test(simulationId)) return { ok: false, error: "This form is out of date. Reload the page and try again." };

  const body = rawBody.trim();
  if (!body) return { ok: false, error: "Enter the customer's reply." };
  if (body.length > SIMULATED_REPLY_MAX_LENGTH) return { ok: false, error: `Keep the reply under ${SIMULATED_REPLY_MAX_LENGTH} characters.` };
  if (matchSmsKeyword(body)) return { ok: false, error: "STOP, START and HELP are compliance keywords and can't be simulated." };

  return { ok: true, body };
}

export type SimulateInboundCustomerReplyResult = { ok: true; duplicate: boolean } | { ok: false; error: string };

/**
 * Stores the simulated reply exactly as the real webhook stores an inbound
 * message (direction inbound, sender_type customer, status received), then
 * hands off to processInboundCustomerMessage. Callers must already have
 * verified the environment, the caller's org-admin role, that the
 * organization is in TEST mode, and that the conversation is the contact's
 * open SMS thread in that organization.
 *
 * Idempotent on the simulated provider id: a replayed submission hits the
 * same messages_provider_message_id unique index the real webhook relies on
 * and becomes a no-op, exactly like a replayed Twilio delivery. No Twilio
 * cost capture runs - there is no real Twilio message to price.
 */
export async function simulateInboundCustomerReply(
  service: SupabaseClient,
  input: { organizationId: string; contactId: string; conversationId: string; body: string; simulationId: string },
): Promise<SimulateInboundCustomerReplyResult> {
  const providerMessageId = simulatedProviderMessageId(input.simulationId);

  const { error: insertError } = await service.from("messages").insert({
    organization_id: input.organizationId,
    conversation_id: input.conversationId,
    direction: "inbound",
    sender_type: "customer",
    body: input.body,
    status: "received",
    provider_message_id: providerMessageId,
  });

  if (insertError?.code === "23505") return { ok: true, duplicate: true };
  if (insertError) {
    console.error("[sms][simulated] failed to record simulated reply", { organizationId: input.organizationId, error: insertError.message });
    return { ok: false, error: "We couldn't record the simulated reply. Please try again." };
  }

  await processInboundCustomerMessage(service, {
    organizationId: input.organizationId,
    contactId: input.contactId,
    conversationId: input.conversationId,
    body: input.body,
    providerMessageId,
  });

  return { ok: true, duplicate: false };
}

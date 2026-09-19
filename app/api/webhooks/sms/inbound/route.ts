import { type NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { findOrCreateOpenConversation } from "@/lib/conversations/queries";
import { matchSmsKeyword } from "@/lib/messaging/keywords";
import { emitCustomerReplyFollowup } from "@/lib/automation/customer-reply";
import { sendOutboundMessage } from "@/lib/messaging/outbound";
import { buildHelpResponseMessage } from "@/lib/messaging/help-response";
import { isValidTwilioSignature } from "@/lib/messaging/twilio-signature";
import { recordRequestResponses } from "@/lib/reviews-referrals/tracking";

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

function twiml() {
  return new NextResponse(EMPTY_TWIML, { status: 200, headers: { "content-type": "text/xml" } });
}

/**
 * Inbound SMS webhook. Organization routing (below) depends on
 * organizations.sms_phone_number being both configured and unique - see
 * app/(app)/settings/sms and supabase/migrations/20260919140000_sms_
 * routing_settings.sql, which added the DB-level uniqueness/format
 * guarantees this lookup relies on.
 *
 * A normal (non-keyword) inbound message triggers the customer_reply_
 * followup automation (emitCustomerReplyFollowup), which dispatches to n8n,
 * runs AI qualification, and can produce a real outbound reply - gated the
 * whole way by evaluateOutboundGate(), not by anything in this route. STOP/
 * START/HELP are compliance keywords, not conversational content, and are
 * deliberately excluded from that AI path entirely: STOP/START only ever
 * toggle contacts.sms_opt_out, and HELP sends one deterministic,
 * non-AI-generated reply (buildHelpResponseMessage) through the same
 * sendOutboundMessage() path every other outbound send uses, never through
 * the AI/n8n/outbound-gate pipeline.
 */
export async function POST(request: NextRequest) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    return NextResponse.json({ ok: false, error: "SMS webhooks are not configured." }, { status: 401 });
  }

  const signature = request.headers.get("x-twilio-signature");
  if (!signature) {
    return NextResponse.json({ ok: false, error: "Missing signature." }, { status: 401 });
  }

  const formData = await request.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") params[key] = value;
  }

  if (!isValidTwilioSignature(request.url, params, signature, authToken)) {
    return NextResponse.json({ ok: false, error: "Invalid signature." }, { status: 401 });
  }

  const messageSid = params.MessageSid;
  const from = params.From;
  const to = params.To;
  const body = params.Body ?? "";

  if (!messageSid || !from || !to) {
    return NextResponse.json({ ok: false, error: "Missing required Twilio fields." }, { status: 400 });
  }

  const service = createServiceRoleClient();

  // Idempotency: a replayed/retried webhook for a SID we've already stored
  // is a clean no-op, not a second message.
  const { data: existing } = await service
    .from("messages")
    .select("id")
    .eq("provider_message_id", messageSid)
    .maybeSingle();
  if (existing) return twiml();

  const { data: organization } = await service
    .from("organizations")
    .select("id, name, phone, email")
    .eq("sms_phone_number", to)
    .maybeSingle();

  if (!organization) {
    // Unrecognized destination number - a configuration issue, not a
    // transient failure. Acknowledge so Twilio doesn't retry.
    console.error("[sms][inbound] no organization configured for number", { to });
    return twiml();
  }

  let { data: contact } = await service
    .from("contacts")
    .select("id, sms_opt_out")
    .eq("organization_id", organization.id)
    .eq("phone", from)
    .limit(1)
    .maybeSingle();

  if (!contact) {
    const { data: created } = await service
      .from("contacts")
      .insert({ organization_id: organization.id, phone: from })
      .select("id, sms_opt_out")
      .single();
    contact = created ?? null;
  }

  if (!contact) {
    console.error("[sms][inbound] could not resolve or create contact", { organizationId: organization.id });
    return twiml();
  }

  const keyword = matchSmsKeyword(body);
  if (keyword === "stop" && !contact.sms_opt_out) {
    await service.from("contacts").update({ sms_opt_out: true }).eq("id", contact.id);
  } else if (keyword === "start" && contact.sms_opt_out) {
    await service.from("contacts").update({ sms_opt_out: false }).eq("id", contact.id);
  }
  // HELP is recorded like any other inbound message below and answered with
  // one deterministic reply (see the sendOutboundMessage() call further
  // down) - never AI-generated, never routed through customer_reply_
  // followup.

  const conversation = await findOrCreateOpenConversation(service, organization.id, contact.id, "sms");
  if (!conversation) {
    console.error("[sms][inbound] could not find or open a conversation", { organizationId: organization.id, contactId: contact.id });
    return twiml();
  }

  const { error: insertError } = await service.from("messages").insert({
    organization_id: organization.id,
    conversation_id: conversation.id,
    direction: "inbound",
    sender_type: "customer",
    body,
    status: "received",
    provider_message_id: messageSid,
  });

  if (insertError) {
    console.error("[sms][inbound] failed to record message", { organizationId: organization.id, error: insertError.message });
  }

  // STOP/START/HELP are compliance keywords, not conversational content -
  // they must never trigger AI qualification/conversation processing. A
  // normal message triggers the customer_reply_followup automation, which
  // is gated end-to-end by evaluateOutboundGate() before any real send.
  if (!insertError && !keyword) {
    const { data: conversationLead } = await service
      .from("conversations")
      .select("lead_id")
      .eq("id", conversation.id)
      .maybeSingle();

    await emitCustomerReplyFollowup(service, {
      organizationId: organization.id,
      contactId: contact.id,
      conversationId: conversation.id,
      leadId: conversationLead?.lead_id ?? null,
      messageBody: body,
      providerMessageId: messageSid,
    });

    // Review & Referral Tracking V1: deterministic, non-AI bookkeeping only
    // - records that the contact replied at all, never what they said or
    // whether it means the review/referral succeeded. Runs alongside (not
    // instead of) the customer-reply automation above; a no-op when there is
    // no currently-'requested' review/referral row for this contact.
    await recordRequestResponses(service, organization.id, contact.id);
  } else if (!insertError && keyword === "help") {
    // Deterministic, non-AI reply. Goes through the same sendOutboundMessage()
    // every other outbound send uses - so it still respects opt-out
    // (redundant here since a HELP sender is by definition not opted out of
    // receiving this exact reply, but sendOutboundMessage() re-checks
    // regardless, never trusting the caller) and is recorded in `messages`
    // like any other send. Never touches evaluateOutboundGate() - that gate
    // exists to police AI-recommended sends, and this is not one.
    await sendOutboundMessage(service, {
      organizationId: organization.id,
      contactId: contact.id,
      conversationId: conversation.id,
      channel: "sms",
      senderType: "system",
      body: buildHelpResponseMessage({ name: organization.name, phone: organization.phone, email: organization.email }),
    });
  }

  return twiml();
}

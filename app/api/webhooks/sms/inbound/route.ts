import { createHmac, timingSafeEqual } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { findOrCreateOpenConversation } from "@/lib/conversations/queries";
import { matchSmsKeyword } from "@/lib/messaging/keywords";
import { emitCustomerReplyFollowup } from "@/lib/automation/customer-reply";

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

function twiml() {
  return new NextResponse(EMPTY_TWIML, { status: 200, headers: { "content-type": "text/xml" } });
}

/**
 * Twilio's request-signing scheme: HMAC-SHA1 of the full request URL with
 * every POST param (sorted by key, key+value concatenated with no
 * separator) appended, base64-encoded, compared to X-Twilio-Signature.
 * https://www.twilio.com/docs/usage/security#validating-requests
 */
function isValidTwilioSignature(url: string, params: Record<string, string>, signature: string, authToken: string): boolean {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);

  const expected = createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");

  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Inbound SMS webhook. Twilio is not configured anywhere in this environment
 * yet (no TWILIO_AUTH_TOKEN), so this always fails closed at the signature
 * check today - the route exists so the communication architecture is
 * complete and testable once a real Twilio number is provisioned, without
 * requiring another round of schema/route changes at that point.
 *
 * AI-driven auto-response to inbound messages is explicitly out of scope
 * for this phase (see the Phase 3 audit, item J) - this route only persists
 * inbound messages and handles STOP/START/HELP compliance keywords.
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
    .select("id")
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
  // HELP is recorded like any other inbound message below; auto-replying
  // with the required help text needs real SMS sending, which this phase
  // intentionally does not add yet.

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
  // normal message triggers the customer_reply_followup automation
  // (Phase 4.2); should_send stays false throughout that flow, so this
  // never results in an outbound SMS.
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
  }

  return twiml();
}

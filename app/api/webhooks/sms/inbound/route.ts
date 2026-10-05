import { type NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { findOrCreateOpenConversation } from "@/lib/conversations/queries";
import { matchSmsKeyword } from "@/lib/messaging/keywords";
import { sendOutboundMessage } from "@/lib/messaging/outbound";
import { buildHelpResponseMessage } from "@/lib/messaging/help-response";
import { isValidTwilioSignature } from "@/lib/messaging/twilio-signature";
import { processInboundCustomerMessage } from "@/lib/messaging/inbound-customer-message";
import { resolveOrCreateContact } from "@/lib/contacts/resolve";
import { recordSmsCostEventForMessage } from "@/lib/costs/sms-cost-events";
import { writeSmsOptOut } from "@/lib/messaging/opt-out";

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

  // Contact Deduplication V1: the same centralized resolver every contact-
  // creation path uses - a customer who previously texted in, or was
  // manually entered with the same number in a different format, is
  // reused rather than duplicated. Inbound SMS only ever supplies a phone
  // (Twilio's From), so "conflict" (phone matches one contact, email
  // matches a different one) cannot occur here - only "matched"/"created"
  // are practically reachable, but every outcome is still handled
  // explicitly rather than assumed.
  const resolved = await resolveOrCreateContact(service, { organizationId: organization.id, phone: from });
  if (resolved.outcome !== "matched" && resolved.outcome !== "created") {
    console.error("[sms][inbound] could not resolve or create contact", { organizationId: organization.id, outcome: resolved.outcome });
    return twiml();
  }

  const { data: contact } = await service
    .from("contacts")
    .select("id, sms_opt_out")
    .eq("id", resolved.contact.id)
    .maybeSingle();

  if (!contact) {
    console.error("[sms][inbound] resolved contact could not be re-read", { organizationId: organization.id });
    return twiml();
  }

  const keyword = matchSmsKeyword(body);
  // Phase 3F: a STOP/START that couldn't be persisted (after one retry) must
  // never be acknowledged. Returning 500 BEFORE the message is inserted
  // leaves the duplicate-message check above unarmed, so a redelivery of
  // this webhook re-runs the whole flow, including this write.
  const optOutTarget = keyword === "stop" && !contact.sms_opt_out ? true : keyword === "start" && contact.sms_opt_out ? false : null;
  if (optOutTarget !== null) {
    const optOutWrite = await writeSmsOptOut(service, contact.id, optOutTarget);
    if (!optOutWrite.ok) {
      console.error("[sms][inbound] failed to persist sms_opt_out", {
        organizationId: organization.id,
        contactId: contact.id,
        keyword,
        attempts: optOutWrite.attempts,
        finalFailure: true,
        errorCode: optOutWrite.failure.code,
        errorMessage: optOutWrite.failure.message,
      });
      return NextResponse.json({ ok: false, error: "Could not update SMS opt-out state." }, { status: 500 });
    }
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

  const { data: insertedMessage, error: insertError } = await service
    .from("messages")
    .insert({
      organization_id: organization.id,
      conversation_id: conversation.id,
      direction: "inbound",
      sender_type: "customer",
      body,
      status: "received",
      provider_message_id: messageSid,
    })
    .select("id")
    .single();

  // Production-readiness audit fix: the SELECT-then-INSERT check above is
  // only a fast path, not a transactional guarantee - Twilio retrying this
  // exact webhook under response latency (normal, expected) can land two
  // concurrent requests here, both past the SELECT, racing on INSERT. The
  // real, race-safe guarantee is messages_provider_message_id_unique (see
  // that migration): a 23505 here means a concurrent request already won
  // and fully recorded this exact physical SMS, so this request must treat
  // it exactly like the early `existing` short-circuit above - a clean,
  // idempotent no-op - and must NOT also run the automation/HELP-reply
  // logic below for a message another request is already handling.
  if (insertError?.code === "23505") {
    return twiml();
  }

  if (insertError) {
    console.error("[sms][inbound] failed to record message", { organizationId: organization.id, error: insertError.message });
  }

  // Phase 5D-4: best-effort SMS cost capture for the just-inserted inbound
  // message, additive only - inbound SMS is genuinely billed by Twilio
  // (confirmed by the Phase 5D-4 audit) and this message row already has a
  // real provider SID and organization attribution the instant it exists,
  // unlike outbound (which waits for the delivery-status webhook's terminal
  // transition - see app/api/webhooks/sms/status/route.ts). Never affects
  // this route's own response, the message row itself, opt-in/out handling,
  // or any automation dispatch below - wrapped so a Twilio/network failure
  // here can never break the inbound webhook. If Twilio's price isn't
  // finalized yet at this exact moment, no cost event is written and none
  // will be attempted again by this route (automatic delayed-price
  // reconciliation is explicitly deferred to a future phase).
  if (!insertError && insertedMessage) {
    try {
      const costResult = await recordSmsCostEventForMessage(service, {
        organizationId: organization.id,
        sourceMessageId: insertedMessage.id,
        providerMessageId: messageSid,
        direction: "inbound",
      });
      if (costResult.outcome === "error" || costResult.outcome === "fetch_failed") {
        console.error("[sms][inbound] failed to capture SMS cost", {
          messageId: insertedMessage.id,
          outcome: costResult.outcome,
          reason: "error" in costResult ? costResult.error : undefined,
        });
      }
    } catch (error) {
      console.error("[sms][inbound] unexpected error during SMS cost capture", {
        messageId: insertedMessage.id,
        error: error instanceof Error ? error.message : "unknown error",
      });
    }
  }

  // STOP/START/HELP are compliance keywords, not conversational content -
  // they must never trigger AI qualification/conversation processing. A
  // normal message triggers the customer_reply_followup automation, which
  // is gated end-to-end by evaluateOutboundGate() before any real send.
  if (!insertError && !keyword) {
    await processInboundCustomerMessage(service, {
      organizationId: organization.id,
      contactId: contact.id,
      conversationId: conversation.id,
      body,
      providerMessageId: messageSid,
    });
  } else if (!insertError && keyword === "help") {
    // Deterministic, non-AI reply. Goes through the same sendOutboundMessage()
    // every other outbound send uses - so it still respects opt-out
    // (redundant here since a HELP sender is by definition not opted out of
    // receiving this exact reply, but sendOutboundMessage() re-checks
    // regardless, never trusting the caller) and is recorded in `messages`
    // like any other send, so the existing duplicate-send protection
    // (messages(workflow_execution_id) unique-when-outbound index) still
    // applies. Never touches evaluateOutboundGate() - that gate exists to
    // police AI-recommended sends, and this is not one.
    //
    // Trackpr 2.0, Phase 4C (P2 #7) - explicit, documented product decision,
    // NOT changed by this pass: bypassing evaluateOutboundGate() also means
    // HELP is exempt from that gate's payment_status/automation_paused/
    // automation_mode checks - a suspended, paused, or still-in-test
    // organization still receives this one fixed, non-AI compliance message
    // when a customer texts HELP. This is intentional (a carrier/compliance
    // reply is not the kind of customer-facing automation those checks exist
    // to police) and is proven, not just asserted, by
    // app/api/webhooks/sms/inbound/route.integration.test.ts's own
    // "P2 #7" tests. Changing this exemption is a separate, explicit product
    // decision this pass is not authorized to make.
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

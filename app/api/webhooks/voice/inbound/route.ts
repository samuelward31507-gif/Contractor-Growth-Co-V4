import { type NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { resolveOrCreateContact } from "@/lib/contacts/resolve";
import { findOrCreateOpenConversation } from "@/lib/conversations/queries";
import { OPEN_LEAD_STATUSES } from "@/lib/leads/queries";
import { createAutomationEventAsService } from "@/lib/automation/events";
import { startWorkflowExecutionAsService, completeWorkflowExecutionAsService, failWorkflowExecutionAsService } from "@/lib/automation/executions";
import { evaluateOutboundGate } from "@/lib/automation/outbound-gate";
import { sendOutboundMessage } from "@/lib/messaging/outbound";
import { notifyFounder } from "@/lib/notifications/founder";
import { emitLeadStageChangedAsService } from "@/lib/automation/lead-stage-history";
import { isValidTwilioSignature } from "@/lib/messaging/twilio-signature";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SendSmsInput, SendSmsResult } from "@/lib/automation/sms";

const MISSED_CALL_WORKFLOW = "missed_call_recovery";

function twiml(sayText: string) {
  const escaped = sayText.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escaped}</Say><Hangup/></Response>`;
  return new NextResponse(body, { status: 200, headers: { "content-type": "text/xml" } });
}

const GENERIC_GREETING = "Thanks for calling. We're unable to take your call right now, but we've just sent you a text message so we can help you right away.";
const UNCONFIGURED_GREETING = "Thanks for calling. We're unable to take your call right now.";

function composeMissedCallSmsBody(businessName: string | null): string {
  const name = businessName ? `${businessName}: ` : "";
  return `${name}Sorry we missed your call! Reply here and we'll help you right away. Reply STOP to opt out of texts.`;
}

/**
 * Growth System Completion Pass 1 (Part 4): the entire missed-call pipeline,
 * exported and kept separate from POST() so a test can inject a fake SMS
 * provider (Next.js's generated route-handler type contract fixes POST's
 * own signature - see app/api/automation/n8n-callback/route.ts's identical
 * handleBookingIntent precedent for why). POST() itself only ever calls this
 * with sendSmsFn omitted.
 *
 * This product has no live call-answering capability (no IVR, no human
 * picking up through Trackpr) - every inbound call this route ever receives
 * is, by construction, a call Trackpr itself cannot answer, so "determine
 * missed call" is simply "this webhook fired at all". The TwiML response
 * always politely declines the call and hangs up; the real product value is
 * the immediate SMS sent here, and everything downstream of a caller's
 * reply (qualification, AI conversation, booking) is the EXISTING inbound
 * SMS pipeline (app/api/webhooks/sms/inbound) - this route never builds a
 * second, parallel messaging/AI system, it only creates the conditions (a
 * contact, optionally a lead, an open conversation, one deterministic text)
 * for that existing pipeline to take over the moment the caller texts back.
 */
export async function handleMissedCall(
  service: SupabaseClient,
  params: { callSid: string; from: string; to: string },
  sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult>,
): Promise<NextResponse> {
  const { callSid, from, to } = params;

  const { data: organization } = await service.from("organizations").select("id, name, payment_status").eq("sms_phone_number", to).maybeSingle();

  if (!organization) {
    // Unrecognized destination number - a configuration issue, not a
    // transient failure. Acknowledge the call politely so Twilio doesn't
    // retry, the same as the SMS webhook's own handling of this case.
    console.error("[voice][inbound] no organization configured for number", { to });
    return twiml(UNCONFIGURED_GREETING);
  }

  // Growth System Completion Pass 1: an explicit payment check, mirroring
  // lib/scheduling/booking.ts's own bookAppointment() reasoning exactly -
  // this route is entirely unauthenticated (Twilio signs the request, there
  // is no Supabase Auth session), so it always runs via service-role, which
  // bypasses the RLS-based payment gate entirely. A payment_required
  // organization's caller is still greeted politely, but no contact/lead/
  // automation event is created and no SMS is sent - the customer never
  // sees any sign of the organization's own billing state.
  if (organization.payment_status !== "active") {
    return twiml(UNCONFIGURED_GREETING);
  }

  // Same E.164-shape validation the outbound gate itself applies - an
  // invalid/malformed caller id is handled the same way an unrecognized
  // destination is: greet and hang up, create nothing.
  if (!/^\+[1-9]\d{1,14}$/.test(from.trim())) {
    console.error("[voice][inbound] caller id is not a valid E.164 number", { organizationId: organization.id });
    return twiml(UNCONFIGURED_GREETING);
  }

  const resolved = await resolveOrCreateContact(service, { organizationId: organization.id, phone: from });
  if (resolved.outcome !== "matched" && resolved.outcome !== "created") {
    console.error("[voice][inbound] could not resolve or create contact", { organizationId: organization.id, outcome: resolved.outcome });
    return twiml(GENERIC_GREETING);
  }
  const contactId = resolved.contact.id;

  // Associate an existing OPEN lead for this contact rather than creating a
  // duplicate one; only create a new lead when this contact genuinely has no
  // open opportunity yet. Mirrors app/api/leads/capture/[token]/route.ts's
  // own lead-creation shape (source/status/temperature), but deliberately
  // never calls emitLeadCreatedFollowup(AsService) - this route sends its
  // OWN immediate deterministic SMS below, and dispatching the AI-drafted
  // "instant lead follow-up" on top of it would double-text the caller for
  // the exact same "we got your inquiry" moment.
  const { data: existingOpenLead } = await service
    .from("leads")
    .select("id")
    .eq("organization_id", organization.id)
    .eq("contact_id", contactId)
    .in("status", [...OPEN_LEAD_STATUSES])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let leadId: string | null = existingOpenLead?.id ?? null;
  if (!leadId) {
    const { data: newLead, error: leadInsertError } = await service
      .from("leads")
      .insert({ organization_id: organization.id, contact_id: contactId, source: "phone", status: "new", temperature: "cold" })
      .select("id")
      .single();
    if (leadInsertError) {
      console.error("[voice][inbound] failed to create lead for missed call", { organizationId: organization.id, error: leadInsertError.message });
    } else {
      leadId = newLead?.id ?? null;
      if (leadId) {
        await emitLeadStageChangedAsService(service, organization.id, { leadId, previousStatus: null, newStatus: "new", source: "automation" });
      }
    }
  }

  const conversation = await findOrCreateOpenConversation(service, organization.id, contactId, "sms", leadId);
  const conversationId = conversation?.id ?? null;

  // Deduplicate: a Twilio Voice webhook retry resolves to the SAME
  // automation_events row rather than sending a second text - the same
  // idempotency-key mechanism every other automation in this codebase uses.
  const eventResult = await createAutomationEventAsService(service, organization.id, {
    eventType: "call.missed",
    entityType: "contact",
    entityId: contactId,
    payload: { contact_id: contactId, lead_id: leadId, conversation_id: conversationId, call_sid: callSid },
    idempotencyKey: `call.missed:${callSid}`,
  });

  if (!eventResult.ok) {
    console.error("[voice][inbound] failed to create call.missed event", { organizationId: organization.id, error: eventResult.error });
    return twiml(GENERIC_GREETING);
  }
  if (eventResult.duplicate || eventResult.skipped) {
    // A duplicate delivery, or the automation is disabled for this
    // organization - the caller still hears the same polite greeting either
    // way; only the backend text/lead-association work is skipped.
    return twiml(eventResult.skipped ? UNCONFIGURED_GREETING : GENERIC_GREETING);
  }

  const executionResult = await startWorkflowExecutionAsService(service, eventResult.event.id, MISSED_CALL_WORKFLOW);
  if (!executionResult.ok) {
    console.error("[voice][inbound] failed to start missed-call execution", { organizationId: organization.id, error: executionResult.error });
    return twiml(GENERIC_GREETING);
  }
  const executionId = executionResult.execution.id;

  const body = composeMissedCallSmsBody(organization.name);

  const gateResult = await evaluateOutboundGate(service, {
    organizationId: organization.id,
    executionId,
    contactId,
    conversationId,
    leadId,
    aiResult: { should_send: true, response_message: body, needs_human: false },
  });

  let sent = false;
  if (gateResult.allowed) {
    const sendResult = await sendOutboundMessage(service, {
      organizationId: organization.id,
      contactId: gateResult.contactId,
      conversationId: gateResult.conversationId,
      channel: "sms",
      body: gateResult.body,
      senderType: "system",
      workflowExecutionId: executionId,
      sendSmsFn,
    });
    sent = sendResult.ok;
    if (!sendResult.ok) {
      await failWorkflowExecutionAsService(service, executionId, sendResult.error, "sms_send_failed");
    }
  }

  if (gateResult.allowed) {
    if (sent) {
      await completeWorkflowExecutionAsService(service, executionId, { should_send: true, contact_id: contactId, lead_id: leadId, call_sid: callSid });
    }
  } else {
    await completeWorkflowExecutionAsService(service, executionId, { should_send: false, blocked_reason: gateResult.reason, contact_id: contactId, lead_id: leadId, call_sid: callSid });
  }

  // Founder Notifications V1: fires once per genuinely new missed call
  // (guarded by the eventResult.duplicate/skipped early return above),
  // independent of whether the immediate SMS itself ends up sent/blocked - a
  // missed call is a missed call regardless of that message's fate.
  await notifyFounder(service, {
    organizationId: organization.id,
    kind: "missed_call",
    summary: "A call went unanswered.",
    detailPath: leadId ? `/leads/${leadId}` : `/contacts/${contactId}`,
  });

  return twiml(GENERIC_GREETING);
}

/**
 * Uses the exact same Twilio request-signing verification as the SMS
 * webhook (lib/messaging/twilio-signature.ts) - Twilio signs every webhook
 * type (SMS, Voice, status callbacks) identically.
 */
export async function POST(request: NextRequest) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    return NextResponse.json({ ok: false, error: "Voice webhooks are not configured." }, { status: 401 });
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

  const callSid = params.CallSid;
  const from = params.From;
  const to = params.To;

  if (!callSid || !from || !to) {
    return NextResponse.json({ ok: false, error: "Missing required Twilio fields." }, { status: 400 });
  }

  const service = createServiceRoleClient();
  return handleMissedCall(service, { callSid, from, to });
}

import { type NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { isValidTwilioSignature } from "@/lib/messaging/twilio-signature";
import { applyDeliveryStatusUpdate } from "@/lib/messaging/delivery-status";

/**
 * Twilio's outbound message delivery-status callback. Registered as the
 * `statusCallback` on every message Trackpr sends (see
 * lib/automation/sms.ts's sendSms()) - Twilio calls this once per lifecycle
 * transition (queued/sending/sent/delivered/undelivered/failed) for that
 * exact message.
 *
 * This route is observability only: it updates messages.status/
 * status_reason/provider_error_code for the one message the callback
 * refers to (resolved by provider_message_id, never trusted from the
 * request) and nothing else. It never creates a customer.message.received
 * event, never starts a workflow execution, never invokes AI, and never
 * sends another outbound message - see lib/messaging/delivery-status.ts's
 * applyDeliveryStatusUpdate(), which this route defers to for all of that
 * logic so it isn't duplicated or drifted between this route and any test.
 *
 * Signature verification reuses lib/messaging/twilio-signature.ts - the
 * exact same algorithm and TWILIO_AUTH_TOKEN the inbound SMS webhook
 * already uses, not a second implementation. Fails closed identically:
 * missing token -> 401 without attempting verification, missing signature
 * -> 401, invalid signature -> 401. No authenticated user session is
 * required or checked - Twilio has no Trackpr session, and the signature
 * itself is the only authentication this route has or needs.
 */
export async function POST(request: NextRequest) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    return NextResponse.json({ ok: false, error: "SMS status webhooks are not configured." }, { status: 401 });
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
  const messageStatus = params.MessageStatus;

  if (!messageSid || !messageStatus) {
    return NextResponse.json({ ok: false, error: "Missing required Twilio fields." }, { status: 400 });
  }

  const service = createServiceRoleClient();

  let result;
  try {
    result = await applyDeliveryStatusUpdate(service, {
      providerMessageId: messageSid,
      twilioStatus: messageStatus,
      errorCode: params.ErrorCode ?? null,
      errorMessage: params.ErrorMessage ?? null,
    });
  } catch (error) {
    console.error("[sms][status] failed to apply delivery status update", { error: error instanceof Error ? error.message : "unknown error" });
    // Acknowledge anyway - Twilio retries on a non-2xx response, and a
    // retry of the same callback would hit the exact same failure. The
    // safer failure mode is a missed status update (already logged above),
    // not an unbounded Twilio retry loop against a route that can't
    // currently persist the update.
    return NextResponse.json({ ok: false }, { status: 200 });
  }

  // Only a genuine forward transition is audited - unknown_message,
  // not_outbound, unmapped_provider_status, no_change, and ignored_downgrade
  // are all expected, non-noteworthy outcomes (including Twilio's own
  // retries of a callback already applied), and logging each of those as an
  // audit_log row would make the log noisy rather than useful.
  if (result.outcome === "updated") {
    const { error: auditError } = await service.from("audit_log").insert({
      organization_id: result.organizationId,
      user_id: null,
      action: "sms_delivery_status_updated",
      entity_type: "message",
      entity_id: result.messageId,
      automation_id: null,
      metadata: { from_status: result.fromStatus, to_status: result.toStatus },
    });

    if (auditError) {
      console.error("[sms][status] failed to record audit log entry", { messageId: result.messageId, error: auditError.message });
    }
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}

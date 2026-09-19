import type { SupabaseClient } from "@supabase/supabase-js";
import type { MessageStatus } from "@/lib/conversations/queries";

const MAX_STATUS_REASON_LENGTH = 500;
const MAX_ERROR_CODE_LENGTH = 32;

/**
 * Deterministic Twilio MessageStatus -> Trackpr MessageStatus mapping.
 * Reference: https://www.twilio.com/docs/messaging/api/message-resource#message-status-values
 *
 * "accepted"/"queued"/"sending" all map to Trackpr's own "queued"/"sent"
 * tier - by the time any status callback can arrive, sendOutboundMessage()
 * has already synchronously set the row to 'sent' (or 'failed', if the API
 * call itself failed) right after Twilio's create-message call returns, so
 * these early-stage callbacks are expected to be no-ops under the monotonic
 * rank check below, not errors. "read" (WhatsApp-only) and "canceled"/
 * "scheduled" (Twilio Messaging Services scheduled sends, unused by this
 * codebase - sendSms() always sends immediately) are deliberately absent:
 * an unrecognized status is never guessed at, it is rejected outright by
 * mapTwilioMessageStatus() returning null.
 */
const TWILIO_STATUS_MAP: Record<string, { status: MessageStatus; rank: number }> = {
  accepted: { status: "queued", rank: 0 },
  queued: { status: "queued", rank: 0 },
  sending: { status: "sent", rank: 1 },
  sent: { status: "sent", rank: 1 },
  delivered: { status: "delivered", rank: 2 },
  undelivered: { status: "undelivered", rank: 2 },
  failed: { status: "failed", rank: 2 },
};

/** Rank for every Trackpr MessageStatus, including the ones a Twilio status callback can never legitimately target (received/logged are inbound/manual-only). */
const TRACKPR_STATUS_RANK: Record<MessageStatus, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  failed: 2,
  undelivered: 2,
  received: -1,
  logged: -1,
};

export function mapTwilioMessageStatus(twilioStatus: string): { status: MessageStatus; rank: number } | null {
  const normalized = twilioStatus.trim().toLowerCase();
  return TWILIO_STATUS_MAP[normalized] ?? null;
}

/** Rank 2 (delivered/failed/undelivered) is terminal: once reached, no further transition is ever applied, matching Twilio's own model (a message resolves to exactly one final outcome). */
function isTerminalRank(rank: number): boolean {
  return rank >= 2;
}

/**
 * Bounds a provider-supplied string to a fixed max length so an oversized
 * or adversarial ErrorMessage can never produce an oversized DB write - the
 * DB's own CHECK constraint on provider_error_code is a second, independent
 * enforcement of the same idea for that specific column.
 */
function bound(value: string | null | undefined, maxLength: number): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // The ellipsis marker itself counts toward maxLength - the DB's own CHECK
  // constraint on provider_error_code enforces an exact byte ceiling, so the
  // truncated slice must leave room for it rather than exceeding the limit
  // by one character.
  return trimmed.length > maxLength ? `${trimmed.slice(0, Math.max(0, maxLength - 1))}…` : trimmed;
}

export type DeliveryStatusCallbackInput = {
  providerMessageId: string;
  twilioStatus: string;
  errorCode: string | null;
  errorMessage: string | null;
};

export type DeliveryStatusOutcome =
  | { outcome: "unknown_message" }
  | { outcome: "not_outbound" }
  | { outcome: "unmapped_provider_status"; twilioStatus: string }
  | { outcome: "no_change"; status: MessageStatus }
  | { outcome: "ignored_downgrade"; currentStatus: MessageStatus; incomingStatus: MessageStatus }
  | {
      outcome: "updated";
      messageId: string;
      organizationId: string;
      fromStatus: MessageStatus;
      toStatus: MessageStatus;
      /** Only set for automation-authored messages - see lib/automation-health/service.ts's own scoping of sms_delivery_failed detection to automation-sent messages only. */
      workflowExecutionId: string | null;
    };

/**
 * The single place a Twilio delivery-status callback is applied to a
 * message row. Deliberately takes only provider-supplied identifiers
 * (providerMessageId/twilioStatus/errorCode/errorMessage) - never an
 * organization id - because the caller (app/api/webhooks/sms/status)
 * authenticates the *request* via Twilio's signature, not the organization;
 * ownership of the specific row being updated is derived here, from the
 * row itself, never trusted from the request.
 *
 * This function ONLY updates messages.status/status_reason/
 * provider_error_code. It never touches conversations, automation_events,
 * workflow_executions, or triggers any automation/AI/outbound send - a
 * delivery-status callback is observability, never a second outbound path
 * and never an entry point into the customer-reply automation.
 */
export async function applyDeliveryStatusUpdate(
  supabase: SupabaseClient,
  input: DeliveryStatusCallbackInput,
): Promise<DeliveryStatusOutcome> {
  const mapped = mapTwilioMessageStatus(input.twilioStatus);
  if (!mapped) return { outcome: "unmapped_provider_status", twilioStatus: input.twilioStatus };

  const { data: message } = await supabase
    .from("messages")
    .select("id, organization_id, direction, status, workflow_execution_id")
    .eq("provider_message_id", input.providerMessageId)
    .maybeSingle();

  if (!message) return { outcome: "unknown_message" };
  if (message.direction !== "outbound") return { outcome: "not_outbound" };

  const currentStatus = message.status as MessageStatus;
  const currentRank = TRACKPR_STATUS_RANK[currentStatus];

  if (currentStatus === mapped.status) {
    return { outcome: "no_change", status: currentStatus };
  }

  if (isTerminalRank(currentRank) || mapped.rank <= currentRank) {
    return { outcome: "ignored_downgrade", currentStatus, incomingStatus: mapped.status };
  }

  const statusReason = mapped.status === "failed" || mapped.status === "undelivered" ? bound(input.errorMessage, MAX_STATUS_REASON_LENGTH) : null;
  const providerErrorCode = bound(input.errorCode, MAX_ERROR_CODE_LENGTH);

  const { error } = await supabase
    .from("messages")
    .update({ status: mapped.status, status_reason: statusReason, provider_error_code: providerErrorCode })
    .eq("id", message.id);

  if (error) {
    // Fails safe - this is not a distinct outcome the caller branches on
    // differently today, but surfacing it as a thrown error (rather than
    // silently reporting "updated") means the route's own error handling/
    // logging sees it rather than masking a real DB failure as success.
    throw new Error(`Failed to update message delivery status: ${error.message}`);
  }

  return {
    outcome: "updated",
    messageId: message.id,
    organizationId: message.organization_id,
    fromStatus: currentStatus,
    toStatus: mapped.status,
    workflowExecutionId: message.workflow_execution_id,
  };
}

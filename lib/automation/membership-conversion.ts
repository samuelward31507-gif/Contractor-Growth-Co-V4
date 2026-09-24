import type { SupabaseClient } from "@supabase/supabase-js";
import { createAutomationEvent } from "./events";
import { startWorkflowExecution, completeWorkflowExecution, failWorkflowExecution } from "./executions";
import { evaluateOutboundGate } from "./outbound-gate";
import { sendOutboundMessage } from "@/lib/messaging/outbound";
import { findOrCreateOpenConversation } from "@/lib/conversations/queries";
import { getBusinessProfile } from "@/lib/settings/queries";
import type { SendSmsInput, SendSmsResult } from "@/lib/automation/sms";

export const MEMBERSHIP_WELCOME_WORKFLOW = "membership_welcome";

/**
 * Gym Revenue Engine, Slice 2: pure fact-recitation with no judgment call
 * for a model to make - same "deterministic, Trackpr-composed" precedent as
 * composeReminderBody (lib/automation/appointment-reminders.ts) and
 * composeCancellationBody/composeRescheduledBody (lib/automation/appointments.ts).
 * No AI/n8n round trip for this message, ever.
 */
function composeWelcomeMessage(organizationName: string): string {
  return `Welcome to ${organizationName}! We're excited to have you as a member. If you have any questions getting started, just reply here. Reply STOP to opt out of texts.`;
}

/**
 * Fires once a staff member has explicitly confirmed a membership
 * conversion (see convertLeadToMembership in app/(app)/leads/actions.ts) -
 * never triggered by AI/n8n. `membership.created` has no catalog entry
 * (getAutomationForEventType returns null for it, matching the existing
 * lead.lost/appointment.cancelled precedent for an uncatalogued lifecycle
 * event) - there is no per-organization enable/disable toggle for this
 * message in this slice, by design; createAutomationEvent skips that check
 * entirely when no catalog automation claims the event type.
 *
 * Still goes through the full automation_events/workflow_executions
 * provenance chain and evaluateOutboundGate, exactly like every other
 * automated send in this codebase - evaluateOutboundGate requires a real
 * `running` workflow_executions row to evaluate against, so this is the
 * minimum machinery needed to send anything through the safe outbound path,
 * not extra ceremony. Never blocks or fails the conversion itself (the
 * membership row is already committed by the caller) - a failure here is
 * logged, not thrown.
 */
export async function emitMembershipWelcomeMessage(
  supabase: SupabaseClient,
  input: { organizationId: string; membershipId: string; contactId: string; leadId: string | null },
  /** Test seam only - production callers must never pass this; see lib/messaging/outbound.ts. */
  sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult>,
): Promise<void> {
  const eventResult = await createAutomationEvent(supabase, {
    eventType: "membership.created",
    entityType: "membership",
    entityId: input.membershipId,
    payload: { membership_id: input.membershipId, contact_id: input.contactId, lead_id: input.leadId },
    idempotencyKey: `membership.created:${input.membershipId}`,
  });

  if (!eventResult.ok) {
    console.error("[automation] failed to create membership.created event", { membershipId: input.membershipId, error: eventResult.error });
    return;
  }
  if (eventResult.duplicate) return;
  if (eventResult.skipped) return;

  const executionResult = await startWorkflowExecution(supabase, eventResult.event.id, MEMBERSHIP_WELCOME_WORKFLOW);
  if (!executionResult.ok) {
    console.error("[automation] failed to start membership.created execution", { membershipId: input.membershipId, error: executionResult.error });
    return;
  }
  const executionId = executionResult.execution.id;

  const [businessProfile, conversation] = await Promise.all([
    getBusinessProfile(supabase, input.organizationId),
    findOrCreateOpenConversation(supabase, input.organizationId, input.contactId, "sms", input.leadId),
  ]);
  const conversationId = conversation?.id ?? null;

  const body = composeWelcomeMessage(businessProfile?.name || "our team");

  const gateResult = await evaluateOutboundGate(supabase, {
    organizationId: input.organizationId,
    executionId,
    contactId: input.contactId,
    conversationId,
    leadId: input.leadId,
    aiResult: { should_send: true, response_message: body, needs_human: false },
  });

  if (!gateResult.allowed) {
    await completeWorkflowExecution(supabase, executionId, {
      should_send: false,
      blocked_reason: gateResult.reason,
      blocked_detail: gateResult.detail ?? null,
      membership_id: input.membershipId,
    });
    return;
  }

  const sendResult = await sendOutboundMessage(supabase, {
    organizationId: input.organizationId,
    contactId: gateResult.contactId,
    conversationId: gateResult.conversationId,
    channel: "sms",
    body: gateResult.body,
    senderType: "ai",
    workflowExecutionId: executionId,
    sendSmsFn,
  });

  if (!sendResult.ok) {
    await failWorkflowExecution(supabase, executionId, sendResult.error, "sms_send_failed");
    return;
  }

  await completeWorkflowExecution(supabase, executionId, {
    should_send: true,
    message_id: sendResult.messageId,
    conversation_id: sendResult.conversationId,
    provider_message_id: sendResult.providerMessageId,
    membership_id: input.membershipId,
  });
}

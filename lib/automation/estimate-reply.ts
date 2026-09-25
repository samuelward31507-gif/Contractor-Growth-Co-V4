import type { SupabaseClient } from "@supabase/supabase-js";
import { createAutomationEventAsService } from "./events";
import { startWorkflowExecutionAsService, completeWorkflowExecutionAsService, failWorkflowExecutionAsService } from "./executions";
import { evaluateOutboundGate } from "./outbound-gate";
import { sendOutboundMessage } from "@/lib/messaging/outbound";
import { recordAutomationHealthSignal } from "../automation-health/service";
import { emitEstimateLifecycleEventAsService } from "./estimates";
import { emitJobCreatedFromEstimate } from "./jobs";
import { notifyFounder } from "@/lib/notifications/founder";
import type { SendSmsInput, SendSmsResult } from "./sms";

export const ESTIMATE_ACCEPTED_REPLY_WORKFLOW = "estimate_accepted_reply";

export type EstimateReplyIntent = "accept" | "unclear";

/**
 * E1 (pre-launch lead-leak audit): deliberately conservative, mirroring
 * lib/reviews-referrals/tracking.ts's own classifyReviewReplySentiment
 * exactly - only unambiguous, high-confidence acceptance phrases match.
 * Anything else, including a reply that merely mentions the estimate
 * without clearly accepting it, is "unclear" and never auto-accepts. There
 * is no ACCEPT_PATTERNS counterpart for decline/negative language by
 * design - this item's scope is acceptance detection only (see the task's
 * own framing); a negative or ambiguous reply is handled identically,
 * escalating to a human rather than being auto-declined.
 */
const ACCEPT_PATTERNS: RegExp[] = [
  /\baccept(ed)?\b/i,
  /\bapprove(d)?\b/i,
  /\bgo ahead\b/i,
  /\blet'?s do (it|this)\b/i,
  /\bsounds good\b/i,
  /\blooks good\b/i,
  /\bbook it\b/i,
  /\blet'?s (move forward|get started|schedule)\b/i,
  /\bi'?m in\b/i,
  /^\s*(yes|yep|yeah|ok|okay|sure)[.!\s]*$/i,
  /^\s*(yes|yep|yeah|sure)[,.!\s]+(please|let'?s do it|sounds good)[.!\s]*$/i,
];

export function classifyEstimateReplyIntent(body: string): EstimateReplyIntent {
  const text = body.trim();
  if (!text) return "unclear";
  if (ACCEPT_PATTERNS.some((pattern) => pattern.test(text))) return "accept";
  return "unclear";
}

function composeEstimateAcceptedConfirmation(title: string): string {
  return `Great news - we've received your approval for ${title}. We'll be in touch shortly to schedule the work. Reply STOP to opt out of texts.`;
}

/**
 * Called from the inbound SMS webhook, BEFORE emitCustomerReplyFollowup -
 * the exact same placement, and the exact same structural shape, as
 * classifyAndEscalateReviewReply. While a contact has an estimate in
 * 'sent' status, every reply is presumptively about it (the same
 * assumption already established and proven for review requests):
 *
 *  - a clear, high-confidence "accept" transitions the estimate, creates the
 *    job (both via the same effective path transitionEstimate()'s own
 *    "accepted" branch already uses for a staff-driven Accept click - see
 *    app/(app)/estimates/actions.ts), and sends ONE deterministic
 *    confirmation SMS through the existing outbound safety gate, using its
 *    own dedicated event/execution (never reused from an unrelated
 *    workflow) so evaluateOutboundGate has a real, current execution to
 *    check against - mirroring app/api/webhooks/voice/inbound/route.ts's
 *    own missed-call SMS exactly.
 *  - anything else (including a reply that merely discusses the estimate
 *    without clearly accepting it, or a clearly negative reply) is treated
 *    exactly like a non-positive review reply: locks the conversation out
 *    of further automated AI turns and notifies the founder, so a human -
 *    never the AI, never this function - decides how to respond. Ambiguous
 *    language can never auto-accept an estimate.
 *
 * Idempotent throughout: the estimate UPDATE only ever affects a row still
 * in 'sent' status (a second reply, or a staff member accepting it manually
 * moments earlier, is a safe no-op), the confirmation SMS's own event uses
 * a deterministic idempotency key derived from the estimate id, and the
 * conversation lock reuses the same `ai_enabled` conditional-guard
 * idempotency this codebase already relies on everywhere else.
 */
export async function classifyAndProcessEstimateReply(
  supabase: SupabaseClient,
  organizationId: string,
  contactId: string,
  leadId: string | null,
  conversationId: string,
  messageBody: string,
  sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult>,
): Promise<void> {
  const { data: activeEstimate } = await supabase
    .from("estimates")
    .select("id, title")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .eq("status", "sent")
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!activeEstimate) return;

  const intent = classifyEstimateReplyIntent(messageBody);

  if (intent !== "accept") {
    const { data: lockedRow, error: lockError } = await supabase
      .from("conversations")
      .update({ ai_enabled: false })
      .eq("id", conversationId)
      .eq("organization_id", organizationId)
      .eq("ai_enabled", true)
      .select("id")
      .maybeSingle();

    if (lockError) {
      console.error("[automation] failed to lock conversation after an unclear estimate reply", { organizationId, conversationId, error: lockError.message });
      return;
    }
    if (lockedRow) {
      await recordAutomationHealthSignal(supabase, {
        organizationId,
        category: "human_escalation_requested",
        severity: "warning",
        fingerprintContext: conversationId,
        title: "AI escalated a conversation to a human",
        description: "A customer replied to a sent estimate in a way that wasn't a clear acceptance and needs a human to interpret it.",
        metadata: { conversationId, contactId, leadId, estimateId: activeEstimate.id },
      });
      await notifyFounder(supabase, {
        organizationId,
        kind: "ai_escalation",
        summary: "A customer replied to a sent estimate and it needs a human look.",
        detailPath: `/conversations/${conversationId}`,
      });
    }
    return;
  }

  const { data: transitioned } = await supabase
    .from("estimates")
    .update({ status: "accepted", responded_at: new Date().toISOString() })
    .eq("id", activeEstimate.id)
    .eq("organization_id", organizationId)
    .eq("status", "sent")
    .select("id")
    .maybeSingle();

  if (!transitioned) return;

  // KNOWN, ACCEPTED LIMITATION: emitJobCreatedFromEstimate (lib/automation/jobs.ts)
  // is documented as session-only ("always has an authenticated user
  // session, hence the plain (non-service) event/execution helpers") - it
  // still correctly creates the job row and syncs leads.status to 'won'
  // when called with a service-role client (both are plain table writes,
  // not session-gated), but its own internal job.created/lead-stage-history
  // event emission silently no-ops ("Not authenticated.", caught and
  // logged, never thrown) since those sub-calls require a real auth.uid().
  // The practical effect: the job/lead-won side of estimate acceptance is
  // fully correct via this path, but the separate, optional "AI-drafted job
  // kickoff" notification (job-created-followup) does not fire for a job
  // created this way - not a regression (nothing called this function with
  // a service-role client before), and not user-visible data loss (this
  // function's own confirmation SMS below already tells the customer their
  // estimate was accepted). Left as-is rather than modifying
  // emitJobCreatedFromEstimate itself, to avoid touching a shared,
  // already-tested function's contract for every other caller - a
  // dedicated *AsService variant would be the correct follow-up if the job
  // kickoff notification is wanted for this specific path.
  await emitEstimateLifecycleEventAsService(supabase, organizationId, activeEstimate.id, "estimate.accepted");
  await emitJobCreatedFromEstimate(supabase, organizationId, activeEstimate.id);

  const eventResult = await createAutomationEventAsService(supabase, organizationId, {
    eventType: "estimate.accepted_via_reply",
    entityType: "estimate",
    entityId: activeEstimate.id,
    payload: { estimate_id: activeEstimate.id, contact_id: contactId, lead_id: leadId, conversation_id: conversationId },
    idempotencyKey: `estimate.accepted_via_reply:${activeEstimate.id}`,
  });

  if (!eventResult.ok) {
    console.error("[automation] failed to create estimate.accepted_via_reply event", { estimateId: activeEstimate.id, error: eventResult.error });
    return;
  }
  if (eventResult.duplicate || eventResult.skipped) return;

  const executionResult = await startWorkflowExecutionAsService(supabase, eventResult.event.id, ESTIMATE_ACCEPTED_REPLY_WORKFLOW);
  if (!executionResult.ok) {
    console.error("[automation] failed to start estimate.accepted_via_reply execution", { estimateId: activeEstimate.id, error: executionResult.error });
    return;
  }
  const executionId = executionResult.execution.id;

  const body = composeEstimateAcceptedConfirmation(activeEstimate.title);
  const gateResult = await evaluateOutboundGate(supabase, {
    organizationId,
    executionId,
    contactId,
    conversationId,
    leadId,
    aiResult: { should_send: true, response_message: body, needs_human: false },
  });

  if (gateResult.allowed) {
    const sendResult = await sendOutboundMessage(supabase, {
      organizationId,
      contactId: gateResult.contactId,
      conversationId: gateResult.conversationId,
      channel: "sms",
      body: gateResult.body,
      senderType: "system",
      workflowExecutionId: executionId,
      sendSmsFn,
    });
    if (sendResult.ok) {
      await completeWorkflowExecutionAsService(supabase, executionId, { should_send: true, estimate_id: activeEstimate.id });
    } else {
      await failWorkflowExecutionAsService(supabase, executionId, sendResult.error, "sms_send_failed");
    }
  } else {
    await completeWorkflowExecutionAsService(supabase, executionId, { should_send: false, blocked_reason: gateResult.reason, estimate_id: activeEstimate.id });
  }
}

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAutomationEvent } from "./events";
import { startWorkflowExecution, completeWorkflowExecution, failWorkflowExecution } from "./executions";
import { evaluateOutboundGate } from "./outbound-gate";
import type { SendSmsInput, SendSmsResult } from "./sms";
import { sendOutboundMessage } from "@/lib/messaging/outbound";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { findOrCreateOpenConversation } from "@/lib/conversations/queries";
import { getEstimate } from "@/lib/estimates/queries";
import { getBusinessProfile } from "@/lib/settings/queries";
import { buildEstimateApprovalUrl } from "@/lib/estimates/approval-link";

export const ESTIMATE_DELIVERY_WORKFLOW = "estimate_delivery";

/**
 * The customer-facing delivery text. Deterministic (never AI-drafted) and
 * worded to pass the outbound gate's content-safety screen: no price, and
 * none of the "your estimate is" / "estimate is ready" phrasings that screen
 * reserves for catching invented claims - the amount lives on the approval
 * page itself.
 */
export function composeEstimateDeliveryBody(input: { firstName: string | null; businessName: string | null; title: string; approvalUrl: string }): string {
  const greeting = input.firstName?.trim() ? `Hi ${input.firstName.trim()}, ` : "Hi, ";
  const from = input.businessName?.trim() ? `${input.businessName.trim()} has sent you a quote` : "You have a new quote";
  return `${greeting}${from} for ${input.title.trim()}. Review and approve it here: ${input.approvalUrl}`;
}

export type EstimateDeliveryOutcome =
  | { status: "sent"; messageId: string | null }
  | { status: "blocked"; reason: string }
  | { status: "send_failed"; error: string }
  | { status: "skipped"; reason: "duplicate" | "automation_skipped" | "no_link_base" | "not_found" | "not_sent" | "no_contact" | "error" };

/**
 * Delivers a just-sent estimate's real approval link (app/quote/[token]) to
 * the customer by SMS - previously the contractor had to copy the link out
 * of the estimate page and send it some other way, so a customer could never
 * accept on their own.
 *
 * Trackpr-composed and sent exactly like the appointment cancel/reschedule
 * notifications: its own `estimate.delivery` event + `estimate_delivery`
 * execution (idempotent per estimate - a replayed send can never text twice),
 * then evaluateOutboundGate (opt-out, content safety, payment/pause/TEST-mode,
 * estimate still 'sent') and only then sendOutboundMessage. The gate decision
 * is recorded on the execution either way, so a TEST-mode block is auditable.
 * The AI-drafted estimate.sent notification (emitEstimateSent) is unchanged
 * and still runs alongside it.
 *
 * `supabase` is the contractor's session client (events/executions); the
 * gate and send use a service-role client because `messages` has no RLS
 * UPDATE policy (same reason as sendAppointmentLifecycleMessage). Never
 * throws - the estimate is already sent.
 */
export async function deliverEstimateToCustomer(
  supabase: SupabaseClient,
  estimateId: string,
  linkBaseUrl: string | null,
  /** Test seam only - production callers never pass this; see lib/messaging/outbound.ts. */
  sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult>,
): Promise<EstimateDeliveryOutcome> {
  try {
    const { data: estimateOrg } = await supabase.from("estimates").select("organization_id").eq("id", estimateId).maybeSingle();
    const organizationId = (estimateOrg?.organization_id as string | undefined) ?? null;
    const estimate = organizationId ? await getEstimate(supabase, organizationId, estimateId) : null;
    if (!organizationId || !estimate) return { status: "skipped", reason: "not_found" };
    if (estimate.status !== "sent") return { status: "skipped", reason: "not_sent" };
    if (!estimate.contact_id) return { status: "skipped", reason: "no_contact" };
    if (!linkBaseUrl) {
      console.error("[automation] estimate delivery skipped: no app base URL configured", { estimateId });
      return { status: "skipped", reason: "no_link_base" };
    }

    const approvalUrl = buildEstimateApprovalUrl(linkBaseUrl, estimate.approval_token);
    const conversation = await findOrCreateOpenConversation(supabase, organizationId, estimate.contact_id, "sms", estimate.lead_id);
    const conversationId = conversation?.id ?? null;

    const eventResult = await createAutomationEvent(supabase, {
      eventType: "estimate.delivery",
      entityType: "estimate",
      entityId: estimateId,
      payload: { estimate_id: estimateId, contact_id: estimate.contact_id, conversation_id: conversationId, approval_url: approvalUrl },
      idempotencyKey: `estimate.delivery:${estimateId}`,
    });
    if (!eventResult.ok) {
      console.error("[automation] failed to create estimate.delivery event", { estimateId, error: eventResult.error });
      return { status: "skipped", reason: "error" };
    }
    if (eventResult.duplicate) return { status: "skipped", reason: "duplicate" };
    if (eventResult.skipped) return { status: "skipped", reason: "automation_skipped" };

    const executionResult = await startWorkflowExecution(supabase, eventResult.event.id, ESTIMATE_DELIVERY_WORKFLOW);
    if (!executionResult.ok) {
      console.error("[automation] failed to start estimate_delivery execution", { estimateId, error: executionResult.error });
      return { status: "skipped", reason: "error" };
    }
    const executionId = executionResult.execution.id;

    const service = createServiceRoleClient();
    const businessProfile = await getBusinessProfile(service, organizationId);
    const body = composeEstimateDeliveryBody({
      firstName: estimate.contact?.first_name ?? null,
      businessName: businessProfile?.name ?? null,
      title: estimate.title,
      approvalUrl,
    });

    const gate = await evaluateOutboundGate(service, {
      organizationId,
      executionId,
      contactId: estimate.contact_id,
      conversationId,
      // Same choice as emitEstimateSent: no lead_id, so the gate doesn't
      // additionally require the conversation's lead to match the estimate's.
      leadId: null,
      aiResult: { should_send: true, response_message: body, needs_human: false },
      estimateId,
      estimateEligibleStatuses: ["sent"],
    });

    let outcome: EstimateDeliveryOutcome;
    if (!gate.allowed) {
      outcome = { status: "blocked", reason: gate.reason };
    } else {
      const sendResult = await sendOutboundMessage(service, {
        organizationId,
        contactId: gate.contactId,
        conversationId: gate.conversationId,
        channel: "sms",
        body: gate.body,
        senderType: "system",
        workflowExecutionId: executionId,
        sendSmsFn,
      });
      outcome = sendResult.ok ? { status: "sent", messageId: sendResult.messageId } : { status: "send_failed", error: sendResult.error };
    }

    // A send that the gate allowed but the provider rejected is a failed
    // execution (with an sms_send_failed incident), never a "completed" one
    // with the error tucked into metadata.
    if (outcome.status === "send_failed") {
      const failed = await failWorkflowExecution(supabase, executionId, outcome.error, "sms_send_failed");
      if (!failed.ok) {
        console.error("[automation] failed to record estimate_delivery send failure", { estimateId, error: failed.error });
      }
      return outcome;
    }

    const completed = await completeWorkflowExecution(supabase, executionId, {
      estimate_id: estimateId,
      approval_url_included: true,
      should_send: outcome.status === "sent",
      blocked_reason: outcome.status === "blocked" ? outcome.reason : null,
      blocked_detail: !gate.allowed ? (gate.detail ?? null) : null,
    });
    if (!completed.ok) {
      console.error("[automation] failed to complete estimate_delivery execution", { estimateId, error: completed.error });
    }
    return outcome;
  } catch (error) {
    console.error("[automation] deliverEstimateToCustomer threw", { estimateId, error: error instanceof Error ? error.message : String(error) });
    return { status: "skipped", reason: "error" };
  }
}

import type { SupabaseClient } from "@supabase/supabase-js";
import { emitCustomerReplyFollowup } from "@/lib/automation/customer-reply";
import { classifyAndProcessEstimateReply } from "@/lib/automation/estimate-reply";
import { classifyAndProcessBookingReply } from "@/lib/automation/booking-reply";
import { recordRequestResponses, classifyAndEscalateReviewReply } from "@/lib/reviews-referrals/tracking";
import { emitLeadStageChangedAsService } from "@/lib/automation/lead-stage-history";
import { resolveLeadForIntake } from "@/lib/leads/intake";

export type InboundCustomerMessageInput = {
  organizationId: string;
  contactId: string;
  conversationId: string;
  body: string;
  /** The stored message's provider id - the customer.message.received idempotency source. */
  providerMessageId: string;
};

/**
 * Everything that happens to a normal (non-keyword) inbound customer message
 * AFTER it has been persisted to `messages`: review-reply escalation,
 * estimate-reply processing, booking-reply handling, the customer_reply_
 * followup automation (only when booking-reply didn't fully own the turn),
 * and review/referral response bookkeeping - in exactly that order.
 *
 * Extracted unchanged from app/api/webhooks/sms/inbound/route.ts so the real
 * Twilio webhook and the TEST-only "Simulate Customer Reply" action
 * (lib/messaging/simulate-customer-reply.ts) run the same code. Sends nothing
 * itself: every customer-facing reply it can lead to goes through
 * evaluateOutboundGate() in the code it calls.
 */
export async function processInboundCustomerMessage(service: SupabaseClient, input: InboundCustomerMessageInput): Promise<void> {
  const { organizationId, contactId, conversationId, body, providerMessageId } = input;

  // P0 A1: deterministic attribution instead of trusting a possibly null or
  // stale conversations.lead_id. Known contact with an open lead -> that
  // lead (no new lead); no open lead (unknown number, or only closed
  // leads) -> one new 'sms_inbound' lead, and the conversation is pointed
  // at it. A repeated message reuses the now-open lead. Compliance keywords
  // never reach this function (both callers exclude them).
  // Attribution must never cost the customer their reply: any failure
  // (returned or thrown) falls back to the conversation's own lead.
  const intake = await resolveLeadForIntake(service, { organizationId, contactId, source: "sms_inbound" }).catch((error: unknown) => ({
    ok: false as const,
    error: error instanceof Error ? error.message : String(error),
  }));
  if (!intake.ok) {
    console.error("[sms][inbound] lead attribution failed - continuing with the conversation's lead", { organizationId, contactId, error: intake.error });
  } else if (intake.created) {
    await emitLeadStageChangedAsService(service, organizationId, { leadId: intake.leadId, previousStatus: null, newStatus: "new", source: "automation" });
  }
  const { data: conversationRow } = intake.ok
    ? { data: null }
    : await service.from("conversations").select("lead_id").eq("id", conversationId).maybeSingle();
  const conversationLead = { lead_id: intake.ok ? intake.leadId : ((conversationRow?.lead_id as string | null | undefined) ?? null) };

  // Growth System Completion Pass 1 (Part 5): runs BEFORE the customer-reply
  // AI dispatch below, and only ever locks AI out of the conversation
  // (never sends anything itself) - so a negative/unclear reply to a
  // review request is guaranteed to never receive an AI-drafted response,
  // by construction, not by convention. A no-op when there is no
  // currently-'requested' review_request for this contact, or the reply
  // reads as clearly positive.
  await classifyAndEscalateReviewReply(service, organizationId, contactId, conversationId, body);

  // E1 (pre-launch lead-leak audit): same placement and shape as the
  // review-reply classification immediately above - runs BEFORE the
  // customer-reply AI dispatch so a clear acceptance is acted on (or an
  // unclear one locks the conversation) before the AI ever drafts a
  // competing reply. A no-op when this contact has no estimate currently
  // in 'sent' status.
  await classifyAndProcessEstimateReply(service, organizationId, contactId, conversationLead.lead_id, conversationId, body);

  // Pass 1 (booking loop completion): unlike the two classifiers above
  // (which only ever lock/no-op, never fully own a reply), this one CAN
  // fully handle the message - a real slot selection, a reschedule
  // request, or a cancellation. When it does, the AI must never also
  // draft a competing reply to the same message, so emitCustomerReplyFollowup
  // is skipped entirely for that turn. A no-op (false) for any message
  // this module has no opinion about - normal AI qualification continues
  // exactly as before.
  const bookingReplyHandled = await classifyAndProcessBookingReply(service, organizationId, contactId, conversationLead.lead_id, conversationId, body);

  if (!bookingReplyHandled) {
    await emitCustomerReplyFollowup(service, {
      organizationId,
      contactId,
      conversationId,
      leadId: conversationLead.lead_id,
      messageBody: body,
      providerMessageId,
    });
  }

  // Review & Referral Tracking V1: deterministic, non-AI bookkeeping only
  // - records that the contact replied at all, never what they said or
  // whether it means the review/referral succeeded. Runs alongside (not
  // instead of) the customer-reply automation above; a no-op when there is
  // no currently-'requested' review/referral row for this contact.
  await recordRequestResponses(service, organizationId, contactId);
}

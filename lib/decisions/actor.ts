import type { AttentionItem } from "@/lib/dashboard/queries";
import type { PrioritizedOpportunity } from "@/lib/opportunities/intelligence";
import { E164_PATTERN } from "@/lib/automation/sms";
import { countsAsEvidence } from "@/lib/conversations/waiting";

/**
 * Phase 2-3: who acts on a decision item. "trackpr" only when a Trackpr
 * action is genuinely still pending for that specific item (C1); every
 * other item - including every operational exception - is "human".
 * PrioritizedOpportunity.automatable is capability only and is not read
 * here: most of the automations it points at are one-shot and have already
 * run (or failed) by the time the opportunity exists.
 *
 * Pure: the caller resolves a DecisionContext (lib/decisions/context.ts)
 * from batched reads and passes it in.
 */
export type DecisionActor = "human" | "trackpr";

/** How long Trackpr's AI gets to answer a waiting customer before the conversation needs a human (A6). */
export const AI_REPLY_GRACE_MS = 15 * 60 * 1000;

/**
 * Estimate follow-up's second touch is due 72h after sending under the
 * default configuration (C7 / A16). Until then Trackpr still has a follow-up
 * to send. Phase 2-13 (R-d): the organization's configured followup_2_hours
 * replaces it when set (DecisionContext.estimateFollowupWindowMs); this is
 * the fallback.
 */
export const ESTIMATE_FOLLOWUP_WINDOW_MS = 72 * 60 * 60 * 1000;

/**
 * Phase 2-4 (A3): a pending estimate a human owns only becomes attention 24h
 * after it was sent; younger ones are left out of Act II and the count.
 */
export const ESTIMATE_HUMAN_ATTENTION_DELAY_MS = 24 * 60 * 60 * 1000;

/**
 * dashboard_conversation_attention returns at most this many awaiting_reply
 * conversations (rn <= 5 - the same cap Today's CONVERSATION_ATTENTION_CAP
 * discloses). When it is reached, older waits may exist beyond it, so the
 * grace period is not applied at all (C5).
 */
export const WAITING_REPLY_CAP = 5;

export type WaitingConversationState = {
  /** conversations.ai_enabled - false once staff take over or the AI hands off. */
  aiEnabled: boolean;
  smsOptOut: boolean;
  /** The first inbound customer message after the conversation's last outbound message (C3); null when unknown. */
  firstUnansweredInboundAt: string | null;
};

export type DecisionContext = {
  /** The single "now" every timing rule uses (ms since epoch). */
  now: number;
  /** organizations: automation_mode = 'live', payment_status = 'active', automation_paused = false - fails closed on a read error. */
  organizationEligible: boolean;
  /** ai_settings.ai_enabled - no row means disabled, matching getAiSettings and the n8n callback's own check. */
  aiSettingsEnabled: boolean;
  /** automation_settings, falling back to the catalog default. */
  inboundReplyEnabled: boolean;
  estimateFollowupEnabled: boolean;
  /** True unless inbound-customer-reply respects business hours and they are closed right now (the outbound gate's own isWithinBusinessHours). */
  inboundReplyWithinHours: boolean;
  /** The SQL cap was reached: every waiting conversation is human (C5). */
  waitingCapReached: boolean;
  /** Keyed by conversation id; a conversation missing here is human. */
  waitingConversations: ReadonlyMap<string, WaitingConversationState>;
  /**
   * Phase 2-4: contacts of open pending estimates that have an open SMS
   * conversation with AI turned off - the outbound gate blocks every
   * automated send into such a conversation, so estimate follow-up cannot
   * reach them.
   */
  estimateContactAiDisabled: ReadonlySet<string>;
  /**
   * Phase 2-11 (G4): per contact, the time (ms) of the latest successful
   * (sent or delivered) outbound message - read only when a pending estimate
   * is past its follow-up window (72h, or the configured one - R-d). Absent or null means unknown: no estimate is then
   * labelled a missed follow-up.
   */
  latestOutboundMsByContact?: ReadonlyMap<string, number> | null;
  /**
   * Phase 2-13 (R-d): the organization's estimate follow-up window - its
   * configured followup_2_hours (the second and last touch), read with the
   * automation's own lenient reader. Trackpr owns a pending estimate until
   * then; a person's missed follow-up begins only after it. Absent means
   * the default 72h.
   */
  estimateFollowupWindowMs?: number;
};

/** Phase 2-13 (R-d): the configured estimate follow-up window, or the 72h default. */
export const estimateFollowupWindowMs = (context: Pick<DecisionContext, "estimateFollowupWindowMs">): number => context.estimateFollowupWindowMs ?? ESTIMATE_FOLLOWUP_WINDOW_MS;

/** Every item human - the context the assembler uses when none is supplied, and the safe fallback. */
export const ALL_HUMAN_CONTEXT: DecisionContext = {
  now: 0,
  organizationEligible: false,
  aiSettingsEnabled: false,
  inboundReplyEnabled: false,
  estimateFollowupEnabled: false,
  inboundReplyWithinHours: false,
  waitingCapReached: true,
  waitingConversations: new Map(),
  estimateContactAiDisabled: new Set(),
};

/**
 * From a conversation's messages, newest first: the oldest inbound message
 * in the unbroken run of inbound messages at the top - i.e. the first one
 * nobody has answered. Phase 3 (W1, refining C3): only a SUCCESSFUL outbound
 * message (sent or delivered - AI, staff or a customer-facing system send,
 * B2) ends the run; a failed, undelivered or queued send, or a logged note,
 * is not a reply and is skipped. A message with no status is treated as
 * evidence (callers that cannot read status keep the old behavior). Null when
 * the newest evidence is not inbound. If every message read is inbound, the
 * oldest read is the best known start (the run may be longer).
 */
export function firstUnansweredInboundAt(messagesNewestFirst: { created_at: string; direction: "inbound" | "outbound"; status?: string | null }[]): string | null {
  let first: string | null = null;
  for (const message of messagesNewestFirst) {
    if (message.direction === "outbound" && message.status !== undefined && !countsAsEvidence({ direction: "outbound", status: message.status })) continue;
    if (message.direction !== "inbound") break;
    first = message.created_at;
  }
  return first;
}

/**
 * B4 corrected (C2): Trackpr's AI can answer this conversation right now -
 * the conversation's AI is on, the organization's AI is on, the
 * inbound-customer-reply automation is on, the organization is live, paid
 * and not paused, the contact has not opted out, and (when that
 * automation respects business hours) they are open.
 */
export function aiReplyEligible(conversation: WaitingConversationState, context: DecisionContext): boolean {
  return (
    conversation.aiEnabled &&
    context.aiSettingsEnabled &&
    context.inboundReplyEnabled &&
    context.organizationEligible &&
    !conversation.smsOptOut &&
    context.inboundReplyWithinHours
  );
}

/** The conversation a waiting-for-reply signal belongs to - carried on the item, never parsed from its id or link. */
export function resolveSignalActor(item: Pick<AttentionItem, "kind" | "conversationId">, context: DecisionContext): DecisionActor {
  if (item.kind !== "awaiting_reply") return "human";
  if (context.waitingCapReached || !item.conversationId) return "human";
  const conversation = context.waitingConversations.get(item.conversationId);
  if (!conversation || !conversation.firstUnansweredInboundAt) return "human";
  if (!aiReplyEligible(conversation, context)) return "human";
  const waitedMs = context.now - new Date(conversation.firstUnansweredInboundAt).getTime();
  return waitedMs < AI_REPLY_GRACE_MS ? "trackpr" : "human";
}

/**
 * Only a sent estimate still has a pending Trackpr action: estimate
 * follow-up's two touches run until the second touch is due (72h after
 * sending by default; the configured followup_2_hours - R-d), and only when they
 * can actually be sent - including (Phase 2-4, K2) the contact having no
 * open SMS conversation with AI turned off. Every other opportunity type's
 * automation is one-shot (or absent), so it is human.
 */
export function resolveOpportunityActor(prioritized: Pick<PrioritizedOpportunity, "opportunity" | "contactPhone" | "contactSmsOptOut">, context: DecisionContext): DecisionActor {
  const { opportunity } = prioritized;
  if (opportunity.type !== "pending_estimate") return "human";
  if (!context.organizationEligible || !context.estimateFollowupEnabled) return "human";
  if (!prioritized.contactPhone || !E164_PATTERN.test(prioritized.contactPhone.trim()) || prioritized.contactSmsOptOut !== false) return "human";
  if (opportunity.contactId && context.estimateContactAiDisabled.has(opportunity.contactId)) return "human";
  const sentAt = opportunity.metadata.sent_at;
  if (typeof sentAt !== "string") return "human";
  const sentMs = new Date(sentAt).getTime();
  if (Number.isNaN(sentMs)) return "human";
  return context.now - sentMs < estimateFollowupWindowMs(context) ? "trackpr" : "human";
}

/**
 * Phase 2-4 (A3, K3): a human-owned pending estimate younger than 24h is not
 * attention yet - it is left out of Act II, the count and the handling row,
 * and stays reachable in By type. An unknown or unreadable sent_at is
 * treated as old enough, so missing data never hides human work.
 */
export function isEstimateTooYoungForAttention(opportunity: Pick<PrioritizedOpportunity["opportunity"], "type" | "metadata">, now: number): boolean {
  if (opportunity.type !== "pending_estimate") return false;
  const sentAt = opportunity.metadata.sent_at;
  if (typeof sentAt !== "string") return false;
  const sentMs = new Date(sentAt).getTime();
  if (Number.isNaN(sentMs)) return false;
  return now - sentMs < ESTIMATE_HUMAN_ATTENTION_DELAY_MS;
}

import { ESTIMATE_FOLLOWUP_WINDOW_MS, type WaitingConversationState } from "./actor";

/**
 * Phase 2-11 (A7-A9, rulings G1-G5): "Missed follow-up" is a Today
 * presentation of three existing kinds of human work - the underlying reason
 * codes, opportunity types, source keys, actors and thresholds are unchanged
 * (A9). Pure: the caller passes the decision context it already resolved.
 *
 *   first_contact     - every uncontacted lead: the detector only produces
 *                       one at 24h or more with no successful contact (G5).
 *   reply             - a human-owned waiting reply whose first unanswered
 *                       customer message is 4h or more old (A8, G3). When the
 *                       conversation's timestamp is unknown, nothing changes.
 *   estimate_followup - a pending estimate sent 72h or more ago (the
 *                       organization's configured followup_2_hours when
 *                       set - R-d, Phase 2-13) with no
 *                       successful outbound message to its contact after
 *                       sent_at (A7, G4). Trackpr's own automated follow-ups
 *                       are outbound messages, so they count as follow-up
 *                       (B10). When the outbound read is unavailable, nothing
 *                       changes.
 */
export type MissedFollowUpKind = "first_contact" | "reply" | "estimate_followup";

export const MISSED_FOLLOW_UP_LABEL: Record<MissedFollowUpKind, string> = {
  first_contact: "Missed follow-up · First contact",
  reply: "Missed follow-up · Reply",
  estimate_followup: "Missed follow-up · Estimate follow-up",
};

/** A8: a reply is a missed follow-up once the customer has waited this long. */
export const REPLY_FOLLOW_UP_WINDOW_MS = 4 * 60 * 60 * 1000;

/** A7: an estimate follow-up is missed 72h after sending by default - the same window Trackpr's own estimate follow-up uses (Phase 2-4). Phase 2-13 (R-d): callers pass the configured window. */
export const ESTIMATE_FOLLOW_UP_WINDOW_MS = ESTIMATE_FOLLOWUP_WINDOW_MS;

const ms = (iso: string | null | undefined): number => (typeof iso === "string" ? new Date(iso).getTime() : Number.NaN);

export function isReplyFollowUpMissed(conversation: WaitingConversationState | undefined, now: number): boolean {
  const waitingSince = ms(conversation?.firstUnansweredInboundAt);
  return !Number.isNaN(waitingSince) && now - waitingSince >= REPLY_FOLLOW_UP_WINDOW_MS;
}

export function isEstimateFollowUpMissed(
  opportunity: { contactId: string | null; metadata: Record<string, unknown> },
  latestOutboundMsByContact: ReadonlyMap<string, number> | null | undefined,
  now: number,
  windowMs: number = ESTIMATE_FOLLOW_UP_WINDOW_MS,
): boolean {
  if (!latestOutboundMsByContact) return false;
  const sentMs = ms(opportunity.metadata.sent_at as string | undefined);
  if (Number.isNaN(sentMs) || now - sentMs < windowMs) return false;
  // No contact means nothing can have been sent to them.
  const latestOutbound = opportunity.contactId ? (latestOutboundMsByContact.get(opportunity.contactId) ?? Number.NEGATIVE_INFINITY) : Number.NEGATIVE_INFINITY;
  return latestOutbound <= sentMs;
}

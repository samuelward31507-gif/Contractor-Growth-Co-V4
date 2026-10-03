import { buildPriorityQueue, getConversationSignals, getOperationalExceptions, type PrioritizedOpportunity, type PriorityItem, type PriorityTier } from "@/lib/opportunities/intelligence";
import type { AttentionItem } from "@/lib/dashboard/queries";
import { formatCurrency, formatRelativeTime } from "@/lib/dashboard/format";
import type { StatusTone } from "@/lib/ui/status";
import { DECISION_REGISTRY, buildActionSentence, opportunityActionHref, opportunityPersonHref } from "./registry";
import { REASON_CODE_BY_EXCEPTION_KIND, REASON_CODE_BY_OPPORTUNITY_TYPE, REASON_CODE_BY_SIGNAL_KIND, type ConversationSignalKind, type OperationalExceptionKind } from "./reason-codes";
import type { AssembledDecisions, DecisionItem } from "./types";
import { ALL_HUMAN_CONTEXT, resolveOpportunityActor, resolveSignalActor, type DecisionContext } from "./actor";

/** Canonical Opportunity Intelligence Layer: the internal tier is never shown as a number or a tier name - it maps to the same three-tone visual language every other status surface in this app already uses (lib/ui/status.ts). */
const TONE_BY_TIER: Record<PriorityTier, StatusTone> = {
  needs_reply: "urgent",
  committed_revenue_at_risk: "urgent",
  active_pursuit: "soon",
  at_risk: "soon",
  recoverable: "good",
  growth: "good",
};

/**
 * The two tiers that are worth pursuing but never need the owner to step in
 * (lib/opportunities/intelligence.ts's TIER_ORDER: last and second to last) -
 * reactivating a dormant customer, asking for a review or a referral. They
 * belong to "what opportunity exists", not "what needs attention", so they
 * never keep the owner from being caught up. Every other tier stays in the
 * attention list.
 */
export const OPPORTUNITY_TIERS: ReadonlySet<PriorityTier> = new Set(["recoverable", "growth"]);

function priorityItemToDecision(item: PriorityItem, context: DecisionContext): DecisionItem {
  if (item.kind === "opportunity") {
    const { opportunity, explanation, recommendedAction, automatable, contactPhone } = item.data;
    const reasonCode = REASON_CODE_BY_OPPORTUNITY_TYPE[opportunity.type];
    const entry = DECISION_REGISTRY[reasonCode];
    return {
      key: item.key,
      reasonCode,
      act: OPPORTUNITY_TIERS.has(item.tier) ? "opportunity" : "attention",
      operational: false,
      actor: resolveOpportunityActor(item.data, context),
      tier: item.tier,
      tone: TONE_BY_TIER[item.tier],
      problemLabel: entry.problemLabel,
      subject: { name: opportunity.title, href: opportunityPersonHref(opportunity) },
      explanation,
      sentence: buildActionSentence(explanation.primaryReason, explanation.supportingSignals, explanation.counterSignals, recommendedAction),
      money: opportunity.estimatedValue != null ? formatCurrency(opportunity.estimatedValue) : undefined,
      age: formatRelativeTime(opportunity.createdAt),
      phone: contactPhone,
      nextAction: { code: recommendedAction, label: entry.actionLabel, href: opportunityActionHref(opportunity), automatable },
      source: { kind: "opportunity", opportunityId: opportunity.id, opportunityType: opportunity.type },
    };
  }

  const { kind, title, href, explanation, recommendedAction, conversationId } = item.data;
  const reasonCode = REASON_CODE_BY_SIGNAL_KIND[kind as ConversationSignalKind];
  const entry = DECISION_REGISTRY[reasonCode];
  return {
    key: item.key,
    reasonCode,
    act: OPPORTUNITY_TIERS.has(item.tier) ? "opportunity" : "attention",
    operational: false,
    actor: resolveSignalActor({ kind, conversationId }, context),
    tier: item.tier,
    tone: TONE_BY_TIER[item.tier],
    problemLabel: entry.problemLabel,
    subject: { name: title, href },
    explanation,
    sentence: buildActionSentence(explanation.primaryReason, [], [], recommendedAction),
    phone: null,
    nextAction: { code: recommendedAction, label: entry.actionLabel, href, automatable: false },
    source: { kind: "signal", attentionKind: kind },
  };
}

/**
 * Phase 2-2: assembles Today's decision items from the reads Today already
 * makes - pure and synchronous, no I/O. Operational exceptions come out of
 * the attention list in its own order; conversation signals and persisted
 * opportunities go through the unchanged buildPriorityQueue with the same
 * inputs in the same order, so ordering and ties are exactly as before; the
 * queue then splits by tier into Act II and Act III.
 */
export function assembleDecisions(input: { attentionItems: AttentionItem[]; prioritizedOpportunities: PrioritizedOpportunity[]; context?: DecisionContext }): AssembledDecisions {
  // Without a resolved context every item is human - the safe default.
  const context = input.context ?? ALL_HUMAN_CONTEXT;
  const exceptions: DecisionItem[] = getOperationalExceptions(input.attentionItems).map((exception) => {
    const reasonCode = REASON_CODE_BY_EXCEPTION_KIND[exception.kind as OperationalExceptionKind];
    const entry = DECISION_REGISTRY[reasonCode];
    return {
      key: exception.incidentId ?? `${exception.kind}-${exception.href}`,
      reasonCode,
      act: "attention",
      operational: true,
      actor: "human",
      tier: null,
      tone: "urgent",
      problemLabel: entry.problemLabel,
      subject: { name: exception.title, href: exception.href },
      explanation: { primaryReason: exception.detail, supportingSignals: [], counterSignals: [], confidence: "confirmed" },
      sentence: exception.detail,
      phone: null,
      nextAction: { code: null, label: entry.actionLabel, href: exception.href, automatable: false },
      source: { kind: "exception", attentionKind: exception.kind, incidentId: exception.incidentId, incidentStatus: exception.incidentStatus },
    };
  });

  const queue = buildPriorityQueue(input.prioritizedOpportunities, getConversationSignals(input.attentionItems)).map((item) => priorityItemToDecision(item, context));
  // Phase 2-3b (C8): Act II shows only work a human has to do, in the same
  // relative priority order; items Trackpr is still handling are set aside
  // (summarized in Act I) and never counted. Act III is unchanged.
  const attentionQueue = queue.filter((item) => item.act === "attention");
  const attention = attentionQueue.filter((item) => item.actor === "human");
  const trackprHandling = attentionQueue.filter((item) => item.actor === "trackpr");
  const opportunities = queue.filter((item) => item.act === "opportunity");

  return { exceptions, attention, opportunities, trackprHandling, totalNeedingAttention: exceptions.length + attention.length };
}

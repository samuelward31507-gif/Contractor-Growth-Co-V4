import type { AttentionItem } from "@/lib/dashboard/queries";
import type { Opportunity } from "@/lib/opportunities/queries";
import type { NextStep } from "@/lib/people/next-step";
import { resolveOpportunityActor, resolveSignalActor, type DecisionActor, type DecisionContext } from "./actor";
import type { DecisionItem } from "./types";
import { OWNER_LABEL, type ActorOwner } from "./owner";

/**
 * Batch 3 (core daily loop): how WHO ACTS reads on Today, People, Person,
 * Inbox and Schedule - presentation only, over the one actor model.
 *
 * Nothing here decides anything new. Every "Trackpr" answer comes from
 * lib/decisions/actor.ts's own rules, called unchanged:
 *   - a waiting conversation      -> resolveSignalActor (AI eligible + 15-minute grace)
 *   - a sent, pending estimate    -> resolveOpportunityActor (follow-up window, reachability)
 * and everything else is the contractor - the same answer Today's
 * assembler gives. The next step itself (label, link, urgency) is still
 * lib/people/next-step.ts's; this only says whose move it is and words it
 * so two surfaces can never contradict each other.
 *
 *   you       the contractor has to do something
 *   trackpr   Trackpr is doing it - no action needed
 *   customer  the move is the customer's (an estimate out for a decision)
 */
export { OWNER_LABEL, trackprHandlingSentence, type ActorOwner } from "./owner";

/** A Today decision row's owner - the assembler's own actor, never recomputed. */
export function ownerForDecision(item: Pick<DecisionItem, "actor">): ActorOwner {
  return item.actor === "trackpr" ? "trackpr" : "you";
}

// ---------------------------------------------------------------------------
// Context for surfaces other than Today
// ---------------------------------------------------------------------------

/**
 * getDecisionContext reads its waiting conversations from Today's attention
 * items. Off Today, the same read is fed the canonical waiting ids
 * (lib/conversations/waiting.ts) as awaiting_reply items - at most the cap
 * the dashboard SQL itself returns, so a surface with WAITING_REPLY_CAP or
 * more waiting conversations treats every one of them as the contractor's,
 * exactly as Today does.
 */
export function waitingIdsAsAttentionItems(waitingIds: Iterable<string>, cap: number): AttentionItem[] {
  return [...waitingIds].slice(0, cap).map((conversationId) => ({ id: `waiting:${conversationId}`, kind: "awaiting_reply", conversationId }) as AttentionItem);
}

// ---------------------------------------------------------------------------
// A person's next step
// ---------------------------------------------------------------------------

export type NextStepView = {
  owner: ActorOwner;
  ownerLabel: string;
  /** The one sentence a surface shows - starts with what happens, never with an internal label. */
  headline: string;
  detail?: string;
  href: string;
  /** The contractor has to act and it is time-sensitive (the step's own `attention`). Never true when someone else owns it. */
  needsYou: boolean;
};

type EstimateRow = { id: string; status: string; sent_at: string | null; title?: string };

export type PersonActorInput = {
  contactId: string;
  contactPhone: string | null;
  contactSmsOptOut: boolean | null;
  /** The person's open conversations waiting on the business - the same set findPersonNextStep reads. */
  conversations: { id: string; status: string }[];
  waitingConversationIds: ReadonlySet<string>;
  estimates: EstimateRow[];
  /** The organization's open opportunities (or just this person's) - a pending_estimate one decides the estimate's actor exactly as on Today. */
  openOpportunities?: Pick<Opportunity, "type" | "contactId" | "metadata" | "sourceEntityId">[];
  context: DecisionContext;
};

const ESTIMATE_STAGES = new Set(["estimate_sent", "estimate_follow_up"]);

/** The waiting conversation findPersonNextStep itself would pick (first open one in the waiting set). */
function waitingConversationFor(input: Pick<PersonActorInput, "conversations" | "waitingConversationIds">): { id: string } | null {
  return input.conversations.find((conversation) => conversation.status === "open" && input.waitingConversationIds.has(conversation.id)) ?? null;
}

/** Trackpr is still following up on this person's sent estimate - resolveOpportunityActor, given the opportunity Today would use. */
export function estimateActor(input: PersonActorInput, estimateId: string | null): DecisionActor {
  const estimate = input.estimates.find((row) => row.id === estimateId) ?? null;
  const persisted = (input.openOpportunities ?? []).find(
    (opportunity) => opportunity.type === "pending_estimate" && opportunity.contactId === input.contactId && (estimateId === null || opportunity.sourceEntityId === estimateId),
  );
  const opportunity = (persisted ?? { type: "pending_estimate", contactId: input.contactId, sourceEntityId: estimateId ?? "", metadata: { sent_at: estimate?.sent_at ?? null } }) as Opportunity;
  return resolveOpportunityActor({ opportunity, contactPhone: input.contactPhone, contactSmsOptOut: input.contactSmsOptOut }, input.context);
}

/**
 * One person's next step, with its owner. `step` and `lifecycle` are
 * exactly what findPersonNextStep / derivePersonLifecycle returned for the
 * same rows - this never re-derives the stage or the action.
 */
/**
 * The lifecycle fields read here, typed structurally - this module only
 * reads the stage name and its deciding entity; it never imports the
 * canonical lifecycle model (lib/lifecycle stays wired only through
 * lib/people/next-step.ts).
 */
export type LifecycleView = { stage: string; primary?: { type: string; id: string } | null };

export function presentNextStep(step: NextStep | null, lifecycle: LifecycleView, input: PersonActorInput): NextStepView | null {
  if (!step) return null;
  const view = (owner: ActorOwner, headline: string, needsYou: boolean, detail = step.detail): NextStepView => ({ owner, ownerLabel: OWNER_LABEL[owner], headline, detail, href: step.href, needsYou });

  // A reply owed right now ranks above the lifecycle - in findPersonNextStep and here.
  const waiting = waitingConversationFor(input);
  if (waiting && step.href === `/conversations/${waiting.id}`) {
    const actor = resolveSignalActor({ kind: "awaiting_reply", conversationId: waiting.id }, input.context);
    return actor === "trackpr"
      ? view("trackpr", "Trackpr is replying to the customer", false, "The customer just texted - Trackpr is answering.")
      : view("you", "Reply to the customer", step.attention, "A customer message is waiting for a reply.");
  }

  if (ESTIMATE_STAGES.has(lifecycle.stage) && lifecycle.primary?.type === "estimate") {
    if (estimateActor(input, lifecycle.primary.id) === "trackpr") return view("trackpr", "Trackpr is following up on the estimate", false);
    if (lifecycle.stage === "estimate_sent") return view("customer", "Waiting on the customer's decision", false);
    return view("you", "Follow up on the estimate", step.attention);
  }

  return view("you", step.label, step.attention);
}

/** "You · Reply to the customer" - the compact form a list row shows. */
export function nextStepLine(view: Pick<NextStepView, "ownerLabel" | "headline">): string {
  return `${view.ownerLabel} · ${view.headline}`;
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

export type ConversationOwnerView = {
  owner: ActorOwner | null;
  /** "Needs your reply", "Trackpr is replying", ... */
  label: string;
  /** The contractor is expected to reply - the Inbox's "Needs you" view. */
  needsYou: boolean;
};

/**
 * Who a conversation is with right now. Waiting conversations use the
 * actor model (resolveSignalActor); an answered open conversation is with
 * Trackpr only when Trackpr could answer the customer's next message
 * (the conversation's AI is on and the organization's AI reply is live),
 * otherwise with the contractor. Closed conversations belong to nobody.
 */
export function presentConversationOwner(
  conversation: { id: string; status: string; ai_enabled: boolean },
  waitingConversationIds: ReadonlySet<string>,
  context: DecisionContext,
): ConversationOwnerView {
  if (conversation.status !== "open") return { owner: null, label: "Closed", needsYou: false };
  if (waitingConversationIds.has(conversation.id)) {
    return resolveSignalActor({ kind: "awaiting_reply", conversationId: conversation.id }, context) === "trackpr"
      ? { owner: "trackpr", label: "Trackpr is replying", needsYou: false }
      : { owner: "you", label: "Needs your reply", needsYou: true };
  }
  const trackprAnswers = conversation.ai_enabled && context.organizationEligible && context.aiSettingsEnabled && context.inboundReplyEnabled;
  return trackprAnswers ? { owner: "trackpr", label: "Trackpr is handling this", needsYou: false } : { owner: "you", label: "You're handling this", needsYou: false };
}

import type { DecisionItem } from "./types";

/**
 * Batch 3 (core daily loop): whose move it is, as a surface shows it - kept
 * dependency-free so client components (OwnerChip, the Inbox list) can use
 * it without pulling the server-side actor model into the browser bundle.
 * lib/decisions/presentation.ts decides the owner; this only names it.
 *
 *   you       the contractor has to do something
 *   trackpr   Trackpr is doing it - no action needed
 *   customer  the move is the customer's (an estimate out for a decision)
 */
export type ActorOwner = "you" | "trackpr" | "customer";

export const OWNER_LABEL: Record<ActorOwner, string> = {
  you: "You",
  trackpr: "Trackpr",
  customer: "Customer",
};

/**
 * What Trackpr is doing for a decision item it owns, as an outcome a
 * contractor recognizes - never the machinery ("workflow", "automation").
 * Only the two reason codes the actor model can hand to Trackpr have their
 * own wording; anything else falls back to the item's own problem label.
 */
export function trackprHandlingSentence(item: Pick<DecisionItem, "reasonCode" | "subject" | "problemLabel">): string {
  const name = item.subject.name;
  if (item.reasonCode === "customer_awaiting_reply") return `Replying to ${name}`;
  if (item.reasonCode === "estimate_awaiting_decision") return `Following up on ${name}'s estimate`;
  return `${item.problemLabel} · ${name}`;
}

/**
 * P0 A4: the Follow-Up Engine's state machine - pure, so every transition is
 * testable on its own. Every write the engine makes to public.followups goes
 * through a transition checked against this table AND made conditional on
 * the row still being in the `from` state, so two writers can never both
 * move the same follow-up.
 *
 *   pending    created by a producer, not yet scheduled
 *   scheduled  the next touch is due at next_action_at
 *   processing claimed by one dispatcher until lease_until
 *   paused     not dispatched (dormant: the touch went stale; automation
 *              paused); reactivation reschedules it
 *   failed     the touch's send failed; A2 retries the execution
 *   completed  terminal - the customer replied or the cadence finished
 *   exited     terminal - the follow-up no longer applies (lead closed,
 *              superseded, active engagement, opted out ...)
 */
export const FOLLOWUP_STATES = ["pending", "scheduled", "processing", "paused", "completed", "exited", "failed"] as const;
export type FollowupState = (typeof FOLLOWUP_STATES)[number];

/** Who or what the follow-up is waiting on. */
export const FOLLOWUP_WAITING_ON = ["customer", "business", "appointment", "estimate", "payment", "human", "none"] as const;
export type FollowupWaitingOn = (typeof FOLLOWUP_WAITING_ON)[number];

/** What Trackpr will do next. */
export const FOLLOWUP_NEXT_ACTIONS = ["send_followup", "retry", "human_review", "none"] as const;
export type FollowupNextAction = (typeof FOLLOWUP_NEXT_ACTIONS)[number];

export const FOLLOWUP_TRANSITIONS: Readonly<Record<FollowupState, readonly FollowupState[]>> = {
  pending: ["scheduled", "exited"],
  scheduled: ["processing", "paused", "exited", "completed"],
  processing: ["scheduled", "completed", "exited", "failed", "paused"],
  paused: ["scheduled", "exited", "completed"],
  failed: ["scheduled", "completed", "exited"],
  completed: [],
  exited: [],
};

export function canTransition(from: FollowupState, to: FollowupState): boolean {
  return FOLLOWUP_TRANSITIONS[from].includes(to);
}

export function isTerminal(state: FollowupState): boolean {
  return FOLLOWUP_TRANSITIONS[state].length === 0;
}

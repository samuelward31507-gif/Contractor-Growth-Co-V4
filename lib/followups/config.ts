/**
 * P0 A4: the ONE configuration source for the Follow-Up Engine's cadence.
 * Each stage lists the hours after the follow-up's anchor (when it was
 * created - i.e. when the lead arrived) at which touch 1, 2, 3... are due.
 * Changing a cadence is a one-line edit here; nothing else hard-codes it.
 */
export const FOLLOWUP_STAGES = ["lead_no_reply"] as const;
export type FollowupStage = (typeof FOLLOWUP_STAGES)[number];

export const FOLLOWUP_CADENCE_HOURS: Readonly<Record<FollowupStage, readonly number[]>> = {
  // 24 hours, 72 hours, 7 days.
  lead_no_reply: [24, 72, 168],
};

/** How long a claimed follow-up is protected from a second dispatcher before it may be reclaimed (crash recovery). */
export const FOLLOWUP_LEASE_MINUTES = 10;

/** At most this many follow-ups are dispatched per tick. */
export const FOLLOWUP_DISPATCH_BATCH = 25;

const HOUR_MS = 60 * 60 * 1000;

/** How many touches the stage has. */
export function touchCount(stage: FollowupStage): number {
  return FOLLOWUP_CADENCE_HOURS[stage].length;
}

/** When touch `touch` (1-based) is due, or null past the end of the cadence. */
export function touchDueAt(anchor: Date, stage: FollowupStage, touch: number): Date | null {
  const hours = FOLLOWUP_CADENCE_HOURS[stage][touch - 1];
  return hours === undefined ? null : new Date(anchor.getTime() + hours * HOUR_MS);
}

import type { DispatchOutcome } from "./engine";
import type { FollowupState } from "./state";

/** P0 A4: plain-language labels for the TEST-only follow-up panel. */
export const FOLLOWUP_STATE_LABELS: Record<FollowupState, string> = {
  pending: "Pending",
  scheduled: "Scheduled",
  processing: "Processing",
  paused: "Paused",
  completed: "Completed",
  exited: "Stopped",
  failed: "Failed - retrying",
};

export function describeDispatchOutcome(outcome: DispatchOutcome): string {
  switch (outcome.outcome) {
    case "not_claimed":
      return "Nothing to run - the follow-up is not scheduled (or another run holds it).";
    case "skipped_disabled":
      return "Held - the automation is off or automations are paused. Nothing was used up.";
    case "deferred":
      return `Outside business hours - deferred to ${outcome.until}. Nothing was used up.`;
    case "paused":
      return `Paused (${outcome.reason}).`;
    case "completed":
      return `Completed (${outcome.reason}).`;
    case "exited":
      return `Stopped (${outcome.reason}).`;
    case "sent":
      return `Touch ${outcome.touch} sent.`;
    case "blocked":
      return `Touch ${outcome.touch} recorded as blocked (${outcome.reason}) - nothing was sent.`;
    case "failed":
      return `Touch ${outcome.touch} failed (${outcome.error}) - it will be retried automatically.`;
    case "error":
      return `Error: ${outcome.error}`;
  }
}

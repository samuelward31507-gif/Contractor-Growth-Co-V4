import { FOLLOWUP_AUTOMATION_ID } from "./store";
import type { FollowupStage } from "./config";

/**
 * P0-B B2.1: the obligation-kind registry - DESCRIPTORS. A follow-up row is
 * an obligation; its `stage` names its kind. A descriptor is the light,
 * import-anywhere half of a kind (identity, automation, event, workflow,
 * subject, touch-key format); the runtime half (live re-check, message,
 * gate options, terminal gate reasons) is the kind's handler in engine.ts.
 * Cadence stays in config.ts - still its single source.
 *
 * Exactly one kind exists: lead_no_reply (A4). B2.1 changes no A4 value:
 * the event type, workflow name and touch key below are A4's, byte for byte.
 */

export const FOLLOWUP_EVENT_TYPE = "followup.touch";
export const FOLLOWUP_WORKFLOW = "lead_followup_touch";

export type ObligationKindDescriptor = {
  stage: FollowupStage;
  /** The catalog automation (lib/automation/catalog.ts) that owns this kind - enabled/paused and A2 retry policy hang off it. */
  automationId: string;
  /** automation_events.event_type of each touch. */
  eventType: string;
  /** workflow_executions.workflow_name of each touch (A2 retry routes on it). */
  workflowName: string;
  /** What the obligation is about. B2.1's schema only carries lead_id, so every kind is lead-subject until B2.3. */
  subjectType: "lead";
  /** The touch's idempotency key - the event-level fence against a second attempt of the same touch. */
  touchKey: (obligationId: string, touch: number) => string;
};

export const LEAD_NO_REPLY: ObligationKindDescriptor = {
  stage: "lead_no_reply",
  automationId: FOLLOWUP_AUTOMATION_ID,
  eventType: FOLLOWUP_EVENT_TYPE,
  workflowName: FOLLOWUP_WORKFLOW,
  subjectType: "lead",
  touchKey: (obligationId, touch) => `${FOLLOWUP_EVENT_TYPE}:${obligationId}:${touch}`,
};

export const OBLIGATION_KIND_DESCRIPTORS: Readonly<Record<FollowupStage, ObligationKindDescriptor>> = {
  lead_no_reply: LEAD_NO_REPLY,
};

/** The registered kind for a stage - by exact key only; anything unregistered is null (never a default). */
export function getObligationKindDescriptor(stage: string): ObligationKindDescriptor | null {
  return Object.prototype.hasOwnProperty.call(OBLIGATION_KIND_DESCRIPTORS, stage) ? OBLIGATION_KIND_DESCRIPTORS[stage as FollowupStage] : null;
}

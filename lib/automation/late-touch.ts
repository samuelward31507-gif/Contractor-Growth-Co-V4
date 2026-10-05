import type { SupabaseClient } from "@supabase/supabase-js";
import { createAutomationEventAsService } from "./events";
import { startWorkflowExecutionAsService, completeWorkflowExecutionAsService } from "./executions";
import type { LifecycleBlockReason } from "./lifecycle-eligibility";

/**
 * Phase 3 (W2, K5 rule): a scheduled customer touch that is more than this
 * many hours past its due time is recorded as overdue and never sent. Paging
 * through every candidate (instead of a capped, arbitrary 500 / 1,000 rows)
 * must never turn into a historical SMS blast: a touch the old cap skipped,
 * or one that comes due while the automation was off, is recorded once and
 * left alone. The same window as estimate follow-up's
 * STALE_FOLLOWUP_GRACE_HOURS.
 */
export const LATE_TOUCH_GRACE_HOURS = 48;

const HOUR_MS = 60 * 60 * 1000;

/** Hours a touch is past its due time: (now - anchor) - delay. Negative when not yet due. */
export function hoursPastDue(nowMs: number, anchorMs: number, dueAfterMs: number): number {
  return (nowMs - anchorMs - dueAfterMs) / HOUR_MS;
}

export function isTouchOverdue(lateHours: number): boolean {
  return lateHours > LATE_TOUCH_GRACE_HOURS;
}

export type OverdueTouchResult = { outcome: "blocked"; reason: "followup_overdue" } | { outcome: "skipped_duplicate" } | { outcome: "skipped_disabled" } | { outcome: "failed"; error: string };

/**
 * Claims the touch's own idempotency key (the same key a real send would use)
 * and records the execution as not sent - blocked_reason "followup_overdue",
 * exactly like estimate follow-up's K5 skip - so every later run finds the
 * duplicate and the touch is never sent. No conversation lookup or creation,
 * no AI dispatch, no outbound gate, no message.
 */
export async function recordOverdueTouch(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    eventType: string;
    entityType: string;
    entityId: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
    workflowName: string;
    lateHours: number;
  },
): Promise<OverdueTouchResult> {
  const eventResult = await createAutomationEventAsService(supabase, input.organizationId, {
    eventType: input.eventType,
    entityType: input.entityType,
    entityId: input.entityId,
    payload: input.payload,
    idempotencyKey: input.idempotencyKey,
  });
  if (!eventResult.ok) return { outcome: "failed", error: eventResult.error };
  if (eventResult.duplicate) return { outcome: "skipped_duplicate" };
  if (eventResult.skipped) return { outcome: "skipped_disabled" };

  const executionResult = await startWorkflowExecutionAsService(supabase, eventResult.event.id, input.workflowName);
  if (!executionResult.ok) return { outcome: "failed", error: executionResult.error };
  await completeWorkflowExecutionAsService(supabase, executionResult.execution.id, {
    should_send: false,
    blocked_reason: "followup_overdue",
    blocked_detail: `${Math.floor(input.lateHours)} hours past due`,
    ...input.payload,
  });
  return { outcome: "blocked", reason: "followup_overdue" };
}

/** Phase 3 (W2): an automation's enabled state, read once per organization per run (K5-5's R-b pattern). */
export function enabledPerOrganization(read: (organizationId: string) => Promise<boolean>): (organizationId: string) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>();
  return (organizationId) => {
    let enabled = cache.get(organizationId);
    if (!enabled) {
      enabled = read(organizationId);
      cache.set(organizationId, enabled);
    }
    return enabled;
  };
}

/**
 * Records a lifecycle-blocked touch (P0 A3) the same way recordOverdueTouch
 * above records an overdue one: the touch's own event (same
 * idempotency key, so a later tick never re-evaluates or re-sends that
 * touch) and a completed execution carrying should_send false and the
 * blocked_reason. Nothing is sent, nothing escalates.
 */
export async function recordLifecycleBlockedTouch(
  supabase: SupabaseClient,
  input: { organizationId: string; eventType: string; entityId: string; payload: Record<string, unknown>; idempotencyKey: string; workflowName: string; reason: LifecycleBlockReason; detail: string },
): Promise<{ outcome: "blocked"; reason: LifecycleBlockReason } | { outcome: "skipped_duplicate" } | { outcome: "skipped_disabled" } | { outcome: "failed"; error: string }> {
  const eventResult = await createAutomationEventAsService(supabase, input.organizationId, {
    eventType: input.eventType,
    entityType: "lead",
    entityId: input.entityId,
    payload: input.payload,
    idempotencyKey: input.idempotencyKey,
  });
  if (!eventResult.ok) return { outcome: "failed", error: eventResult.error };
  if (eventResult.duplicate) return { outcome: "skipped_duplicate" };
  if (eventResult.skipped) return { outcome: "skipped_disabled" };

  const executionResult = await startWorkflowExecutionAsService(supabase, eventResult.event.id, input.workflowName);
  if (!executionResult.ok) return { outcome: "failed", error: executionResult.error };
  await completeWorkflowExecutionAsService(supabase, executionResult.execution.id, {
    should_send: false,
    blocked_reason: input.reason,
    blocked_detail: input.detail,
    ...input.payload,
  });
  return { outcome: "blocked", reason: input.reason };
}

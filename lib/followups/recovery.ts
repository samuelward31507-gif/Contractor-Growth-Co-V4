import type { SupabaseClient } from "@supabase/supabase-js";
import { touchCount, touchDueAt } from "./config";
import { FOLLOWUP_COLUMNS, transitionFollowup, type FollowupRow } from "./store";

/**
 * Audit: a person's way out of a follow-up stuck in `failed` waiting for
 * review (a touch whose execution could not start, or whose A2 retries
 * stopped). Two honest choices - neither re-sends the failed message:
 *
 *   stop  the follow-up ends (exited, exit_reason stopped_by_person).
 *   skip  the failed touch is given up (counted, never sent) and the
 *         sequence continues with the next touch on its normal cadence -
 *         or completes if it was the last. The failed touch's event already
 *         exists, so "re-send it" is deliberately not offered.
 *
 * Idempotent: the transition is conditional on the row still being
 * `failed`, so a double click or a concurrent resolution changes nothing the
 * second time. Every resolution is written to audit_log with the person.
 * The caller (a server action) must have verified the person is an admin of
 * `organizationId`; obligation writes use the service-role client.
 */
export type FailedFollowupResolution = "stop" | "skip";
export const FOLLOWUP_RESOLVED_AUDIT_ACTION = "followup_failed_resolved";

/**
 * A `failed` follow-up is only a person's decision once Trackpr has stopped
 * retrying it. A failed touch (next_action 'retry') is still owned by A2
 * (lib/automation/execution-retry.ts) while any attempt for its event is
 * running, or failed and not yet decided (retry_state null) or scheduled.
 * Offering Stop/Skip then would race that retry: the "skipped" message could
 * still be sent, and the next touch scheduled on top of it.
 */
export type FailedFollowupReviewStatus = "needs_review" | "retrying";
type ExecutionRef = { id: string; automation_event_id: string | null; status: string; retry_state?: string | null };
type FailedFollowupRef = { id: string; next_action?: string | null; last_execution_id?: string | null };

/** Pure: is an automatic retry still pending among one event's attempts? */
export function automaticRetryPending(executions: Pick<ExecutionRef, "status" | "retry_state">[]): boolean {
  return executions.some((e) => e.status === "running" || (e.status === "failed" && (e.retry_state == null || e.retry_state === "scheduled")));
}

/**
 * The review status of each failed follow-up (keyed by follow-up id), or null
 * when the executions could not be read - callers fail closed (no Stop/Skip).
 * Works with the service-role client or an org member's session (RLS:
 * workflow_executions_select).
 */
export async function loadFailedFollowupReviewStatus(
  client: SupabaseClient,
  organizationId: string,
  rows: FailedFollowupRef[],
): Promise<Map<string, FailedFollowupReviewStatus> | null> {
  const statuses = new Map<string, FailedFollowupReviewStatus>(rows.map((row) => [row.id, "needs_review"]));
  // A touch that could not even start (human_review) or has no execution has nothing retrying it.
  const retryable = rows.filter((row) => row.next_action !== "human_review" && row.last_execution_id);
  if (retryable.length === 0) return statuses;

  const lastIds = [...new Set(retryable.map((row) => row.last_execution_id as string))];
  const { data: last, error: lastError } = await client.from("workflow_executions").select("id, automation_event_id, status, retry_state").eq("organization_id", organizationId).in("id", lastIds);
  if (lastError) return null;
  const lastById = new Map(((last ?? []) as ExecutionRef[]).map((e) => [e.id, e]));
  const eventIds = [...new Set([...lastById.values()].map((e) => e.automation_event_id).filter((id): id is string => !!id))];
  const byEvent = new Map<string, ExecutionRef[]>();
  if (eventIds.length > 0) {
    const { data: attempts, error: attemptsError } = await client.from("workflow_executions").select("id, automation_event_id, status, retry_state").eq("organization_id", organizationId).in("automation_event_id", eventIds);
    if (attemptsError) return null;
    for (const e of (attempts ?? []) as ExecutionRef[]) {
      const list = byEvent.get(e.automation_event_id as string) ?? [];
      list.push(e);
      byEvent.set(e.automation_event_id as string, list);
    }
  }
  for (const row of retryable) {
    const execution = lastById.get(row.last_execution_id as string);
    if (!execution) continue;
    const attempts = execution.automation_event_id ? (byEvent.get(execution.automation_event_id) ?? [execution]) : [execution];
    if (automaticRetryPending(attempts)) statuses.set(row.id, "retrying");
  }
  return statuses;
}

export type ResolveFailedFollowupResult =
  | { ok: true; outcome: "stopped" | "continued" | "completed"; nextActionAt: string | null }
  | { ok: false; error: string };

export async function resolveFailedFollowup(
  service: SupabaseClient,
  input: { organizationId: string; followupId: string; resolution: FailedFollowupResolution; actorUserId: string; now?: Date },
): Promise<ResolveFailedFollowupResult> {
  if (input.resolution !== "stop" && input.resolution !== "skip") return { ok: false, error: "Choose how to resolve this follow-up." };
  const now = input.now ?? new Date();
  const { data, error } = await service.from("followups").select(FOLLOWUP_COLUMNS).eq("id", input.followupId).eq("organization_id", input.organizationId).maybeSingle();
  if (error) return { ok: false, error: "This follow-up could not be loaded. Try again." };
  const row = data as FollowupRow | null;
  if (!row) return { ok: false, error: "This follow-up could not be found." };
  if (row.state !== "failed") return { ok: false, error: "This follow-up is no longer waiting for review." };
  const review = await loadFailedFollowupReviewStatus(service, input.organizationId, [row]);
  if (!review) return { ok: false, error: "Could not check whether Trackpr is still retrying this message. Try again." };
  if (review.get(row.id) === "retrying") return { ok: false, error: "Trackpr is still retrying this message automatically. Check back after it finishes." };

  let next: FollowupRow | null;
  let outcome: "stopped" | "continued" | "completed";
  const skippedTouch = row.attempt_count + 1;
  if (input.resolution === "stop") {
    next = await transitionFollowup(service, row, "exited", { exit_reason: "stopped_by_person", waiting_on: "none", next_action: "none", next_action_at: null });
    outcome = "stopped";
  } else if (skippedTouch >= touchCount(row.stage)) {
    next = await transitionFollowup(service, row, "completed", { attempt_count: skippedTouch, exit_reason: "cadence_complete", waiting_on: "none", next_action: "none", next_action_at: null });
    outcome = "completed";
  } else {
    const anchor = new Date(row.reactivated_at ?? row.created_at);
    const due = touchDueAt(anchor, row.stage, skippedTouch + 1)!;
    next = await transitionFollowup(service, row, "scheduled", {
      attempt_count: skippedTouch,
      next_action_at: new Date(Math.max(due.getTime(), now.getTime())).toISOString(),
      waiting_on: "customer",
      next_action: "send_followup",
    });
    outcome = "continued";
  }
  if (!next) return { ok: false, error: "This follow-up is no longer waiting for review." };

  const { error: auditError } = await service.from("audit_log").insert({
    organization_id: input.organizationId,
    user_id: input.actorUserId,
    action: FOLLOWUP_RESOLVED_AUDIT_ACTION,
    entity_type: "followup",
    entity_id: row.id,
    metadata: { resolution: input.resolution, outcome, lead_id: row.lead_id, stage: row.stage, skipped_touch: input.resolution === "skip" ? skippedTouch : null },
  });
  if (auditError) console.error("[followups] failed to audit a resolution", { followupId: row.id, error: auditError.message });
  return { ok: true, outcome, nextActionAt: next.next_action_at ?? null };
}

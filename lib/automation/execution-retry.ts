import type { SupabaseClient } from "@supabase/supabase-js";
import { AUTOMATIC_RETRY_POLICY, retryDelayMinutes } from "./retry-eligibility";
import { MAX_WORKFLOW_RETRY_ATTEMPTS, type WorkflowRetryState } from "./executions";
import { retryWorkflowExecutionAsService } from "./retry";

/**
 * P0 A2: the one place Trackpr decides what happens to a FAILED execution,
 * run by the existing service-role health tick (app/api/automation/health,
 * every 15 minutes in Production via pg_cron) - no new queue or scheduler.
 *
 * 1. classifyFailedExecutions: every failed execution with no decision yet
 *    gets exactly one durable decision (workflow_executions.retry_state):
 *      - retried        a newer attempt for the same event already exists
 *      - not_retryable  the workflow is not in AUTOMATIC_RETRY_POLICY
 *                       (permanent - needs a person)
 *      - exhausted      the attempt reached the policy ceiling
 *                       (permanent - needs a person)
 *      - scheduled      next_retry_at = failure time + bounded backoff
 *    The write is conditional on retry_state still being null, so a
 *    repeated or concurrent tick never decides twice.
 *
 * 2. processDueRetries: every 'scheduled' execution whose next_retry_at has
 *    passed is leased (next_retry_at pushed forward, conditional on the
 *    value just read - only one tick can win) and retried through the SAME
 *    path a staff retry uses (retryWorkflowExecutionAsService: eligibility
 *    gate, start_workflow_execution with trigger_source 'retry', the
 *    workflow's own dispatcher and therefore the outbound gate). Nothing is
 *    sent because a retry was scheduled; a send only ever happens inside the
 *    retried dispatch, after the gate allows it. start_workflow_execution
 *    itself refuses an event that is already processing or completed, so a
 *    second concurrent retry of the same event cannot start.
 *
 * A failure of the new attempt is a new failed execution, classified on the
 * next tick with its own (higher) attempt number - attempts can only grow,
 * and every execution ends in a terminal decision.
 */

const MAX_CLASSIFY_PER_RUN = 100;
const MAX_RETRIES_PER_RUN = 25;
/** How long a leased retry is protected from a second tick before it may be picked up again (crash recovery). */
export const RETRY_LEASE_MINUTES = 10;

export type FailedExecutionRow = {
  id: string;
  organization_id: string;
  automation_event_id: string | null;
  workflow_name: string;
  attempt: number;
  completed_at: string | null;
  started_at: string;
};

export type RetryDecision =
  | { retryState: "scheduled"; nextRetryAt: string; maxAttempts: number; detail: string }
  | { retryState: "exhausted"; nextRetryAt: null; maxAttempts: number; detail: string }
  | { retryState: "not_retryable"; nextRetryAt: null; maxAttempts: null; detail: string };

/** Pure: the decision for one failed execution that is the latest attempt for its event. */
export function decideRetry(execution: Pick<FailedExecutionRow, "workflow_name" | "attempt" | "completed_at" | "started_at" | "automation_event_id">, now: Date): RetryDecision {
  const policy = AUTOMATIC_RETRY_POLICY[execution.workflow_name];
  if (!policy) return { retryState: "not_retryable", nextRetryAt: null, maxAttempts: null, detail: "not_safely_retryable" };
  if (!execution.automation_event_id) return { retryState: "not_retryable", nextRetryAt: null, maxAttempts: null, detail: "missing_parent_event" };
  const maxAttempts = Math.min(policy.maxAttempts, MAX_WORKFLOW_RETRY_ATTEMPTS);
  if (execution.attempt >= maxAttempts) {
    return { retryState: "exhausted", nextRetryAt: null, maxAttempts, detail: `retry_exhausted: stopped after ${execution.attempt} attempt(s)` };
  }
  const failedAt = new Date(execution.completed_at ?? execution.started_at).getTime();
  const due = Math.max(failedAt + retryDelayMinutes(execution.attempt) * 60_000, now.getTime());
  return { retryState: "scheduled", nextRetryAt: new Date(due).toISOString(), maxAttempts, detail: `retry ${execution.attempt + 1} of ${maxAttempts} scheduled` };
}

export type ClassifyResult = { decided: { id: string; retryState: WorkflowRetryState }[]; errors: number };

export async function classifyFailedExecutions(service: SupabaseClient, now: Date = new Date()): Promise<ClassifyResult> {
  const result: ClassifyResult = { decided: [], errors: 0 };
  const { data, error } = await service
    .from("workflow_executions")
    .select("id, organization_id, automation_event_id, workflow_name, attempt, completed_at, started_at")
    .eq("status", "failed")
    .is("retry_state", null)
    .order("completed_at", { ascending: true })
    .limit(MAX_CLASSIFY_PER_RUN);
  if (error) {
    // A database without the A2 migration has no retry_state column - this
    // tick then does nothing rather than failing the health check.
    console.error("[automation] failed-execution classification scan failed", { error: error.message });
    return { ...result, errors: 1 };
  }

  for (const row of (data ?? []) as FailedExecutionRow[]) {
    const newer = row.automation_event_id
      ? await service
          .from("workflow_executions")
          .select("id")
          .eq("automation_event_id", row.automation_event_id)
          .gt("attempt", row.attempt)
          .limit(1)
          .maybeSingle()
      : { data: null };
    const decision: RetryDecision | { retryState: "retried"; nextRetryAt: null; maxAttempts: null; detail: string } = newer.data ? { retryState: "retried", nextRetryAt: null, maxAttempts: null, detail: "superseded_by_newer_attempt" } : decideRetry(row, now);

    const { data: written, error: writeError } = await service
      .from("workflow_executions")
      .update({ retry_state: decision.retryState, next_retry_at: decision.nextRetryAt, max_attempts: decision.maxAttempts, retry_detail: decision.detail })
      .eq("id", row.id)
      .eq("status", "failed")
      .is("retry_state", null)
      .select("id");
    if (writeError) {
      result.errors += 1;
      console.error("[automation] failed to record retry decision", { executionId: row.id, error: writeError.message });
      continue;
    }
    if ((written ?? []).length > 0) result.decided.push({ id: row.id, retryState: decision.retryState });
  }
  return result;
}

export type DueRetryResult = { started: { id: string; newExecutionId: string }[]; stopped: { id: string; reason: string }[]; errors: number };

export async function processDueRetries(service: SupabaseClient, now: Date = new Date()): Promise<DueRetryResult> {
  const result: DueRetryResult = { started: [], stopped: [], errors: 0 };
  const nowIso = now.toISOString();
  const { data, error } = await service
    .from("workflow_executions")
    .select("id, organization_id, next_retry_at")
    .eq("retry_state", "scheduled")
    .lte("next_retry_at", nowIso)
    .order("next_retry_at", { ascending: true })
    .limit(MAX_RETRIES_PER_RUN);
  if (error) {
    console.error("[automation] due-retry scan failed", { error: error.message });
    return { ...result, errors: 1 };
  }

  for (const row of (data ?? []) as { id: string; organization_id: string; next_retry_at: string }[]) {
    // Lease: only the tick whose conditional update wins may retry.
    const lease = new Date(now.getTime() + RETRY_LEASE_MINUTES * 60_000).toISOString();
    const { data: leased } = await service
      .from("workflow_executions")
      .update({ next_retry_at: lease })
      .eq("id", row.id)
      .eq("retry_state", "scheduled")
      .eq("next_retry_at", row.next_retry_at)
      .select("id");
    if (!leased || leased.length === 0) continue;

    const outcome = await retryWorkflowExecutionAsService(service, row.organization_id, row.id);
    if (outcome.ok) {
      await settle(service, row.id, "retried", outcome.dispatched ? `retried as ${outcome.newExecutionId}` : `retried as ${outcome.newExecutionId} (dispatch failed)`);
      result.started.push({ id: row.id, newExecutionId: outcome.newExecutionId });
      continue;
    }
    // The gate refused. A disabled automation or an unsafe workflow stops
    // here for good (needs a person); an event another attempt already took
    // over is simply superseded.
    const permanent = outcome.reason === "automation_disabled" || outcome.reason === "not_safely_retryable" || outcome.reason === "retry_ceiling_reached";
    await settle(service, row.id, permanent ? "not_retryable" : "retried", permanent ? String(outcome.reason) : `superseded: ${outcome.reason}`);
    result.stopped.push({ id: row.id, reason: String(outcome.reason) });
  }
  return result;
}

async function settle(service: SupabaseClient, executionId: string, retryState: WorkflowRetryState, detail: string): Promise<void> {
  const { error } = await service
    .from("workflow_executions")
    .update({ retry_state: retryState, retry_detail: detail.slice(0, 500) })
    .eq("id", executionId)
    .eq("retry_state", "scheduled");
  if (error) console.error("[automation] failed to settle retry", { executionId, error: error.message });
}

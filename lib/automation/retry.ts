import type { SupabaseClient } from "@supabase/supabase-js";
import { checkRetryEligibility, type RetryRejectionReason } from "./retry-eligibility";
import { startWorkflowExecution } from "./executions";
import { retryAppointmentReminder } from "./appointment-reminders";
import { retryEstimateWorkflow } from "./estimate-followups";
import { redispatchToN8n } from "./n8n-retry";

export type RetryOutcome =
  | { ok: true; dispatched: true; executionId: string; newExecutionId: string; automationId: string | null }
  | { ok: true; dispatched: false; executionId: string; newExecutionId: string; automationId: string | null; dispatchError: string }
  | { ok: false; reason: RetryRejectionReason | string; executionId: string; automationId: string | null };

/**
 * Retries a failed workflow execution: checkRetryEligibility (its own
 * module, see that file's comment - including SAFE_RETRY_AUTOMATION_IDS,
 * the actual n8n-safety boundary) is the sole gate, then the new attempt is
 * created via the exact same start_workflow_execution path every automation
 * already uses (trigger_source: "retry", never a second execution-creation
 * mechanism), and only once that row exists does redispatch happen - a
 * trackpr-composed resend for appointment-reminders/estimate-followups, or
 * the generic n8n redispatch (verified safe for exactly one workflow,
 * lead_created_followup - see n8n-retry.ts) for everything else eligibility
 * lets through. Nothing is ever sent before the new execution row exists.
 *
 * `ok: true` covers both `dispatched: true` (the handoff - the n8n webhook
 * call, or the trackpr gate+send/lifecycle path - was itself successfully
 * initiated) and `dispatched: false` (the execution row was created, but
 * the handoff failed and the new execution has already been marked
 * 'failed' by the redispatch function itself). This distinction exists
 * specifically so the caller can apply the correct audit semantics:
 * automation_retry_succeeded means the execution was created AND the
 * handoff was initiated successfully - never merely that a row exists, and
 * never "the underlying automation eventually completed".
 */
export async function retryWorkflowExecution(
  supabase: SupabaseClient,
  organizationId: string,
  executionId: string,
): Promise<RetryOutcome> {
  const eligibility = await checkRetryEligibility(supabase, organizationId, executionId);

  if (!eligibility.ok) {
    return { ok: false, reason: eligibility.reason, executionId, automationId: eligibility.automationId };
  }

  const { execution, event, automationId } = eligibility;

  const startResult = await startWorkflowExecution(
    supabase,
    execution.automationEventId,
    execution.workflowName,
    {},
    "retry",
  );

  if (!startResult.ok) {
    return { ok: false, reason: startResult.error, executionId, automationId };
  }

  const newExecution = startResult.execution;

  const dispatchResult =
    execution.workflowName === "appointment_reminder"
      ? await retryAppointmentReminder(supabase, event, newExecution.id)
      : execution.workflowName === "estimate_followup" || execution.workflowName === "estimate_expired_lifecycle"
        ? await retryEstimateWorkflow(supabase, event, newExecution.id, execution.workflowName)
        : await redispatchToN8n(supabase, event, newExecution);

  if (!dispatchResult.ok) {
    return {
      ok: true,
      dispatched: false,
      executionId,
      newExecutionId: newExecution.id,
      automationId,
      dispatchError: dispatchResult.error,
    };
  }

  return { ok: true, dispatched: true, executionId, newExecutionId: newExecution.id, automationId };
}

export type RetryAuditPlan =
  | { kind: "unattributable" }
  | { kind: "rejected"; automationId: string; reason: string }
  | { kind: "requested_only"; automationId: string }
  | { kind: "requested_and_succeeded"; automationId: string };

/**
 * Phase H: the pure audit decision behind retryExecution
 * (app/(app)/automations/actions.ts) - extracted so it can be unit tested
 * directly (that file is "use server", where every export must be an async
 * function). Encodes the exact three-action semantics already established:
 *
 * - "unattributable": no automationId was ever resolved - nothing to
 *   attribute an audit row to (create_automation_audit_event requires
 *   automation_id NOT NULL). No audit call at all.
 * - "rejected": the retry was rejected before a new execution was
 *   successfully created (result.ok === false) - audit
 *   automation_retry_rejected only, never automation_retry_requested for
 *   the same rejection.
 * - "requested_only": a new execution WAS created (result.ok === true) but
 *   the handoff failed (dispatched === false) - audit
 *   automation_retry_requested only; automation_retry_succeeded must never
 *   be written for a failed handoff.
 * - "requested_and_succeeded": the execution was created AND the handoff
 *   was itself successfully initiated - audit both
 *   automation_retry_requested and automation_retry_succeeded. This is
 *   never interpreted as "the underlying automation eventually completed".
 */
export function planRetryAudit(result: RetryOutcome): RetryAuditPlan {
  if (!result.ok) {
    return result.automationId ? { kind: "rejected", automationId: result.automationId, reason: result.reason } : { kind: "unattributable" };
  }

  if (!result.automationId) {
    return { kind: "unattributable" };
  }

  return result.dispatched
    ? { kind: "requested_and_succeeded", automationId: result.automationId }
    : { kind: "requested_only", automationId: result.automationId };
}

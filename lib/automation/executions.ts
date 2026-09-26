import type { SupabaseClient } from "@supabase/supabase-js";
import { getAutomationForWorkflowName } from "./catalog";
import { recordAutomationHealthSignal, resolveAutomationFailureIncidents } from "../automation-health/service";
import { automationFingerprintContext } from "../automation-health/fingerprint";

export type WorkflowExecutionStatus = "running" | "completed" | "failed" | "cancelled";

/**
 * The three failure causes failWorkflowExecution/failWorkflowExecutionAsService
 * callers can actually distinguish, from the real evidence in this codebase:
 * a dispatch to n8n itself failing (lib/automation/n8n.ts's triggerN8nWorkflow),
 * an outbound SMS send failing after the gate already passed
 * (lib/messaging/outbound.ts/lib/automation/sms.ts), or any other internal
 * failure (a missing entity reference, a data-integrity check) - the
 * generic default. This is NOT the same list as automation-health's full
 * IncidentCategory: workflow_stuck, n8n_callback_failed, and
 * sms_delivery_failed are all detected from different code paths that never
 * call failWorkflowExecution at all (see lib/automation-health/service.ts's
 * own module comment).
 */
export type WorkflowFailureCategory = "workflow_failed" | "n8n_dispatch_failed" | "sms_send_failed";
export type WorkflowExecutionTriggerSource = "event" | "manual" | "retry";

export type WorkflowExecution = {
  id: string;
  organization_id: string;
  automation_event_id: string | null;
  workflow_name: string;
  status: WorkflowExecutionStatus;
  attempt: number;
  started_at: string;
  completed_at: string | null;
  error_message: string | null;
  metadata: Record<string, unknown>;
  trigger_source: WorkflowExecutionTriggerSource;
};

/**
 * Retry ceiling for a single automation event's workflow executions. The
 * schema has no retry-limit column, and this phase intentionally doesn't add
 * a settings system for it - this constant is the sole source of truth until
 * a real per-organization or per-workflow policy is needed.
 */
export const MAX_WORKFLOW_RETRY_ATTEMPTS = 5;

type ExecutionResult =
  | { ok: true; execution: WorkflowExecution }
  | { ok: false; error: string };

async function requireUser(supabase: SupabaseClient) {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/**
 * Internal RPC error text (from `raise exception` in the migration) is
 * developer-authored and safe, but only a known allowlist is ever forwarded
 * verbatim - anything unexpected (including raw Postgres internals) falls
 * back to a generic message, the same pattern used for Supabase auth errors.
 */
function mapExecutionRpcError(message?: string): string {
  const known = new Set([
    "Not authenticated",
    "workflow_name is required",
    "metadata must be a JSON object",
    "Invalid trigger_source",
    "Automation event not found",
    "Automation event is already being processed",
    "Automation event has already completed",
    "Execution not found",
    "Execution is not running",
  ]);
  if (message && known.has(message)) return message;
  return "We couldn't update this workflow execution.";
}

/**
 * Reads prior execution attempts for an event, scoped by RLS
 * (workflow_executions_select -> is_org_member) to the caller's own
 * organization. Used to enforce the retry ceiling before spending an RPC
 * call on an attempt that would exceed it.
 */
export async function getLatestAttempt(
  supabase: SupabaseClient,
  automationEventId: string,
): Promise<number> {
  const { data } = await supabase
    .from("workflow_executions")
    .select("attempt")
    .eq("automation_event_id", automationEventId)
    .order("attempt", { ascending: false })
    .limit(1)
    .maybeSingle();

  return (data?.attempt as number | undefined) ?? 0;
}

/**
 * Starts a workflow execution for an automation event - this is also the
 * retry entrypoint (calling it again after a failure IS the retry). The
 * database derives the next attempt number itself and rejects starting an
 * event that's already processing or completed, so this never creates
 * duplicate concurrent work for the same event. This function only adds the
 * app-level retry ceiling on top of that.
 */
export async function startWorkflowExecution(
  supabase: SupabaseClient,
  automationEventId: string,
  workflowName: string,
  metadata: Record<string, unknown> = {},
  triggerSource: WorkflowExecutionTriggerSource = "event",
): Promise<ExecutionResult> {
  const user = await requireUser(supabase);
  if (!user) return { ok: false, error: "Not authenticated." };

  const name = workflowName.trim();
  if (!name) return { ok: false, error: "workflow_name is required." };

  const latestAttempt = await getLatestAttempt(supabase, automationEventId);
  if (latestAttempt >= MAX_WORKFLOW_RETRY_ATTEMPTS) {
    return { ok: false, error: "Retry limit reached for this automation event." };
  }

  const { data, error } = await supabase
    .rpc("start_workflow_execution", {
      p_automation_event_id: automationEventId,
      p_workflow_name: name,
      p_metadata: metadata,
      p_trigger_source: triggerSource,
    })
    .single();

  if (error || !data) {
    return { ok: false, error: mapExecutionRpcError(error?.message) };
  }

  return { ok: true, execution: data as WorkflowExecution };
}

/**
 * Automation Health + Alerting V1: the single place every successful
 * completion (whatever triggered it - event, retry, manual run, cron tick)
 * resolves any active per-automation failure incident, per the documented
 * resolution rule in lib/automation-health/service.ts. Never throws.
 */
async function emitFailureResolutionSignal(supabase: SupabaseClient, execution: WorkflowExecution): Promise<void> {
  const automation = getAutomationForWorkflowName(execution.workflow_name);
  await resolveAutomationFailureIncidents(supabase, execution.organization_id, automationFingerprintContext(automation?.id ?? null, execution.workflow_name));
}

/**
 * Automation Health + Alerting V1: the single place every workflow-execution
 * failure (whatever the cause - dispatch, send, or internal) is recorded as
 * a health signal. `category` lets the caller distinguish the cause it
 * actually knows (see WorkflowFailureCategory's own comment); the fingerprint
 * always collapses per-automation, so repeated failures of the same
 * automation increment one incident's occurrence_count rather than creating
 * a flood of new ones. Never throws.
 */
async function emitFailureIncidentSignal(supabase: SupabaseClient, execution: WorkflowExecution, category: WorkflowFailureCategory, errorMessage: string): Promise<void> {
  const automation = getAutomationForWorkflowName(execution.workflow_name);
  await recordAutomationHealthSignal(supabase, {
    organizationId: execution.organization_id,
    category,
    severity: "warning",
    fingerprintContext: automationFingerprintContext(automation?.id ?? null, execution.workflow_name),
    title: `${automation?.name ?? execution.workflow_name} failed`,
    description: errorMessage,
    automationId: automation?.id ?? null,
    workflowExecutionId: execution.id,
  });
}

export async function completeWorkflowExecution(
  supabase: SupabaseClient,
  executionId: string,
  metadata?: Record<string, unknown>,
): Promise<ExecutionResult> {
  const user = await requireUser(supabase);
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data, error } = await supabase
    .rpc("complete_workflow_execution", {
      p_execution_id: executionId,
      p_metadata: metadata ?? null,
    })
    .single();

  if (error || !data) {
    return { ok: false, error: mapExecutionRpcError(error?.message) };
  }

  const execution = data as WorkflowExecution;
  await emitFailureResolutionSignal(supabase, execution);
  return { ok: true, execution };
}

/**
 * Trackpr 2.0, n8n dispatch timeout fix: a dispatch-side timeout or network
 * error (triggerN8nWorkflow's own fetch() failing/aborting - see
 * ./n8n's own comment) is not proof the workflow actually failed. n8n runs
 * independently of Trackpr's own client-side wait, so its callback can
 * legitimately land and complete this same execution around the same time
 * a timeout is being recorded for it. fail_workflow_execution's own
 * `where status = 'running'` guard already makes it impossible for both a
 * completion and a failure to land on the same row, but with no
 * preference for which one wins a genuine race - a stale timeout signal
 * could still beat a real, already-successful completion to the row.
 * Re-checking the execution's current state immediately before (and,
 * for the narrow remaining window, immediately after a rejected RPC call)
 * ensures an execution a callback has already legitimately settled is
 * never overwritten by a timeout that fired merely because Trackpr's own
 * wait, not the workflow itself, gave up.
 */
async function currentExecutionIfSettled(supabase: SupabaseClient, executionId: string): Promise<WorkflowExecution | null> {
  const { data } = await supabase.from("workflow_executions").select("*").eq("id", executionId).maybeSingle();
  if (data && (data as WorkflowExecution).status !== "running") return data as WorkflowExecution;
  return null;
}

/**
 * `errorMessage` is truncated (matching the migration's own 2000-char cap)
 * before it ever reaches the RPC. Callers are responsible for stripping any
 * secrets/tokens from provider error responses before passing them here -
 * this module has no way to know which fields in an arbitrary error object
 * are sensitive.
 */
export async function failWorkflowExecution(
  supabase: SupabaseClient,
  executionId: string,
  errorMessage: string,
  category: WorkflowFailureCategory = "workflow_failed",
): Promise<ExecutionResult> {
  const user = await requireUser(supabase);
  if (!user) return { ok: false, error: "Not authenticated." };

  const alreadySettled = await currentExecutionIfSettled(supabase, executionId);
  if (alreadySettled) return { ok: true, execution: alreadySettled };

  const { data, error } = await supabase
    .rpc("fail_workflow_execution", {
      p_execution_id: executionId,
      p_error_message: errorMessage.slice(0, 2000),
    })
    .single();

  if (error?.message === "Execution is not running") {
    const settled = await currentExecutionIfSettled(supabase, executionId);
    if (settled) return { ok: true, execution: settled };
  }
  if (error || !data) {
    return { ok: false, error: mapExecutionRpcError(error?.message) };
  }

  const execution = data as WorkflowExecution;
  await emitFailureIncidentSignal(supabase, execution, category, errorMessage);
  return { ok: true, execution };
}

/**
 * Service-role variants for the n8n callback route only. That route has no
 * Supabase Auth session to check (n8n authenticates via a shared secret, not
 * a user JWT), so there is no auth.getUser() to require here - the caller
 * must have already verified the request's authenticity and the
 * organization/event/execution relationship itself before calling these.
 * The underlying RPCs recognize the service_role Postgres role as a second
 * legitimate caller (see the n8n_callback_execution_access migration); nothing
 * else about the state-transition logic differs from the user-session path.
 */
export async function completeWorkflowExecutionAsService(
  supabase: SupabaseClient,
  executionId: string,
  metadata?: Record<string, unknown>,
): Promise<ExecutionResult> {
  const { data, error } = await supabase
    .rpc("complete_workflow_execution", {
      p_execution_id: executionId,
      p_metadata: metadata ?? null,
    })
    .single();

  if (error || !data) {
    return { ok: false, error: mapExecutionRpcError(error?.message) };
  }

  const execution = data as WorkflowExecution;
  await emitFailureResolutionSignal(supabase, execution);
  return { ok: true, execution };
}

/**
 * Service-role variant of startWorkflowExecution for the inbound SMS
 * webhook (no Supabase Auth session - see createAutomationEventAsService).
 * The underlying RPC derives organization_id from the automation_events row
 * itself (already set correctly by createAutomationEventAsService), so no
 * organizationId parameter is needed here - only the service_role
 * authorization bypass differs from the user-session path. Does not enforce
 * MAX_WORKFLOW_RETRY_ATTEMPTS: this is always the first attempt for a
 * freshly-created event in this caller's flow, never a retry.
 */
export async function startWorkflowExecutionAsService(
  supabase: SupabaseClient,
  automationEventId: string,
  workflowName: string,
  metadata: Record<string, unknown> = {},
  triggerSource: WorkflowExecutionTriggerSource = "event",
): Promise<ExecutionResult> {
  const name = workflowName.trim();
  if (!name) return { ok: false, error: "workflow_name is required." };

  const { data, error } = await supabase
    .rpc("start_workflow_execution", {
      p_automation_event_id: automationEventId,
      p_workflow_name: name,
      p_metadata: metadata,
      p_trigger_source: triggerSource,
    })
    .single();

  if (error || !data) {
    return { ok: false, error: mapExecutionRpcError(error?.message) };
  }

  return { ok: true, execution: data as WorkflowExecution };
}

export async function failWorkflowExecutionAsService(
  supabase: SupabaseClient,
  executionId: string,
  errorMessage: string,
  category: WorkflowFailureCategory = "workflow_failed",
): Promise<ExecutionResult> {
  // See failWorkflowExecution's own comment above on currentExecutionIfSettled
  // - the same dispatch-timeout-vs-real-callback race applies to every
  // caller of this service-role variant.
  const alreadySettled = await currentExecutionIfSettled(supabase, executionId);
  if (alreadySettled) return { ok: true, execution: alreadySettled };

  const { data, error } = await supabase
    .rpc("fail_workflow_execution", {
      p_execution_id: executionId,
      p_error_message: errorMessage.slice(0, 2000),
    })
    .single();

  if (error?.message === "Execution is not running") {
    const settled = await currentExecutionIfSettled(supabase, executionId);
    if (settled) return { ok: true, execution: settled };
  }
  if (error || !data) {
    return { ok: false, error: mapExecutionRpcError(error?.message) };
  }

  const execution = data as WorkflowExecution;
  await emitFailureIncidentSignal(supabase, execution, category, errorMessage);
  return { ok: true, execution };
}

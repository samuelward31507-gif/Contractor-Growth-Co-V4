import type { SupabaseClient } from "@supabase/supabase-js";

export type WorkflowExecutionStatus = "running" | "completed" | "failed" | "cancelled";
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

  return { ok: true, execution: data as WorkflowExecution };
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
): Promise<ExecutionResult> {
  const user = await requireUser(supabase);
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data, error } = await supabase
    .rpc("fail_workflow_execution", {
      p_execution_id: executionId,
      p_error_message: errorMessage.slice(0, 2000),
    })
    .single();

  if (error || !data) {
    return { ok: false, error: mapExecutionRpcError(error?.message) };
  }

  return { ok: true, execution: data as WorkflowExecution };
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

  return { ok: true, execution: data as WorkflowExecution };
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
): Promise<ExecutionResult> {
  const { data, error } = await supabase
    .rpc("fail_workflow_execution", {
      p_execution_id: executionId,
      p_error_message: errorMessage.slice(0, 2000),
    })
    .single();

  if (error || !data) {
    return { ok: false, error: mapExecutionRpcError(error?.message) };
  }

  return { ok: true, execution: data as WorkflowExecution };
}

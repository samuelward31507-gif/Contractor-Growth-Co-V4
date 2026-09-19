import type { SupabaseClient } from "@supabase/supabase-js";
import { getAutomationForEventType, getAutomationForWorkflowName } from "./catalog";

const SECRET_KEY_PATTERN = /token|secret|password|passwd|api[_-]?key|credential|authoriz|bearer|cron_secret|webhook_secret/i;
const MAX_STRING_LENGTH = 300;
const MAX_KEYS_PER_OBJECT = 25;
const MAX_SANITIZE_DEPTH = 2;

export type SanitizedValue = string | number | boolean | null | SanitizedObject | SanitizedValue[];
export type SanitizedObject = { [key: string]: SanitizedValue };

function sanitizeValue(value: unknown, depth: number): SanitizedValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}… (truncated)` : value;
  }
  if (Array.isArray(value)) {
    if (depth <= 0) return `[array of ${value.length}]`;
    return value.slice(0, MAX_KEYS_PER_OBJECT).map((item) => sanitizeValue(item, depth - 1));
  }
  if (typeof value === "object") {
    if (depth <= 0) return "[object]";
    return sanitizeObject(value as Record<string, unknown>, depth - 1);
  }
  // Functions, symbols, bigints - jsonb never actually contains these, but
  // fail safe to a label rather than attempting to stringify something
  // unexpected.
  return "[unsupported value]";
}

function sanitizeObject(input: Record<string, unknown>, depth: number): SanitizedObject {
  const out: SanitizedObject = {};
  let count = 0;
  for (const [key, value] of Object.entries(input)) {
    if (count >= MAX_KEYS_PER_OBJECT) {
      out["…"] = "(additional fields omitted)";
      break;
    }
    count += 1;
    out[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : sanitizeValue(value, depth);
  }
  return out;
}

/**
 * The only sanctioned way to prepare a jsonb column (workflow_executions.
 * metadata, automation_events.payload) for display - never render a raw
 * column value directly in a component. Redacts any key matching a
 * secret/token/credential-shaped name regardless of nesting depth, caps
 * object/array size and string length so one adversarial or oversized value
 * can't blow up the UI, and returns null for anything that isn't a plain
 * object to begin with (jsonb columns in this schema are always objects,
 * never bare scalars/arrays, but this fails safe rather than assuming so).
 */
export function sanitizeForDisplay(value: unknown): SanitizedObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return sanitizeObject(value as Record<string, unknown>, MAX_SANITIZE_DEPTH);
}

export type ExecutionDetailStatus = "running" | "completed" | "failed" | "cancelled";
export type ExecutionDetailTriggerSource = "event" | "manual" | "retry";

export type ExecutionDetailMessage = {
  status: string;
  statusReason: string | null;
  providerErrorCode: string | null;
};

export type ExecutionDetail = {
  id: string;
  workflowName: string;
  automationId: string | null;
  automationName: string | null;
  status: ExecutionDetailStatus;
  triggerSource: ExecutionDetailTriggerSource;
  attempt: number;
  startedAt: string;
  completedAt: string | null;
  automationEventId: string | null;
  errorMessage: string | null;
  metadata: SanitizedObject | null;
  payload: SanitizedObject | null;
  /** The outbound SMS this execution sent, if any (Twilio SMS Delivery Status Tracking V1) - null when this execution never sent a message (e.g. blocked by the outbound gate, or not an SMS-sending automation). */
  outboundMessage: ExecutionDetailMessage | null;
};

/**
 * Organization-scoped, session-authenticated read for one execution's full
 * detail (Phase F). The only place this codebase reads workflow_executions.
 * metadata/error_message or automation_events.payload for display - every
 * jsonb value goes through sanitizeForDisplay() before ever leaving this
 * function; no raw column value is ever returned to a caller. Scoped by
 * organization_id explicitly on every query (never relies on RLS alone,
 * matching every other query in this codebase), using whichever client the
 * caller passes - callers must always pass their own session-scoped client,
 * never a service-role client (there is no legitimate browser/UI use case
 * for one here). `workflow_executions.updated_at` does not exist in this
 * schema (confirmed by inspection) and is not fabricated.
 */
export async function getExecutionDetail(
  supabase: SupabaseClient,
  organizationId: string,
  executionId: string,
): Promise<ExecutionDetail | null> {
  const { data: execution } = await supabase
    .from("workflow_executions")
    .select("id, organization_id, automation_event_id, workflow_name, status, attempt, started_at, completed_at, error_message, metadata, trigger_source")
    .eq("id", executionId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (!execution) return null;

  let eventType: string | null = null;
  let rawPayload: unknown = null;

  if (execution.automation_event_id) {
    const { data: event } = await supabase
      .from("automation_events")
      .select("event_type, payload")
      .eq("id", execution.automation_event_id)
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (event) {
      eventType = event.event_type as string;
      rawPayload = event.payload;
    }
  }

  const automation = eventType ? getAutomationForEventType(eventType) : getAutomationForWorkflowName(execution.workflow_name as string);

  // Outbound messages are linked back to the exact execution that sent them
  // via messages.workflow_execution_id (see sendOutboundMessage()) - at most
  // one outbound message per execution, matching the DB's own unique
  // constraint on (workflow_execution_id) for outbound direction.
  const { data: message } = await supabase
    .from("messages")
    .select("status, status_reason, provider_error_code")
    .eq("workflow_execution_id", execution.id)
    .eq("organization_id", organizationId)
    .eq("direction", "outbound")
    .maybeSingle();

  return {
    id: execution.id,
    workflowName: execution.workflow_name,
    automationId: automation?.id ?? null,
    automationName: automation?.name ?? null,
    status: execution.status as ExecutionDetailStatus,
    triggerSource: execution.trigger_source as ExecutionDetailTriggerSource,
    attempt: execution.attempt,
    startedAt: execution.started_at,
    completedAt: execution.completed_at,
    automationEventId: execution.automation_event_id,
    // error_message in this codebase is always developer/RPC/provider-status
    // text (e.g. "Could not reach the automation orchestrator.", "The
    // appointment no longer exists.") - never a raw secret or credential by
    // construction at every call site - but still capped to the same
    // MAX_STRING_LENGTH as any other displayed string, defensively.
    errorMessage: execution.error_message ? sanitizeValue(execution.error_message, 0) as string : null,
    metadata: sanitizeForDisplay(execution.metadata),
    payload: sanitizeForDisplay(rawPayload),
    outboundMessage: message
      ? {
          status: message.status as string,
          statusReason: message.status_reason ? (sanitizeValue(message.status_reason, 0) as string) : null,
          providerErrorCode: message.provider_error_code as string | null,
        }
      : null,
  };
}

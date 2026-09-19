import type { SupabaseClient } from "@supabase/supabase-js";
import { getAutomationForEventType } from "./catalog";
import { getAutomationEnabled } from "./settings";
import { MAX_WORKFLOW_RETRY_ATTEMPTS } from "./executions";

export type RetryRejectionReason =
  | "execution_not_found"
  | "not_failed"
  | "retry_ceiling_reached"
  | "missing_parent_event"
  | "event_not_retryable"
  | "automation_disabled"
  | "not_safely_retryable";

/**
 * Post-Phase-E safety audit finding (see the Phase E review report): for
 * every n8n-dispatched automation EXCEPT instant-lead-followup, the real
 * outbound contract n8n receives is built from a payload assembled fresh at
 * dispatch time (live appointment/job/estimate/lead/conversation details)
 * that is never persisted back to automation_events.payload - only a
 * minimal identifier (e.g. `{ appointment_id }`) is stored. Retrying one of
 * those would send n8n an impoverished, unverified contract missing fields
 * the real dispatch always included, silently degrading or breaking the
 * AI's draft - lib/automation/n8n-retry.ts documents the exact missing
 * fields per automation.
 *
 * instant-lead-followup is the sole verified exception: lead-followup.ts's
 * stored automation_events.payload IS passed to its own outbound contract
 * completely unchanged, so lib/automation/n8n-retry.ts's generic
 * reconstruction is byte-for-byte faithful for it alone.
 *
 * This allowlist is therefore the actual safety boundary for retry, not
 * automation.dispatch - appointment-reminders/estimate-followup are
 * trackpr-dispatched and independently verified safe (they re-fetch the
 * live entity by id rather than trusting any stored payload at all - see
 * retryAppointmentReminder/retryEstimateWorkflow). Every other n8n-dispatched
 * automation, and any event type with no catalog mapping at all (nothing to
 * verify against), is rejected here until a future phase enriches its
 * stored payload to match its real contract.
 */
const SAFE_RETRY_AUTOMATION_IDS = new Set(["appointment-reminders", "estimate-followup", "instant-lead-followup"]);

export type RetryEligibleExecution = {
  id: string;
  organizationId: string;
  automationEventId: string;
  workflowName: string;
  attempt: number;
};

export type RetryEligibleEvent = {
  id: string;
  organizationId: string;
  eventType: string;
  entityType: string | null;
  entityId: string | null;
  payload: Record<string, unknown>;
};

export type RetryEligibilityResult =
  | { ok: true; execution: RetryEligibleExecution; event: RetryEligibleEvent; automationId: string | null }
  | { ok: false; reason: RetryRejectionReason; automationId: string | null };

/**
 * The sole eligibility gate for retrying a failed workflow execution.
 * Deliberately kept in its own module with no "@/"-aliased or Next.js
 * imports (only relative imports to catalog.ts/settings.ts/executions.ts,
 * none of which have such imports either) so it can be unit tested directly
 * under plain `node --test` - unlike the actual redispatch logic in
 * retry.ts, which pulls in the automation-specific send/n8n modules and
 * therefore cannot be.
 *
 * Every check here is a pre-check for a clear, specific rejection reason -
 * the true, race-proof authority for "is this retryable right now" remains
 * start_workflow_execution's own RPC-level guards (it independently refuses
 * to run again once the parent event is 'processing'/'completed', and its
 * own attempt-numbering is the real ceiling enforcement). This function
 * exists so a rejection can be explained specifically (disabled automation
 * vs. already at the ceiling vs. not actually failed) rather than
 * collapsing into one generic RPC error.
 */
export async function checkRetryEligibility(
  supabase: SupabaseClient,
  organizationId: string,
  executionId: string,
): Promise<RetryEligibilityResult> {
  const { data: execution } = await supabase
    .from("workflow_executions")
    .select("id, organization_id, automation_event_id, workflow_name, status, attempt")
    .eq("id", executionId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (!execution) {
    return { ok: false, reason: "execution_not_found", automationId: null };
  }

  if (execution.status !== "failed") {
    return { ok: false, reason: "not_failed", automationId: null };
  }

  if (execution.attempt >= MAX_WORKFLOW_RETRY_ATTEMPTS) {
    return { ok: false, reason: "retry_ceiling_reached", automationId: null };
  }

  if (!execution.automation_event_id) {
    return { ok: false, reason: "missing_parent_event", automationId: null };
  }

  const { data: event } = await supabase
    .from("automation_events")
    .select("id, organization_id, event_type, entity_type, entity_id, payload, status")
    .eq("id", execution.automation_event_id)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (!event) {
    return { ok: false, reason: "missing_parent_event", automationId: null };
  }

  const automation = getAutomationForEventType(event.event_type);
  const automationId = automation?.id ?? null;

  if (event.status === "processing" || event.status === "completed") {
    return { ok: false, reason: "event_not_retryable", automationId };
  }

  // Safety boundary - see SAFE_RETRY_AUTOMATION_IDS's own comment. Checked
  // before the enabled check below: whether retry is safe for this
  // automation at all is a more fundamental question than whether it's
  // currently turned on.
  if (!automationId || !SAFE_RETRY_AUTOMATION_IDS.has(automationId)) {
    return { ok: false, reason: "not_safely_retryable", automationId };
  }

  const enabled = await getAutomationEnabled(supabase, organizationId, automationId);
  if (!enabled) {
    return { ok: false, reason: "automation_disabled", automationId };
  }

  return {
    ok: true,
    execution: {
      id: execution.id,
      organizationId: execution.organization_id,
      automationEventId: execution.automation_event_id,
      workflowName: execution.workflow_name,
      attempt: execution.attempt,
    },
    event: {
      id: event.id,
      organizationId: event.organization_id,
      eventType: event.event_type,
      entityType: event.entity_type,
      entityId: event.entity_id,
      payload: (event.payload as Record<string, unknown>) ?? {},
    },
    automationId,
  };
}

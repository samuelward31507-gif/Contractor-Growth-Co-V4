import type { SupabaseClient } from "@supabase/supabase-js";
import { buildIncidentFingerprint } from "./fingerprint";
import { mapIncidentRow, type AutomationIncident, type AutomationIncidentRow, type RecordableIncidentCategory, type IncidentSeverity } from "./types";

const MAX_DESCRIPTION_LENGTH = 500;

export type RecordSignalInput = {
  organizationId: string;
  category: RecordableIncidentCategory;
  severity: IncidentSeverity;
  /** Combined with `category` (via buildIncidentFingerprint) to form the dedup key - see fingerprint.ts for the per-category context rules. */
  fingerprintContext: string;
  title: string;
  /** Already-sanitized, developer-authored or truncated text only - this function never re-sanitizes. Truncated to MAX_DESCRIPTION_LENGTH as defense in depth. */
  description?: string | null;
  automationId?: string | null;
  workflowExecutionId?: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * The single, centralized way any part of Trackpr may record an automation
 * health signal - every call site in this codebase (executions.ts's
 * fail/complete functions, the n8n callback route, the SMS status webhook,
 * the /api/automation/health stuck-execution scan) goes through this
 * function, never a raw `automation_incidents` insert. All classification,
 * deduplication, and repeated-failure escalation logic lives in the
 * record_automation_incident_signal RPC (see the automation_health_and_alerting
 * migration) - this function only shapes the call and never throws, matching
 * this codebase's established rule that observability/audit writes are
 * best-effort and must never make an automation's own failure path fail
 * harder. A failure to record a signal is logged, never surfaced to the
 * caller as an error.
 */
export async function recordAutomationHealthSignal(supabase: SupabaseClient, input: RecordSignalInput): Promise<AutomationIncident | null> {
  const fingerprint = buildIncidentFingerprint(input.category, input.fingerprintContext);
  const description = input.description ? input.description.trim().slice(0, MAX_DESCRIPTION_LENGTH) : null;

  const { data, error } = await supabase
    .rpc("record_automation_incident_signal", {
      p_organization_id: input.organizationId,
      p_category: input.category,
      p_severity: input.severity,
      p_fingerprint: fingerprint,
      p_title: input.title.slice(0, 200),
      p_description: description,
      p_automation_id: input.automationId ?? null,
      p_workflow_execution_id: input.workflowExecutionId ?? null,
      p_metadata: input.metadata ?? {},
    })
    .single();

  if (error || !data) {
    console.error("[automation-health] failed to record incident signal", {
      organizationId: input.organizationId,
      category: input.category,
      error: error?.message,
    });
    return null;
  }

  return mapIncidentRow(data as AutomationIncidentRow);
}

/**
 * Resolution rule: "a subsequent successful execution of the same automation
 * resolves the active failure incident" (spec section 10) - applies only to
 * the three per-automation categories whose fingerprint context is the
 * automation itself (workflow_failed, its repeated_workflow_failure
 * escalation, n8n_dispatch_failed, sms_send_failed). Deliberately does NOT
 * resolve workflow_stuck (that execution's own specific resolution is
 * handled separately - see resolveStaleStuckIncidents), n8n_callback_failed
 * (a botched callback for execution A says nothing about execution B
 * succeeding), or sms_delivery_failed (an individual, terminal delivery
 * failure - per spec, never auto-resolved merely because a different later
 * message succeeded). Called from lib/automation/executions.ts's
 * completeWorkflowExecution/completeWorkflowExecutionAsService - the single
 * chokepoint every successful execution (whatever triggered it) passes
 * through - so this never needs to be called from individual automation
 * modules directly. Best-effort and non-throwing, like recordAutomationHealthSignal.
 *
 * Goes through resolve_automation_incidents_by_fingerprint (never a raw
 * `.update()`) because several callers of this function run with a real
 * user's SESSION client, not service-role - automation_incidents has no
 * UPDATE policy for `authenticated` (every write goes through a narrow
 * SECURITY DEFINER RPC, matching automation_events/audit_log's own
 * precedent), so a raw update from a session client would silently affect
 * zero rows under RLS rather than erroring.
 */
export async function resolveAutomationFailureIncidents(supabase: SupabaseClient, organizationId: string, fingerprintContext: string): Promise<void> {
  const fingerprints = [
    buildIncidentFingerprint("workflow_failed", fingerprintContext),
    buildIncidentFingerprint("repeated_workflow_failure", fingerprintContext),
    buildIncidentFingerprint("n8n_dispatch_failed", fingerprintContext),
    buildIncidentFingerprint("sms_send_failed", fingerprintContext),
  ];

  const { error } = await supabase.rpc("resolve_automation_incidents_by_fingerprint", {
    p_organization_id: organizationId,
    p_fingerprints: fingerprints,
  });

  if (error) {
    console.error("[automation-health] failed to auto-resolve failure incidents", { organizationId, fingerprintContext, error: error.message });
  }
}

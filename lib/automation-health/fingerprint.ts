import type { IncidentCategory } from "./types";

/**
 * Deterministic incident deduplication key. Pure and unit-testable in
 * isolation (no Supabase/Next.js imports), matching lib/contacts/identity.ts's
 * own precedent for this class of pure, security-relevant logic.
 *
 * The database enforces the actual dedup guarantee (a unique partial index
 * on (organization_id, fingerprint) WHERE status IN ('open','acknowledged') -
 * see the automation_health_and_alerting migration) - this function only
 * needs to be deterministic and stable for the same real-world problem, not
 * merely unique.
 *
 * Context rules, chosen from the real evidence in the current architecture,
 * not invented:
 *  - workflow_failed / n8n_dispatch_failed / sms_send_failed: context is the
 *    automation (catalog id, or the raw workflow_name when no catalog
 *    automation claims it) - "the same automation failing repeatedly" must
 *    collapse into ONE incident with occurrence_count incrementing, per the
 *    explicit product requirement ("if the same automation fails 20 times in
 *    10 minutes, do not create 20 incidents").
 *  - workflow_stuck / n8n_callback_failed: context is the specific execution
 *    id - each stuck execution (or each botched callback for one execution)
 *    is its own distinct problem affecting a specific customer interaction,
 *    not something that should merge with a different execution's incident.
 *    Repeated detection of the SAME execution across health-check ticks
 *    still collapses correctly, since the execution id is stable.
 *  - sms_delivery_failed: context is the specific message id - each failed/
 *    undelivered delivery is a distinct, individual provider failure with
 *    its own terminal outcome (never auto-resolved by a later, different
 *    message succeeding - see lib/automation-health/service.ts).
 *  - human_escalation_requested (HANDOFF-01): context is the conversation id
 *    - one open escalation incident per conversation, matching the existing
 *    conversations.ai_enabled lockout's own per-conversation granularity. A
 *    second, different escalation reason on an already-escalated
 *    conversation increments occurrence_count on the same incident rather
 *    than creating a duplicate.
 */
export function buildIncidentFingerprint(category: IncidentCategory, context: string): string {
  const trimmed = context.trim();
  if (!trimmed) {
    throw new Error("buildIncidentFingerprint requires a non-empty context");
  }
  return `${category}:${trimmed}`;
}

/** Stable context for the three automation-level categories - see this file's own header comment. */
export function automationFingerprintContext(automationId: string | null, workflowName: string): string {
  return automationId ?? `workflow:${workflowName}`;
}

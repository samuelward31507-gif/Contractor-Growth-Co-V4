"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserOrganization } from "@/lib/auth/organization";
import { assertOrgAdmin } from "@/lib/automation/authorization";
import { getAutomationDefinition } from "@/lib/automation/catalog";
import {
  getAutomationEnabled,
  shouldAuditEnableToggle,
  readAppointmentReminderConfig,
  validateAppointmentReminderConfig,
  readEstimateFollowupConfig,
  validateEstimateFollowupConfig,
  readInboundCustomerReplyConfig,
  validateInboundCustomerReplyConfig,
  readInstantLeadFollowupConfig,
  validateInstantLeadFollowupConfig,
  readLostLeadNurtureConfig,
  validateLostLeadNurtureConfig,
  readLeadReactivationConfig,
  validateLeadReactivationConfig,
  readAppointmentLifecycleConfig,
  validateAppointmentLifecycleConfig,
  readJobLifecycleConfig,
  validateJobLifecycleConfig,
  readReviewReferralFollowupConfig,
  validateReviewReferralFollowupConfig,
  shouldAuditConfigUpdate,
} from "@/lib/automation/settings";
import { processAppointmentReminders, previewAppointmentReminders, type ReminderPreview } from "@/lib/automation/appointment-reminders";
import { processEstimateFollowups, previewEstimateFollowups, type FollowupPreview } from "@/lib/automation/estimate-followups";
import { retryWorkflowExecution, planRetryAudit } from "@/lib/automation/retry";
import type { RetryRejectionReason } from "@/lib/automation/retry-eligibility";
import { getExecutionDetail, type ExecutionDetail } from "@/lib/automation/execution-detail";

/**
 * Manual run / dry run (Phase D) are only offered for the two
 * Trackpr-dispatched automations - both are fully composed and sent by
 * Trackpr itself with no n8n round trip, so "run this right now" and "show
 * me what this would send" are both tractable without ever touching n8n.
 * The other 7 dispatchable automations hand off to n8n for AI drafting;
 * manually triggering those would mean either faking an AI response (unsafe/
 * meaningless) or actually invoking n8n on demand (an n8n change, out of
 * scope). This Set is the ONLY place automationId is checked against a
 * fixed allowlist before either action does anything - there is no dynamic
 * mapping from an arbitrary client-supplied automationId to a workflow/event
 * name anywhere below; the two branches are a hardcoded if/else.
 */
const MANUAL_RUN_AUTOMATION_IDS = new Set(["appointment-reminders", "estimate-followup"]);

export type AutomationActionState = {
  error?: string;
  success?: boolean;
  /**
   * Set only when the automation_settings mutation itself succeeded but the
   * audit record could not be written - the mutation is never rolled back
   * for an audit failure (matching this codebase's existing precedent: the
   * n8n callback route's ai_interactions write failing does not fail or
   * undo the workflow completion it's attached to), but the caller must
   * never be told the action was audited when it silently wasn't.
   */
  auditWarning?: string;
};

/**
 * The only mutation this phase implements: a soft, per-organization
 * enable/disable toggle. Does not cancel anything already in flight - see
 * lib/automation/catalog.ts's own documentation of what "disabled" means
 * (no new events/executions going forward; existing pending/processing work
 * finishes normally). Authorization order follows the approved Phase C
 * design exactly: resolve the caller's own organization server-side (never
 * a client-supplied id) before anything else, then assertOrgAdmin() before
 * even validating the automation id - catalog ids aren't secret (the v1
 * read-only UI already shows them to any org member), so this ordering is
 * about consistently checking authorization first, not about hiding catalog
 * contents.
 */
export async function setAutomationEnabled(automationId: string, enabled: boolean): Promise<AutomationActionState> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const membership = await getUserOrganization(supabase, user.id);
  if (!membership) {
    redirect("/onboarding");
  }

  const authResult = await assertOrgAdmin(supabase, membership.organizationId);
  if (!authResult.ok) {
    return { error: authResult.error };
  }

  if (typeof enabled !== "boolean") {
    return { error: "Invalid request." };
  }

  const definition = getAutomationDefinition(automationId);
  if (!definition) {
    return { error: "Unknown automation." };
  }

  // Safe AI Outbound is the safety layer every other automation's send
  // passes through, not a standalone, user-disableable workflow - it has no
  // event_type/workflow_name of its own to stop dispatching in the first
  // place. Rejected outright, never given an automation_settings row.
  if (definition.kind === "safety-layer") {
    return { error: "Safe AI Outbound is a safety layer and cannot be disabled." };
  }

  // Read the prior state before mutating, so a repeated no-op toggle (e.g.
  // clicking "enable" on an automation that's already enabled) never writes
  // a misleading transition into the audit log below. Missing row = enabled,
  // matching getAutomationEnabled's own default exactly.
  const { data: existingRow } = await supabase
    .from("automation_settings")
    .select("enabled")
    .eq("organization_id", membership.organizationId)
    .eq("automation_id", automationId)
    .maybeSingle();

  const previousEnabled = (existingRow?.enabled as boolean | undefined) ?? true;

  // created_at is intentionally omitted so a first insert gets its own
  // DEFAULT now() and an existing row's created_at is never touched by the
  // update branch; updated_at is likewise omitted and left entirely to the
  // automation_settings_updated_at trigger (Phase A).
  const { error: upsertError } = await supabase.from("automation_settings").upsert(
    { organization_id: membership.organizationId, automation_id: automationId, enabled },
    { onConflict: "organization_id,automation_id" },
  );

  if (upsertError) {
    return { error: "We couldn't update this automation. Please try again." };
  }

  revalidatePath("/automations");

  // shouldAuditEnableToggle (lib/automation/settings.ts) is the single,
  // unit-tested source of truth for "was this a real transition" - returns
  // null for a no-op toggle, which is never audited.
  const auditPlan = shouldAuditEnableToggle(previousEnabled, enabled);
  if (!auditPlan) {
    return { success: true };
  }

  // Phase C.1: the only sanctioned way to write an audit_log row - see
  // supabase/migrations/20260919043750_automation_audit_logging.sql.
  // audit_log has no client INSERT policy (by design, unchanged here), so
  // this always goes through create_automation_audit_event, a SECURITY
  // DEFINER RPC that re-derives the actor from auth.uid() and re-verifies
  // is_org_admin(organizationId) itself - never trusting that this
  // function already checked it. Logged, never treated as a mutation
  // failure: the automation_settings change above already succeeded and is
  // real; only the caller-visible confirmation reflects that the audit
  // record specifically could not be saved.
  const { error: auditError } = await supabase.rpc("create_automation_audit_event", {
    p_organization_id: membership.organizationId,
    p_action: auditPlan.action,
    p_automation_id: automationId,
    p_metadata: auditPlan.metadata,
  });

  if (auditError) {
    console.error("[automation] failed to record audit log entry", {
      organizationId: membership.organizationId,
      automationId,
      action: auditPlan.action,
      error: auditError.message,
    });
    return { success: true, auditWarning: "The automation was updated, but the audit record could not be saved." };
  }

  return { success: true };
}

/**
 * Resolves the caller's own session/organization exactly like
 * setAutomationEnabled above, then requires org-admin - shared by
 * runAutomationNow and dryRunAutomation below. Never accepts an
 * organization id from the caller; always redirects/derives it from the
 * verified session, same as every other action in this file.
 */
async function requireOrgAdminSession() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const membership = await getUserOrganization(supabase, user.id);
  if (!membership) {
    redirect("/onboarding");
  }

  const authResult = await assertOrgAdmin(supabase, membership.organizationId);
  if (!authResult.ok) {
    return { ok: false as const, error: authResult.error };
  }

  return { ok: true as const, supabase, organizationId: membership.organizationId };
}

/**
 * Manual run: triggers the same scan the corresponding cron route runs
 * (processAppointmentReminders/processEstimateFollowups), right now,
 * instead of waiting for the next scheduled tick. Uses the caller's own
 * session client, not service_role - RLS naturally scopes the underlying
 * appointments/estimates queries to this organization alone, so this can
 * never touch another organization's candidates. Every event/execution this
 * creates goes through the exact same chokepoints (createAutomationEventAsService,
 * startWorkflowExecutionAsService, evaluateOutboundGate, sendOutboundMessage)
 * a real cron tick would use - the only difference is trigger_source:
 * "manual" instead of "event", and that it can find and act on a candidate
 * before the next scheduled tick would have. Existing idempotency keys are
 * unchanged, so a manual run can never duplicate a send a prior cron tick
 * (or a prior manual run) already made.
 */
export async function runAutomationNow(automationId: string): Promise<AutomationActionState> {
  const session = await requireOrgAdminSession();
  if (!session.ok) {
    return { error: session.error };
  }
  const { supabase, organizationId } = session;

  if (!MANUAL_RUN_AUTOMATION_IDS.has(automationId)) {
    return { error: "Manual run is not available for this automation." };
  }

  const definition = getAutomationDefinition(automationId);
  if (!definition) {
    return { error: "Unknown automation." };
  }

  const enabled = await getAutomationEnabled(supabase, organizationId, automationId);
  if (!enabled) {
    return { error: "This automation is disabled." };
  }

  const result =
    automationId === "appointment-reminders"
      ? await processAppointmentReminders(supabase, new Date(), undefined, "manual")
      : await processEstimateFollowups(supabase, new Date(), undefined, "manual");

  revalidatePath(`/automations/${automationId}`);

  const { error: auditError } = await supabase.rpc("create_automation_audit_event", {
    p_organization_id: organizationId,
    p_action: "automation_manual_run_requested",
    p_automation_id: automationId,
    p_metadata: { candidates: result.candidates },
  });

  if (auditError) {
    console.error("[automation] failed to record audit log entry", {
      organizationId,
      automationId,
      action: "automation_manual_run_requested",
      error: auditError.message,
    });
    return { success: true, auditWarning: "The automation ran, but the audit record could not be saved." };
  }

  return { success: true };
}

export type DryRunActionState = AutomationActionState & {
  preview?: ReminderPreview | FollowupPreview;
};

/**
 * Dry run: a read-only preview, never a fake execution - see
 * previewAppointmentReminders/previewEstimateFollowups for why. Creates no
 * automation_events/workflow_executions/messages row and never calls
 * sendOutboundMessage, evaluateOutboundGate, triggerN8nWorkflow, or any
 * Twilio/n8n dependency - those functions simply aren't reachable from this
 * code path, not merely skipped by a flag.
 */
export async function dryRunAutomation(automationId: string): Promise<DryRunActionState> {
  const session = await requireOrgAdminSession();
  if (!session.ok) {
    return { error: session.error };
  }
  const { supabase, organizationId } = session;

  if (!MANUAL_RUN_AUTOMATION_IDS.has(automationId)) {
    return { error: "Dry run is not available for this automation." };
  }

  const definition = getAutomationDefinition(automationId);
  if (!definition) {
    return { error: "Unknown automation." };
  }

  const enabled = await getAutomationEnabled(supabase, organizationId, automationId);
  if (!enabled) {
    return { error: "This automation is disabled." };
  }

  const preview =
    automationId === "appointment-reminders"
      ? await previewAppointmentReminders(supabase, organizationId)
      : await previewEstimateFollowups(supabase, organizationId);

  // Narrow, non-PII metadata only - never the composed message body or a
  // contact/appointment/estimate id.
  const { error: auditError } = await supabase.rpc("create_automation_audit_event", {
    p_organization_id: organizationId,
    p_action: "automation_dry_run_requested",
    p_automation_id: automationId,
    p_metadata: { outcome: preview.outcome },
  });

  if (auditError) {
    console.error("[automation] failed to record audit log entry", {
      organizationId,
      automationId,
      action: "automation_dry_run_requested",
      error: auditError.message,
    });
    return { success: true, preview, auditWarning: "The preview ran, but the audit record could not be saved." };
  }

  return { success: true, preview };
}

const RETRY_REJECTION_MESSAGES: Record<RetryRejectionReason, string> = {
  execution_not_found: "Execution not found.",
  not_failed: "Only a failed execution can be retried.",
  retry_ceiling_reached: "This execution has already reached the maximum number of retry attempts.",
  missing_parent_event: "This execution's automation event no longer exists.",
  event_not_retryable: "This automation event is already being processed or has completed.",
  automation_disabled: "This automation is disabled.",
  not_safely_retryable: "Retry is not yet supported for this automation.",
};

function retryRejectionMessage(reason: string): string {
  return RETRY_REJECTION_MESSAGES[reason as RetryRejectionReason] ?? "We couldn't retry this execution. Please try again.";
}

export type RetryActionState = AutomationActionState & { newExecutionId?: string };

/**
 * Retries a failed workflow execution. All eligibility is decided by
 * checkRetryEligibility (lib/automation/retry-eligibility.ts) - never
 * re-implemented here - and the actual retry always goes through
 * start_workflow_execution (lib/automation/retry.ts), never a second
 * execution-creation path. Audit logging can only happen once an
 * automation_id is known (create_automation_audit_event requires it
 * NOT NULL) - a rejection resolved before the parent event/automation could
 * be identified (execution not found, not actually failed, already at the
 * retry ceiling, missing parent event) has nothing to attribute an audit
 * row to and is reported as a plain error with no audit call; every other
 * outcome is audited with the original execution's id as entity_id.
 *
 * Exact audit semantics (fixed post-review - see the Phase E review
 * report):
 * - automation_retry_rejected: the retry was rejected before a new retry
 *   execution was successfully created - either an eligibility failure
 *   (result.ok === false) or start_workflow_execution itself failing.
 * - automation_retry_requested: a new execution WAS successfully created -
 *   logged once that's true, regardless of what happens next.
 * - automation_retry_succeeded: the execution was created AND the
 *   redispatch/handoff (the n8n webhook call, or the trackpr gate+send
 *   path) was itself successfully initiated (retryWorkflowExecution's
 *   `dispatched: true`) - never interpreted as "the underlying automation
 *   eventually completed". If the handoff fails (`dispatched: false`), only
 *   "requested" is logged, never "succeeded" - the execution row exists
 *   (already correctly marked 'failed' by the redispatch function itself),
 *   but the retry did not achieve what the admin asked for, so the
 *   caller-visible result is an error, not a silent success.
 */
export async function retryExecution(executionId: string): Promise<RetryActionState> {
  const session = await requireOrgAdminSession();
  if (!session.ok) {
    return { error: session.error };
  }
  const { supabase, organizationId } = session;

  const result = await retryWorkflowExecution(supabase, organizationId, executionId);
  // planRetryAudit (lib/automation/retry.ts) is the single, unit-tested
  // source of truth for which audit action(s) this outcome warrants - see
  // its own comment for the exact four-way semantics.
  const plan = planRetryAudit(result);

  if (!result.ok) {
    if (plan.kind === "rejected") {
      const { error: auditError } = await supabase.rpc("create_automation_audit_event", {
        p_organization_id: organizationId,
        p_action: "automation_retry_rejected",
        p_automation_id: plan.automationId,
        p_metadata: { reason: plan.reason },
        p_entity_id: executionId,
      });

      if (auditError) {
        console.error("[automation] failed to record audit log entry", {
          organizationId,
          automationId: plan.automationId,
          action: "automation_retry_rejected",
          error: auditError.message,
        });
      }
    }

    return { error: retryRejectionMessage(result.reason) };
  }

  revalidatePath(`/automations`);

  if (plan.kind === "unattributable") {
    return { success: true, newExecutionId: result.newExecutionId, auditWarning: "The retry ran, but could not be attributed to a known automation for auditing." };
  }

  // A new execution was successfully created - that fact alone is always
  // "requested", regardless of what the handoff does next. Non-fatal to
  // the caller-visible result: the execution already exists by this point
  // regardless of whether the audit trail can be written.
  const requestAudit = await supabase.rpc("create_automation_audit_event", {
    p_organization_id: organizationId,
    p_action: "automation_retry_requested",
    p_automation_id: plan.automationId,
    p_metadata: {},
    p_entity_id: executionId,
  });

  if (requestAudit.error) {
    console.error("[automation] failed to record audit log entry", {
      organizationId,
      automationId: plan.automationId,
      action: "automation_retry_requested",
      error: requestAudit.error.message,
    });
  }

  if (plan.kind === "requested_only") {
    // Execution created, but the handoff itself failed (already recorded
    // as a failed execution by the redispatch function) - NOT
    // "succeeded": the admin's retry did not achieve what they asked for.
    // No "rejected" audit either - rejection is specifically defined as
    // "before a new execution was created", which already happened here.
    return {
      error: `The retry was created but could not be dispatched: ${!result.dispatched ? result.dispatchError : "Unknown dispatch error."}`,
      newExecutionId: result.newExecutionId,
      auditWarning: requestAudit.error ? "The audit record could not be saved." : undefined,
    };
  }

  const successAudit = await supabase.rpc("create_automation_audit_event", {
    p_organization_id: organizationId,
    p_action: "automation_retry_succeeded",
    p_automation_id: plan.automationId,
    p_metadata: { new_execution_id: result.newExecutionId },
    p_entity_id: executionId,
  });

  if (successAudit.error) {
    console.error("[automation] failed to record audit log entry", {
      organizationId,
      automationId: plan.automationId,
      action: "automation_retry_succeeded",
      error: successAudit.error.message,
    });
    return { success: true, newExecutionId: result.newExecutionId, auditWarning: "The retry ran, but the audit record could not be saved." };
  }

  return { success: true, newExecutionId: result.newExecutionId };
}

/**
 * Resolves the caller's own session/organization only - no admin
 * requirement. Phase F execution-detail viewing is available to any org
 * member (read-only data about their own organization's automations), not
 * just admins - mutations elsewhere in this file continue to use
 * requireOrgAdminSession instead. Never accepts an organization id from the
 * caller; always derives it from the verified session, same as every other
 * function in this file.
 */
async function requireOrgSession() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const membership = await getUserOrganization(supabase, user.id);
  if (!membership) {
    redirect("/onboarding");
  }

  return { supabase, organizationId: membership.organizationId };
}

export type ExecutionDetailActionState = { ok: true; detail: ExecutionDetail } | { ok: false; error: string };

/**
 * Phase F: fetches one execution's sanitized detail for display. Read-only,
 * member-accessible (not admin-only) - organization scope comes entirely
 * from the authenticated session via requireOrgSession, using the session
 * client throughout (RLS is_org_member is the backstop; getExecutionDetail
 * also explicitly filters by organization_id itself). No service-role
 * client is used anywhere in this path.
 */
export async function getExecutionDetailAction(executionId: string): Promise<ExecutionDetailActionState> {
  const { supabase, organizationId } = await requireOrgSession();

  const detail = await getExecutionDetail(supabase, organizationId, executionId);
  if (!detail) {
    return { ok: false, error: "Execution not found." };
  }

  return { ok: true, detail };
}

export type ConfigActionState = AutomationActionState & { config?: Record<string, unknown> };

/**
 * Automation Configuration V1: updates appointment-reminders' configured
 * reminder lead time. Owner/admin only (requireOrgAdminSession, same as
 * every other mutation in this file). Only ever touches the `config`
 * column - `enabled` is read/written exclusively by setAutomationEnabled
 * above, and this upsert never includes it, so a config save can never
 * accidentally flip an automation's enabled state (or vice versa).
 * Audited only when the value actually changes - shouldAuditConfigUpdate
 * (lib/automation/settings.ts) is the single, unit-tested source of truth
 * for that decision, mirroring shouldAuditEnableToggle's own pattern above.
 */
export async function updateAppointmentReminderConfig(reminderLeadTimeHours: number): Promise<ConfigActionState> {
  const session = await requireOrgAdminSession();
  if (!session.ok) {
    return { error: session.error };
  }
  const { supabase, organizationId } = session;

  const validation = validateAppointmentReminderConfig({ reminder_lead_time_hours: reminderLeadTimeHours });
  if (!validation.ok) {
    return { error: validation.error };
  }

  const { data: existingRow } = await supabase
    .from("automation_settings")
    .select("config")
    .eq("organization_id", organizationId)
    .eq("automation_id", "appointment-reminders")
    .maybeSingle();

  const previousConfig = readAppointmentReminderConfig(existingRow?.config ?? null);

  const { error: upsertError } = await supabase.from("automation_settings").upsert(
    { organization_id: organizationId, automation_id: "appointment-reminders", config: validation.value },
    { onConflict: "organization_id,automation_id" },
  );

  if (upsertError) {
    return { error: "We couldn't update this automation's configuration. Please try again." };
  }

  revalidatePath("/automations/appointment-reminders");

  const auditPlan = shouldAuditConfigUpdate(previousConfig, validation.value);
  if (!auditPlan) {
    return { success: true, config: validation.value };
  }

  const { error: auditError } = await supabase.rpc("create_automation_audit_event", {
    p_organization_id: organizationId,
    p_action: auditPlan.action,
    p_automation_id: "appointment-reminders",
    p_metadata: auditPlan.metadata,
  });

  if (auditError) {
    console.error("[automation] failed to record audit log entry", {
      organizationId,
      automationId: "appointment-reminders",
      action: auditPlan.action,
      error: auditError.message,
    });
    return { success: true, config: validation.value, auditWarning: "The configuration was updated, but the audit record could not be saved." };
  }

  return { success: true, config: validation.value };
}

/**
 * Automation Configuration V1: updates estimate-followup's configured
 * follow-up timings. Same pattern as updateAppointmentReminderConfig above -
 * see that function's comment for the shared rationale (admin-only,
 * config-column-only, audit-on-change-only).
 */
export async function updateEstimateFollowupConfig(followup1Hours: number, followup2Hours: number): Promise<ConfigActionState> {
  const session = await requireOrgAdminSession();
  if (!session.ok) {
    return { error: session.error };
  }
  const { supabase, organizationId } = session;

  const validation = validateEstimateFollowupConfig({ followup_1_hours: followup1Hours, followup_2_hours: followup2Hours });
  if (!validation.ok) {
    return { error: validation.error };
  }

  const { data: existingRow } = await supabase
    .from("automation_settings")
    .select("config")
    .eq("organization_id", organizationId)
    .eq("automation_id", "estimate-followup")
    .maybeSingle();

  const previousConfig = readEstimateFollowupConfig(existingRow?.config ?? null);

  const { error: upsertError } = await supabase.from("automation_settings").upsert(
    { organization_id: organizationId, automation_id: "estimate-followup", config: validation.value },
    { onConflict: "organization_id,automation_id" },
  );

  if (upsertError) {
    return { error: "We couldn't update this automation's configuration. Please try again." };
  }

  revalidatePath("/automations/estimate-followup");

  const auditPlan = shouldAuditConfigUpdate(previousConfig, validation.value);
  if (!auditPlan) {
    return { success: true, config: validation.value };
  }

  const { error: auditError } = await supabase.rpc("create_automation_audit_event", {
    p_organization_id: organizationId,
    p_action: auditPlan.action,
    p_automation_id: "estimate-followup",
    p_metadata: auditPlan.metadata,
  });

  if (auditError) {
    console.error("[automation] failed to record audit log entry", {
      organizationId,
      automationId: "estimate-followup",
      action: auditPlan.action,
      error: auditError.message,
    });
    return { success: true, config: validation.value, auditWarning: "The configuration was updated, but the audit record could not be saved." };
  }

  return { success: true, config: validation.value };
}

/**
 * Automation Configuration V2.1/V2.2: updates inbound-customer-reply's
 * configured recent-message context window and (V2.2) whether it respects
 * the organization's business hours. Same pattern as
 * updateAppointmentReminderConfig/updateEstimateFollowupConfig above
 * (admin-only, config-column-only, audit-on-change-only) - see that comment
 * for the shared rationale. recent_message_window only changes how many
 * recent messages are sliced into the AI's context at dispatch time
 * (lib/automation/customer-reply.ts); respect_business_hours only changes
 * whether the outbound gate additionally requires business hours to be
 * open (lib/automation/outbound-gate.ts). Neither touches content safety,
 * opt-out handling, duplicate-send protection, retry, execution/
 * authorization behavior, or n8n/Twilio.
 */
export async function updateInboundCustomerReplyConfig(recentMessageWindow: number, respectBusinessHours: boolean): Promise<ConfigActionState> {
  const session = await requireOrgAdminSession();
  if (!session.ok) {
    return { error: session.error };
  }
  const { supabase, organizationId } = session;

  const validation = validateInboundCustomerReplyConfig({
    recent_message_window: recentMessageWindow,
    respect_business_hours: respectBusinessHours,
  });
  if (!validation.ok) {
    return { error: validation.error };
  }

  const { data: existingRow } = await supabase
    .from("automation_settings")
    .select("config")
    .eq("organization_id", organizationId)
    .eq("automation_id", "inbound-customer-reply")
    .maybeSingle();

  const previousConfig = readInboundCustomerReplyConfig(existingRow?.config ?? null);

  const { error: upsertError } = await supabase.from("automation_settings").upsert(
    { organization_id: organizationId, automation_id: "inbound-customer-reply", config: validation.value },
    { onConflict: "organization_id,automation_id" },
  );

  if (upsertError) {
    return { error: "We couldn't update this automation's configuration. Please try again." };
  }

  revalidatePath("/automations/inbound-customer-reply");

  const auditPlan = shouldAuditConfigUpdate(previousConfig, validation.value);
  if (!auditPlan) {
    return { success: true, config: validation.value };
  }

  const { error: auditError } = await supabase.rpc("create_automation_audit_event", {
    p_organization_id: organizationId,
    p_action: auditPlan.action,
    p_automation_id: "inbound-customer-reply",
    p_metadata: auditPlan.metadata,
  });

  if (auditError) {
    console.error("[automation] failed to record audit log entry", {
      organizationId,
      automationId: "inbound-customer-reply",
      action: auditPlan.action,
      error: auditError.message,
    });
    return { success: true, config: validation.value, auditWarning: "The configuration was updated, but the audit record could not be saved." };
  }

  return { success: true, config: validation.value };
}

/**
 * Automation Configuration V2.2: updates instant-lead-followup's configured
 * respect_business_hours flag. Same pattern as updateAppointmentReminderConfig/
 * updateEstimateFollowupConfig/updateInboundCustomerReplyConfig above
 * (admin-only, config-column-only, audit-on-change-only) - see that comment
 * for the shared rationale. Only changes whether the outbound gate
 * additionally requires business hours to be open before allowing this
 * automation's send (lib/automation/outbound-gate.ts) - no effect on
 * content safety, opt-out handling, duplicate-send protection, retry,
 * execution/authorization behavior, or n8n/Twilio.
 */
export async function updateInstantLeadFollowupConfig(respectBusinessHours: boolean): Promise<ConfigActionState> {
  const session = await requireOrgAdminSession();
  if (!session.ok) {
    return { error: session.error };
  }
  const { supabase, organizationId } = session;

  const validation = validateInstantLeadFollowupConfig({ respect_business_hours: respectBusinessHours });
  if (!validation.ok) {
    return { error: validation.error };
  }

  const { data: existingRow } = await supabase
    .from("automation_settings")
    .select("config")
    .eq("organization_id", organizationId)
    .eq("automation_id", "instant-lead-followup")
    .maybeSingle();

  const previousConfig = readInstantLeadFollowupConfig(existingRow?.config ?? null);

  const { error: upsertError } = await supabase.from("automation_settings").upsert(
    { organization_id: organizationId, automation_id: "instant-lead-followup", config: validation.value },
    { onConflict: "organization_id,automation_id" },
  );

  if (upsertError) {
    return { error: "We couldn't update this automation's configuration. Please try again." };
  }

  revalidatePath("/automations/instant-lead-followup");

  const auditPlan = shouldAuditConfigUpdate(previousConfig, validation.value);
  if (!auditPlan) {
    return { success: true, config: validation.value };
  }

  const { error: auditError } = await supabase.rpc("create_automation_audit_event", {
    p_organization_id: organizationId,
    p_action: auditPlan.action,
    p_automation_id: "instant-lead-followup",
    p_metadata: auditPlan.metadata,
  });

  if (auditError) {
    console.error("[automation] failed to record audit log entry", {
      organizationId,
      automationId: "instant-lead-followup",
      action: auditPlan.action,
      error: auditError.message,
    });
    return { success: true, config: validation.value, auditWarning: "The configuration was updated, but the audit record could not be saved." };
  }

  return { success: true, config: validation.value };
}

/**
 * Automation Configuration V3: updates lost-lead-nurture's configured touch
 * timing. Same pattern as updateAppointmentReminderConfig/
 * updateEstimateFollowupConfig/updateInboundCustomerReplyConfig/
 * updateInstantLeadFollowupConfig above (admin-only, config-column-only,
 * audit-on-change-only) - see that comment for the shared rationale. Only
 * changes the elapsed-time thresholds lib/automation/lead-nurture.ts uses
 * to decide when a lost lead is due its first/second nurture touch - no
 * effect on eligibility rules, lead status checks, idempotency, event
 * creation, execution handling, the outbound gate, content safety,
 * opt-out handling, duplicate-send protection, retry, or n8n/Twilio.
 */
export async function updateLostLeadNurtureConfig(touch1Days: number, touch2Days: number): Promise<ConfigActionState> {
  const session = await requireOrgAdminSession();
  if (!session.ok) {
    return { error: session.error };
  }
  const { supabase, organizationId } = session;

  const validation = validateLostLeadNurtureConfig({ touch_1_days: touch1Days, touch_2_days: touch2Days });
  if (!validation.ok) {
    return { error: validation.error };
  }

  const { data: existingRow } = await supabase
    .from("automation_settings")
    .select("config")
    .eq("organization_id", organizationId)
    .eq("automation_id", "lost-lead-nurture")
    .maybeSingle();

  const previousConfig = readLostLeadNurtureConfig(existingRow?.config ?? null);

  const { error: upsertError } = await supabase.from("automation_settings").upsert(
    { organization_id: organizationId, automation_id: "lost-lead-nurture", config: validation.value },
    { onConflict: "organization_id,automation_id" },
  );

  if (upsertError) {
    return { error: "We couldn't update this automation's configuration. Please try again." };
  }

  revalidatePath("/automations/lost-lead-nurture");

  const auditPlan = shouldAuditConfigUpdate(previousConfig, validation.value);
  if (!auditPlan) {
    return { success: true, config: validation.value };
  }

  const { error: auditError } = await supabase.rpc("create_automation_audit_event", {
    p_organization_id: organizationId,
    p_action: auditPlan.action,
    p_automation_id: "lost-lead-nurture",
    p_metadata: auditPlan.metadata,
  });

  if (auditError) {
    console.error("[automation] failed to record audit log entry", {
      organizationId,
      automationId: "lost-lead-nurture",
      action: auditPlan.action,
      error: auditError.message,
    });
    return { success: true, config: validation.value, auditWarning: "The configuration was updated, but the audit record could not be saved." };
  }

  return { success: true, config: validation.value };
}

/**
 * Automation Configuration V4: updates lead-reactivation's configured touch
 * timing. Same pattern as updateAppointmentReminderConfig/
 * updateEstimateFollowupConfig/updateInboundCustomerReplyConfig/
 * updateInstantLeadFollowupConfig/updateLostLeadNurtureConfig above
 * (admin-only, config-column-only, audit-on-change-only) - see that
 * comment for the shared rationale. Only changes the elapsed-time
 * thresholds lib/automation/lead-reactivation.ts uses to decide when a
 * quiet lead is due its first/second reactivation touch - no effect on
 * eligibility rules, active-engagement checks, open-conversation checks,
 * idempotency, event creation, execution handling, the outbound gate,
 * content safety, opt-out handling, duplicate-send protection, retry, or
 * n8n/Twilio.
 */
export async function updateLeadReactivationConfig(touch1Days: number, touch2Days: number): Promise<ConfigActionState> {
  const session = await requireOrgAdminSession();
  if (!session.ok) {
    return { error: session.error };
  }
  const { supabase, organizationId } = session;

  const validation = validateLeadReactivationConfig({ touch_1_days: touch1Days, touch_2_days: touch2Days });
  if (!validation.ok) {
    return { error: validation.error };
  }

  const { data: existingRow } = await supabase
    .from("automation_settings")
    .select("config")
    .eq("organization_id", organizationId)
    .eq("automation_id", "lead-reactivation")
    .maybeSingle();

  const previousConfig = readLeadReactivationConfig(existingRow?.config ?? null);

  const { error: upsertError } = await supabase.from("automation_settings").upsert(
    { organization_id: organizationId, automation_id: "lead-reactivation", config: validation.value },
    { onConflict: "organization_id,automation_id" },
  );

  if (upsertError) {
    return { error: "We couldn't update this automation's configuration. Please try again." };
  }

  revalidatePath("/automations/lead-reactivation");

  const auditPlan = shouldAuditConfigUpdate(previousConfig, validation.value);
  if (!auditPlan) {
    return { success: true, config: validation.value };
  }

  const { error: auditError } = await supabase.rpc("create_automation_audit_event", {
    p_organization_id: organizationId,
    p_action: auditPlan.action,
    p_automation_id: "lead-reactivation",
    p_metadata: auditPlan.metadata,
  });

  if (auditError) {
    console.error("[automation] failed to record audit log entry", {
      organizationId,
      automationId: "lead-reactivation",
      action: auditPlan.action,
      error: auditError.message,
    });
    return { success: true, config: validation.value, auditWarning: "The configuration was updated, but the audit record could not be saved." };
  }

  return { success: true, config: validation.value };
}

/**
 * Automation Configuration V5: updates appointment-lifecycle's configured
 * respect_business_hours flag. Same pattern as
 * updateInstantLeadFollowupConfig above (admin-only, config-column-only,
 * audit-on-change-only) - see that comment for the shared rationale. Only
 * changes whether the outbound gate additionally requires business hours
 * to be open before allowing this automation's send
 * (lib/automation/outbound-gate.ts) - no effect on content safety,
 * opt-out handling, duplicate-send protection, retry, execution/
 * authorization behavior, or n8n/Twilio.
 */
export async function updateAppointmentLifecycleConfig(respectBusinessHours: boolean): Promise<ConfigActionState> {
  const session = await requireOrgAdminSession();
  if (!session.ok) {
    return { error: session.error };
  }
  const { supabase, organizationId } = session;

  const validation = validateAppointmentLifecycleConfig({ respect_business_hours: respectBusinessHours });
  if (!validation.ok) {
    return { error: validation.error };
  }

  const { data: existingRow } = await supabase
    .from("automation_settings")
    .select("config")
    .eq("organization_id", organizationId)
    .eq("automation_id", "appointment-lifecycle")
    .maybeSingle();

  const previousConfig = readAppointmentLifecycleConfig(existingRow?.config ?? null);

  const { error: upsertError } = await supabase.from("automation_settings").upsert(
    { organization_id: organizationId, automation_id: "appointment-lifecycle", config: validation.value },
    { onConflict: "organization_id,automation_id" },
  );

  if (upsertError) {
    return { error: "We couldn't update this automation's configuration. Please try again." };
  }

  revalidatePath("/automations/appointment-lifecycle");

  const auditPlan = shouldAuditConfigUpdate(previousConfig, validation.value);
  if (!auditPlan) {
    return { success: true, config: validation.value };
  }

  const { error: auditError } = await supabase.rpc("create_automation_audit_event", {
    p_organization_id: organizationId,
    p_action: auditPlan.action,
    p_automation_id: "appointment-lifecycle",
    p_metadata: auditPlan.metadata,
  });

  if (auditError) {
    console.error("[automation] failed to record audit log entry", {
      organizationId,
      automationId: "appointment-lifecycle",
      action: auditPlan.action,
      error: auditError.message,
    });
    return { success: true, config: validation.value, auditWarning: "The configuration was updated, but the audit record could not be saved." };
  }

  return { success: true, config: validation.value };
}

/**
 * Automation Configuration V5: updates job-lifecycle's configured
 * respect_business_hours flag. Same pattern as
 * updateAppointmentLifecycleConfig above.
 */
export async function updateJobLifecycleConfig(respectBusinessHours: boolean): Promise<ConfigActionState> {
  const session = await requireOrgAdminSession();
  if (!session.ok) {
    return { error: session.error };
  }
  const { supabase, organizationId } = session;

  const validation = validateJobLifecycleConfig({ respect_business_hours: respectBusinessHours });
  if (!validation.ok) {
    return { error: validation.error };
  }

  const { data: existingRow } = await supabase
    .from("automation_settings")
    .select("config")
    .eq("organization_id", organizationId)
    .eq("automation_id", "job-lifecycle")
    .maybeSingle();

  const previousConfig = readJobLifecycleConfig(existingRow?.config ?? null);

  const { error: upsertError } = await supabase.from("automation_settings").upsert(
    { organization_id: organizationId, automation_id: "job-lifecycle", config: validation.value },
    { onConflict: "organization_id,automation_id" },
  );

  if (upsertError) {
    return { error: "We couldn't update this automation's configuration. Please try again." };
  }

  revalidatePath("/automations/job-lifecycle");

  const auditPlan = shouldAuditConfigUpdate(previousConfig, validation.value);
  if (!auditPlan) {
    return { success: true, config: validation.value };
  }

  const { error: auditError } = await supabase.rpc("create_automation_audit_event", {
    p_organization_id: organizationId,
    p_action: auditPlan.action,
    p_automation_id: "job-lifecycle",
    p_metadata: auditPlan.metadata,
  });

  if (auditError) {
    console.error("[automation] failed to record audit log entry", {
      organizationId,
      automationId: "job-lifecycle",
      action: auditPlan.action,
      error: auditError.message,
    });
    return { success: true, config: validation.value, auditWarning: "The configuration was updated, but the audit record could not be saved." };
  }

  return { success: true, config: validation.value };
}

/**
 * Automation Configuration V5: updates review-referral-followup's
 * configured respect_business_hours flag. Same pattern as
 * updateAppointmentLifecycleConfig above.
 */
export async function updateReviewReferralFollowupConfig(respectBusinessHours: boolean): Promise<ConfigActionState> {
  const session = await requireOrgAdminSession();
  if (!session.ok) {
    return { error: session.error };
  }
  const { supabase, organizationId } = session;

  const validation = validateReviewReferralFollowupConfig({ respect_business_hours: respectBusinessHours });
  if (!validation.ok) {
    return { error: validation.error };
  }

  const { data: existingRow } = await supabase
    .from("automation_settings")
    .select("config")
    .eq("organization_id", organizationId)
    .eq("automation_id", "review-referral-followup")
    .maybeSingle();

  const previousConfig = readReviewReferralFollowupConfig(existingRow?.config ?? null);

  const { error: upsertError } = await supabase.from("automation_settings").upsert(
    { organization_id: organizationId, automation_id: "review-referral-followup", config: validation.value },
    { onConflict: "organization_id,automation_id" },
  );

  if (upsertError) {
    return { error: "We couldn't update this automation's configuration. Please try again." };
  }

  revalidatePath("/automations/review-referral-followup");

  const auditPlan = shouldAuditConfigUpdate(previousConfig, validation.value);
  if (!auditPlan) {
    return { success: true, config: validation.value };
  }

  const { error: auditError } = await supabase.rpc("create_automation_audit_event", {
    p_organization_id: organizationId,
    p_action: auditPlan.action,
    p_automation_id: "review-referral-followup",
    p_metadata: auditPlan.metadata,
  });

  if (auditError) {
    console.error("[automation] failed to record audit log entry", {
      organizationId,
      automationId: "review-referral-followup",
      action: auditPlan.action,
      error: auditError.message,
    });
    return { success: true, config: validation.value, auditWarning: "The configuration was updated, but the audit record could not be saved." };
  }

  return { success: true, config: validation.value };
}

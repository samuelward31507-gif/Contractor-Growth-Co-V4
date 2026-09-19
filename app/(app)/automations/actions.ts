"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserOrganization } from "@/lib/auth/organization";
import { assertOrgAdmin } from "@/lib/automation/authorization";
import { getAutomationDefinition } from "@/lib/automation/catalog";
import { getAutomationEnabled } from "@/lib/automation/settings";
import { processAppointmentReminders, previewAppointmentReminders, type ReminderPreview } from "@/lib/automation/appointment-reminders";
import { processEstimateFollowups, previewEstimateFollowups, type FollowupPreview } from "@/lib/automation/estimate-followups";

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
const MANUAL_RUN_AUTOMATION_IDS = new Set(["appointment-reminders", "estimate-followups"]);

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

  if (previousEnabled === enabled) {
    // Not a real transition - nothing to audit.
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
    p_action: enabled ? "automation_enabled" : "automation_disabled",
    p_automation_id: automationId,
    p_metadata: { previous_enabled: previousEnabled, new_enabled: enabled },
  });

  if (auditError) {
    console.error("[automation] failed to record audit log entry", {
      organizationId: membership.organizationId,
      automationId,
      action: enabled ? "automation_enabled" : "automation_disabled",
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

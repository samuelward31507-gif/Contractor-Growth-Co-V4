"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserOrganization } from "@/lib/auth/organization";
import { assertOrgAdmin } from "@/lib/automation/authorization";
import { getAutomationDefinition } from "@/lib/automation/catalog";

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

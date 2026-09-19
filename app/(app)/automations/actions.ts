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

  // Audit logging (Phase C, section 9/10) is deliberately NOT implemented
  // here - see the Phase C report for why: audit_log has no client INSERT
  // policy, and the only write pattern this codebase already trusts for a
  // table in that shape is a session-callable SECURITY DEFINER RPC (the
  // same pattern create_automation_event/start_workflow_execution use),
  // which requires a new migration not covered by the approved Phase A
  // schema. Rather than adding a broad client INSERT policy or reaching for
  // service_role to sidestep that design question, this was left as an
  // explicit, reported blocker pending that decision.

  revalidatePath("/automations");
  return { success: true };
}

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserOrganization } from "@/lib/auth/organization";
import { mapIncidentRow, type AutomationIncident, type AutomationIncidentRow } from "@/lib/automation-health/types";

export type IncidentActionState = { ok: true; incident: AutomationIncident } | { ok: false; error: string };

/**
 * Resolves the caller's own session/organization - shared by both actions
 * below. Never accepts an organization id from the caller. Authorization
 * itself (owner/admin only) is enforced inside the two RPCs
 * (acknowledge_automation_incident/resolve_automation_incident - see the
 * automation_health_and_alerting migration), which independently re-derive
 * the incident's real organization_id and re-check is_org_admin() -  this
 * function only needs to confirm a real session exists before making the
 * call, matching the "never trust the caller already checked it" rule every
 * other mutation in this codebase follows.
 */
async function requireSession() {
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

  return { supabase };
}

/**
 * Acknowledge an open incident - owner/admin only, enforced by
 * acknowledge_automation_incident itself. The audit_log row is written
 * atomically inside that same RPC, not as a second, best-effort call - see
 * the migration's own comment for why that is a deliberate improvement over
 * this codebase's usual two-round-trip audit pattern.
 */
export async function acknowledgeIncident(incidentId: string): Promise<IncidentActionState> {
  const { supabase } = await requireSession();

  const { data, error } = await supabase.rpc("acknowledge_automation_incident", { p_incident_id: incidentId }).single();

  if (error || !data) {
    return { ok: false, error: mapIncidentActionError(error?.message) };
  }

  revalidatePath("/automation-health");
  return { ok: true, incident: mapIncidentRow(data as AutomationIncidentRow) };
}

/**
 * Resolve an open or acknowledged incident - owner/admin only, enforced by
 * resolve_automation_incident itself. See acknowledgeIncident's own comment.
 */
export async function resolveIncident(incidentId: string): Promise<IncidentActionState> {
  const { supabase } = await requireSession();

  const { data, error } = await supabase.rpc("resolve_automation_incident", { p_incident_id: incidentId }).single();

  if (error || !data) {
    return { ok: false, error: mapIncidentActionError(error?.message) };
  }

  revalidatePath("/automation-health");
  return { ok: true, incident: mapIncidentRow(data as AutomationIncidentRow) };
}

/** Only a known allowlist of RPC error text is ever forwarded verbatim - matching lib/automation/executions.ts's own mapExecutionRpcError precedent. */
function mapIncidentActionError(message?: string): string {
  const known = new Set(["Not authenticated", "Incident not found", "Not authorized", "Incident cannot be acknowledged from its current status", "Incident cannot be resolved from its current status"]);
  if (message && known.has(message)) return message;
  return "We couldn't update this incident. Please try again.";
}

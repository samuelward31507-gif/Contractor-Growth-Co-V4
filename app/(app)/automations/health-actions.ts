"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserOrganization } from "@/lib/auth/organization";
import { mapIncidentRow, type AutomationIncident, type AutomationIncidentRow } from "@/lib/automation-health/types";

export type IncidentActionState = { ok: true; incident: AutomationIncident } | { ok: false; error: string };

/**
 * Trackpr 2.0 Phase 4: moved from the retired app/(app)/automation-health/
 * route (now a redirect to /automations - see that route's own comment) as
 * part of consolidating Automations + Automation Health into one experience.
 * Behavior is unchanged from the original - only the revalidated path
 * changed to match where incidents are now shown. Authorization is still
 * enforced entirely inside acknowledge_automation_incident/
 * resolve_automation_incident (owner/admin only, re-derives the incident's
 * real organization_id) - this function only confirms a real session exists
 * first, matching every other mutation in this codebase's "never trust the
 * caller already checked it" rule.
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
 * atomically inside that same RPC, not as a second, best-effort call.
 */
export async function acknowledgeIncident(incidentId: string): Promise<IncidentActionState> {
  const { supabase } = await requireSession();

  const { data, error } = await supabase.rpc("acknowledge_automation_incident", { p_incident_id: incidentId }).single();

  if (error || !data) {
    return { ok: false, error: mapIncidentActionError(error?.message) };
  }

  revalidatePath("/automations");
  // HANDOFF-01: this action is now also reachable from the dashboard's own
  // Needs Attention panel (a human_escalation_requested incident), which
  // reads through a separate cached page render.
  revalidatePath("/dashboard");
  return { ok: true, incident: mapIncidentRow(data as AutomationIncidentRow) };
}

/**
 * Resolve an open or acknowledged incident - owner/admin only, enforced by
 * resolve_automation_incident itself.
 */
export async function resolveIncident(incidentId: string): Promise<IncidentActionState> {
  const { supabase } = await requireSession();

  const { data, error } = await supabase.rpc("resolve_automation_incident", { p_incident_id: incidentId }).single();

  if (error || !data) {
    return { ok: false, error: mapIncidentActionError(error?.message) };
  }

  revalidatePath("/automations");
  // HANDOFF-01: see the identical comment on acknowledgeIncident above.
  revalidatePath("/dashboard");
  return { ok: true, incident: mapIncidentRow(data as AutomationIncidentRow) };
}

/** Only a known allowlist of RPC error text is ever forwarded verbatim - matching lib/automation/executions.ts's own mapExecutionRpcError precedent. */
function mapIncidentActionError(message?: string): string {
  const known = new Set(["Not authenticated", "Incident not found", "Not authorized", "Incident cannot be acknowledged from its current status", "Incident cannot be resolved from its current status"]);
  if (message && known.has(message)) return message;
  return "We couldn't update this incident. Please try again.";
}

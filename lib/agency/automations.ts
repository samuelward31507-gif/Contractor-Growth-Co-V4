import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveAgencyOrganizations, type AgencyAuthFailure } from "./queries";
import { getAutomationHealthSummaries } from "@/lib/automation-health/health";
import type { AutomationHealthSummary } from "@/lib/automation-health/types";

/**
 * Client detail 2.0 - per-automation operational state ("Lead Follow-up /
 * Healthy / Last execution: 4 min ago"). getAutomationHealthSummaries
 * already computes exactly this, deterministically, from real incident and
 * execution data (see lib/automation-health/health.ts) - this only adds the
 * agency authorization gate every other agency read already goes through,
 * and confirms the requested organization is one this agency admin is
 * actually authorized to see before calling it.
 */
export type AgencyOrganizationAutomationsResult =
  | { ok: true; automations: AutomationHealthSummary[] }
  | AgencyAuthFailure
  | { ok: false; reason: "not_found" };

export async function getAgencyOrganizationAutomations(
  sessionSupabase: SupabaseClient,
  serviceSupabase: SupabaseClient,
  organizationId: string,
): Promise<AgencyOrganizationAutomationsResult> {
  const resolved = await resolveAgencyOrganizations(sessionSupabase, serviceSupabase);
  if (!resolved.ok) return resolved;

  const isAuthorizedOrg = resolved.organizations.some((org) => org.organizationId === organizationId);
  if (!isAuthorizedOrg) return { ok: false, reason: "not_found" };

  const automations = await getAutomationHealthSummaries(serviceSupabase, organizationId);
  return { ok: true, automations };
}

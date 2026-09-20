import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveAgencyOrganizations, type AgencyAuthFailure } from "./queries";
import { computeSetupChecklist, type OnboardingStage } from "@/lib/onboarding/checklist";
import { getDashboardData } from "@/lib/dashboard/queries";
import type { ActivityItem } from "@/lib/dashboard/queries";

/**
 * Agency Command Center UI review: the two genuinely-missing reads the
 * redesigned overview/client-list needed (onboarding stage per client, and a
 * real cross-client activity feed) - both built by calling existing,
 * unmodified functions once per already-authorized organization, exactly the
 * same N-calls-in-parallel shape lib/agency/queries.ts's own
 * getAgencyOrganizationSnapshots and lib/agency/health.ts's own
 * loadIncidentRollup already use. Neither function here computes anything
 * new; both are gated by the same resolveAgencyOrganizations authorization
 * every other agency read goes through first.
 */

export type OnboardingStageResult =
  | { ok: true; stageByOrg: Map<string, { stage: OnboardingStage; incompleteCount: number }> }
  | AgencyAuthFailure;

export async function getAgencyOnboardingStages(
  sessionSupabase: SupabaseClient,
  serviceSupabase: SupabaseClient,
): Promise<OnboardingStageResult> {
  const resolved = await resolveAgencyOrganizations(sessionSupabase, serviceSupabase);
  if (!resolved.ok) return resolved;

  const entries = await Promise.all(
    resolved.organizations.map(async ({ organizationId }) => {
      const checklist = await computeSetupChecklist(serviceSupabase, organizationId);
      const incompleteCount = checklist.items.filter((item) => !item.complete).length;
      return [organizationId, { stage: checklist.stage, incompleteCount }] as const;
    }),
  );

  return { ok: true, stageByOrg: new Map(entries) };
}

export type AgencyActivityItem = ActivityItem & { organizationId: string; organizationName: string };

export type AgencyActivityResult =
  | { ok: true; items: AgencyActivityItem[]; lastActivityByOrg: Map<string, string> }
  | AgencyAuthFailure;

/**
 * Reuses getDashboardData(...) - the exact same per-organization read the
 * client dashboard itself calls - purely for its already-real recentActivity
 * field (leads created, appointments booked, audit log entries). Nothing is
 * invented: an organization with no activity simply contributes no rows, and
 * an agency with no client activity anywhere returns an empty list rather
 * than a fabricated placeholder. `lastActivityByOrg` is derived from each
 * organization's own full (unsliced) activity list, so a quiet organization's
 * one real event still surfaces in the client list even if it doesn't make
 * the agency-wide top-`limit` feed.
 */
export async function getAgencyRecentActivity(
  sessionSupabase: SupabaseClient,
  serviceSupabase: SupabaseClient,
  limit = 12,
): Promise<AgencyActivityResult> {
  const resolved = await resolveAgencyOrganizations(sessionSupabase, serviceSupabase);
  if (!resolved.ok) return resolved;

  const perOrg = await Promise.all(
    resolved.organizations.map(async ({ organizationId, organizationName }) => {
      const data = await getDashboardData(serviceSupabase, organizationId);
      return { organizationId, items: data.recentActivity.map((item) => ({ ...item, organizationId, organizationName })) };
    }),
  );

  const lastActivityByOrg = new Map<string, string>();
  for (const { organizationId, items } of perOrg) {
    const latest = items[0]?.timestamp;
    if (latest) lastActivityByOrg.set(organizationId, latest);
  }

  const items = perOrg
    .flatMap((org) => org.items)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit);

  return { ok: true, items, lastActivityByOrg };
}

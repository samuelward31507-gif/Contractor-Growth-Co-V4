import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getAgencyBusinessMetrics } from "@/lib/agency/queries";
import { getAgencyHealth, type AgencyOrganizationHealth } from "@/lib/agency/health";
import { pageTitleClass, pageDescriptionClass } from "@/lib/ui/typography";
import { UnauthorizedState } from "./_components/unauthorized-state";
import { EmptyState } from "./_components/empty-state";
import { ErrorState } from "./_components/error-state";
import { OverviewCards } from "./_components/overview-cards";
import { ClientHealthTable } from "./_components/client-health-table";
import { AttentionSection } from "./_components/attention-section";
import { AutomationActivity } from "./_components/automation-activity";
import { AiActivity } from "./_components/ai-activity";

/**
 * Agency Command Center v1 - the first functional operational view, not the
 * Trackpr 2.0 redesign. Reads through the same real backend
 * (lib/agency/queries.ts + lib/agency/health.ts, also reachable over HTTP at
 * /api/agency/overview) that already passed its own security test suite -
 * this page is a Server Component calling those functions directly, the
 * same pattern app/(app)/dashboard/page.tsx already uses for its own
 * lib/dashboard/business-metrics.ts, rather than an unnecessary self-fetch
 * of this app's own API route. No Supabase query happens in the browser,
 * and no metric here is recomputed - every value is read straight off the
 * backend's already-aggregated result.
 */
export default async function AgencyPage() {
  const supabase = await createClient();
  const service = createServiceRoleClient();

  let metrics: Awaited<ReturnType<typeof getAgencyBusinessMetrics>>;
  let health: Awaited<ReturnType<typeof getAgencyHealth>>;

  try {
    [metrics, health] = await Promise.all([getAgencyBusinessMetrics(supabase, service), getAgencyHealth(supabase, service)]);
  } catch {
    return (
      <div className="flex flex-1 flex-col px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
        <ErrorState />
      </div>
    );
  }

  if (!metrics.ok || !health.ok) {
    return (
      <div className="flex flex-1 flex-col px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
        <UnauthorizedState />
      </div>
    );
  }

  if (metrics.organizations.length === 0) {
    return (
      <div className="flex flex-1 flex-col px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
        <EmptyState />
      </div>
    );
  }

  const healthByOrg = new Map<string, AgencyOrganizationHealth>(health.organizations.map((org) => [org.organizationId, org]));
  const attentionOrganizations = health.organizations.filter((org) => org.needsAttention);

  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <div>
        <h1 className={pageTitleClass}>Agency Command Center</h1>
        <p className={`mt-1.5 ${pageDescriptionClass}`}>Contractor Growth Co. - {metrics.organizations.length} client organization{metrics.organizations.length === 1 ? "" : "s"}.</p>
      </div>

      <OverviewCards summary={metrics.summary} />
      <ClientHealthTable organizations={metrics.organizations} healthByOrg={healthByOrg} />
      <AttentionSection organizations={attentionOrganizations} stuck={health.stuck} />
      <AutomationActivity summary={metrics.summary} stuckCount={health.stuck.length} />
      <AiActivity summary={metrics.summary} aiTokenUsageUnavailable={metrics.dataQuality.aiTokenUsageUnavailable} />
    </div>
  );
}

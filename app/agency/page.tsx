import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getAgencyBusinessMetrics } from "@/lib/agency/queries";
import { getAgencyHealth, type AgencyOrganizationHealth } from "@/lib/agency/health";
import { getAgencyOnboardingStages, getAgencyRecentActivity } from "@/lib/agency/operations";
import { pageTitleClass, pageDescriptionClass, sectionLabelClass } from "@/lib/ui/typography";
import { UnauthorizedState } from "./_components/unauthorized-state";
import { ErrorState } from "./_components/error-state";
import { NeedsAttention } from "./_components/needs-attention";
import { ClientOperations, type ClientRow } from "./_components/client-operations";
import { SystemHealth } from "./_components/system-health";
import { AgencyActivity } from "./_components/agency-activity";
import { Row } from "./_components/row";
import { formatCount } from "./_components/format";

/**
 * Agency Command Center UI review: the whole page now answers the five
 * questions an agency admin opens it to check - client count, who needs
 * attention, whether anything is operationally broken, where each client is
 * in onboarding/live status, and what recently happened - via typography and
 * dividers (same visual system as the redesigned client dashboard), not a
 * wall of bordered stat cards. Every read is still the exact same
 * already-authorized backend (lib/agency/queries.ts, lib/agency/health.ts)
 * plus the two small additive reads in lib/agency/operations.ts - no
 * authorization logic changed, no new database policy, no client-side fetch.
 */
export default async function AgencyPage() {
  const supabase = await createClient();
  const service = createServiceRoleClient();

  let metrics: Awaited<ReturnType<typeof getAgencyBusinessMetrics>>;
  let health: Awaited<ReturnType<typeof getAgencyHealth>>;
  let stages: Awaited<ReturnType<typeof getAgencyOnboardingStages>>;
  let activity: Awaited<ReturnType<typeof getAgencyRecentActivity>>;

  try {
    [metrics, health, stages, activity] = await Promise.all([
      getAgencyBusinessMetrics(supabase, service),
      getAgencyHealth(supabase, service),
      getAgencyOnboardingStages(supabase, service),
      getAgencyRecentActivity(supabase, service),
    ]);
  } catch {
    return (
      <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
        <ErrorState />
      </div>
    );
  }

  if (!metrics.ok || !health.ok || !stages.ok || !activity.ok) {
    return (
      <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
        <UnauthorizedState />
      </div>
    );
  }

  const healthByOrg = new Map<string, AgencyOrganizationHealth>(health.organizations.map((org) => [org.organizationId, org]));
  const attentionOrganizations = health.organizations.filter((org) => org.needsAttention);

  const rows: ClientRow[] = metrics.organizations.map((org) => {
    const stageInfo = stages.stageByOrg.get(org.organizationId);
    return {
      organization: org,
      health: healthByOrg.get(org.organizationId),
      stage: stageInfo?.stage ?? "new",
      incompleteCount: stageInfo?.incompleteCount ?? 0,
      lastActivityAt: activity.lastActivityByOrg.get(org.organizationId) ?? null,
    };
  });

  const liveCount = rows.filter((row) => row.stage === "live").length;
  const settingUpCount = rows.length - liveCount;

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
      <div>
        <p className={sectionLabelClass}>Overview</p>
        <h1 className={`mt-1.5 ${pageTitleClass}`}>Agency Command Center</h1>
        <p className={`mt-1.5 ${pageDescriptionClass}`}>
          Contractor Growth Co. · {formatCount(metrics.organizations.length)} client organization{metrics.organizations.length === 1 ? "" : "s"}
        </p>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-3 border-y border-slate-200 py-4">
        <Row label="Clients" value={formatCount(rows.length)} />
        <Row label="Needs attention" value={formatCount(attentionOrganizations.length)} tone={attentionOrganizations.length > 0 ? "danger" : "default"} />
        <Row label="Live" value={formatCount(liveCount)} />
        <Row label="Setting up" value={formatCount(settingUpCount)} />
        <Row
          label="System health"
          value={`${formatCount(health.incidentRollup.organizationsHealthy)}/${formatCount(rows.length)} healthy`}
          tone={health.incidentRollup.organizationsUnhealthy > 0 ? "danger" : health.incidentRollup.organizationsDegraded > 0 ? "warning" : "default"}
        />
      </div>

      <div className="mt-8">
        <NeedsAttention organizations={attentionOrganizations} stuck={health.stuck} />
      </div>

      <div className="mt-8 border-t border-slate-200 pt-8">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Clients</p>
        <div className="mt-3">
          <ClientOperations rows={rows} />
        </div>
      </div>

      <div className="mt-8 border-t border-slate-200 pt-8">
        <SystemHealth rollup={health.incidentRollup} schedulerHeartbeat={health.schedulerHeartbeat} />
      </div>

      <div className="mt-8 border-t border-slate-200 pt-8">
        <AgencyActivity items={activity.items} />
      </div>
    </div>
  );
}

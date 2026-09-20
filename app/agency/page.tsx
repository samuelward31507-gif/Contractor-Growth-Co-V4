import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getAgencyBusinessMetrics } from "@/lib/agency/queries";
import { getAgencyHealth, type AgencyOrganizationHealth } from "@/lib/agency/health";
import { getAgencyOnboardingStages, getAgencyRecentActivity, getAgencyOperationsToday } from "@/lib/agency/operations";
import { getAgencyEscalatedConversations } from "@/lib/agency/communication";
import { getAgencyNeedsAttentionItems } from "@/lib/agency/needs-attention";
import { pageTitleClass, pageDescriptionClass, sectionLabelClass } from "@/lib/ui/typography";
import type { OnboardingStage } from "@/lib/onboarding/checklist";
import { UnauthorizedState } from "./_components/unauthorized-state";
import { ErrorState } from "./_components/error-state";
import { NeedsAttention } from "./_components/needs-attention";
import { ClientOperations, type ClientRow } from "./_components/client-operations";
import { SystemHealth } from "./_components/system-health";
import { AgencyActivity } from "./_components/agency-activity";
import { OnboardingPipeline, type PipelineClient } from "./_components/onboarding-pipeline";
import { AgencyToolbar } from "./_components/agency-toolbar";
import { Row } from "./_components/row";
import { formatCount } from "./_components/format";

export type AgencyClientFilter = "all" | "attention" | "live" | "onboarding";
const VALID_FILTERS = new Set<string>(["all", "attention", "live", "onboarding"]);

function normalizeFilter(value: string | undefined): AgencyClientFilter {
  return value && VALID_FILTERS.has(value) ? (value as AgencyClientFilter) : "all";
}

function matchesFilter(row: ClientRow, filter: AgencyClientFilter): boolean {
  switch (filter) {
    case "attention":
      return row.health?.needsAttention === true;
    case "live":
      return row.stage === "live";
    case "onboarding":
      return row.stage !== "live";
    case "all":
    default:
      return true;
  }
}

/**
 * Agency Command Center 2.0: the overview still answers the same five
 * questions the Phase-1 redesign built it around - client count, who needs
 * attention, is anything broken, where each client is in onboarding, and
 * what happened recently - via typography and dividers, not a wall of
 * bordered stat cards. This pass adds real operational depth on top of that
 * same foundation: a richer per-issue Needs Attention feed
 * (lib/agency/needs-attention.ts), "today" activity counts, a client
 * operations table with real business counts per row, an onboarding
 * pipeline grouped by real stage, and organization-name search / status
 * filtering (both over already-fetched, already-authorized data - no new
 * cross-client search index). Every read is still gated by the exact same
 * resolveAgencyOrganizations authorization chain every agency function has
 * always required.
 */
export default async function AgencyPage({ searchParams }: PageProps<"/agency">) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : "";
  const filter = normalizeFilter(typeof params.filter === "string" ? params.filter : undefined);

  const supabase = await createClient();
  const service = createServiceRoleClient();

  let metrics: Awaited<ReturnType<typeof getAgencyBusinessMetrics>>;
  let health: Awaited<ReturnType<typeof getAgencyHealth>>;
  let stages: Awaited<ReturnType<typeof getAgencyOnboardingStages>>;
  let activity: Awaited<ReturnType<typeof getAgencyRecentActivity>>;
  let today: Awaited<ReturnType<typeof getAgencyOperationsToday>>;
  let escalations: Awaited<ReturnType<typeof getAgencyEscalatedConversations>>;
  let needsAttention: Awaited<ReturnType<typeof getAgencyNeedsAttentionItems>>;

  try {
    [metrics, health, stages, activity, today, escalations, needsAttention] = await Promise.all([
      getAgencyBusinessMetrics(supabase, service),
      getAgencyHealth(supabase, service),
      getAgencyOnboardingStages(supabase, service),
      getAgencyRecentActivity(supabase, service),
      getAgencyOperationsToday(supabase, service),
      getAgencyEscalatedConversations(supabase, service),
      getAgencyNeedsAttentionItems(supabase, service),
    ]);
  } catch {
    return (
      <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
        <ErrorState />
      </div>
    );
  }

  if (!metrics.ok || !health.ok || !stages.ok || !activity.ok || !today.ok || !escalations.ok || !needsAttention.ok) {
    return (
      <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
        <UnauthorizedState />
      </div>
    );
  }

  const healthByOrg = new Map<string, AgencyOrganizationHealth>(health.organizations.map((org) => [org.organizationId, org]));

  const allRows: ClientRow[] = metrics.organizations.map((org) => {
    const stageInfo = stages.stageByOrg.get(org.organizationId);
    return {
      organization: org,
      health: healthByOrg.get(org.organizationId),
      stage: stageInfo?.stage ?? "new",
      incompleteCount: stageInfo?.incompleteCount ?? 0,
      lastActivityAt: activity.lastActivityByOrg.get(org.organizationId) ?? null,
      escalationCount: escalations.countByOrg.get(org.organizationId) ?? 0,
    };
  });

  const liveCount = allRows.filter((row) => row.stage === "live").length;
  const settingUpCount = allRows.length - liveCount;

  const term = query.trim().toLowerCase();
  const rows = allRows
    .filter((row) => (term ? row.organization.organizationName.toLowerCase().includes(term) : true))
    .filter((row) => matchesFilter(row, filter));

  const byStage: Record<OnboardingStage, PipelineClient[]> = { new: [], configuring: [], testing: [], ready: [], live: [] };
  for (const row of allRows) {
    byStage[row.stage].push({ organizationId: row.organization.organizationId, organizationName: row.organization.organizationName });
  }

  const smsFailureCount = (metrics.summary.messagesByStatus.failed ?? 0) + (metrics.summary.messagesByStatus.undelivered ?? 0);

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
        <Row label="Clients" value={formatCount(allRows.length)} />
        <Row label="Needs attention" value={formatCount(needsAttention.items.length)} tone={needsAttention.items.length > 0 ? "danger" : "default"} />
        <Row label="Live" value={formatCount(liveCount)} />
        <Row label="Setting up" value={formatCount(settingUpCount)} />
        <Row label="Leads today" value={formatCount(today.leadsToday)} />
        <Row label="Appointments today" value={formatCount(today.appointmentsToday)} />
        <Row
          label="System health"
          value={`${formatCount(health.incidentRollup.organizationsHealthy)}/${formatCount(allRows.length)} healthy`}
          tone={health.incidentRollup.organizationsUnhealthy > 0 ? "danger" : health.incidentRollup.organizationsDegraded > 0 ? "warning" : "default"}
        />
      </div>

      <div className="mt-8">
        <NeedsAttention items={needsAttention.items} />
      </div>

      <div className="mt-8 border-t border-slate-200 pt-8">
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Clients</p>
          <AgencyToolbar initialQuery={query} initialFilter={filter} />
        </div>
        <div className="mt-3">
          <ClientOperations rows={rows} totalCount={allRows.length} />
        </div>
      </div>

      <div className="mt-8 border-t border-slate-200 pt-8">
        <p className={sectionLabelClass}>Onboarding pipeline</p>
        <OnboardingPipeline byStage={byStage} />
      </div>

      <div className="mt-8 border-t border-slate-200 pt-8">
        <SystemHealth
          rollup={health.incidentRollup}
          schedulerHeartbeat={health.schedulerHeartbeat}
          smsFailureCount={smsFailureCount}
          aiEscalationCount={escalations.conversations.length}
        />
      </div>

      <div className="mt-8 border-t border-slate-200 pt-8">
        <AgencyActivity items={activity.items} />
      </div>
    </div>
  );
}

import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { AlertCircle, AlertTriangle, BarChart3, Building2, CalendarCheck, ChevronRight, Coins, HeartPulse, Receipt, TrendingUp, UserPlus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getAgencyBusinessMetrics } from "@/lib/agency/queries";
import { getAgencyHealth, type AgencyOrganizationHealth } from "@/lib/agency/health";
import { getAgencyOnboardingStages, getAgencyRecentActivity, getAgencyOperationsToday } from "@/lib/agency/operations";
import { getAgencyEscalatedConversations } from "@/lib/agency/communication";
import { getAgencyNeedsAttentionItems } from "@/lib/agency/needs-attention";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";
import { PageHeader } from "@/lib/ui/page-header";
import { StatCard, StatGrid } from "@/lib/ui/stat-card";
import type { OnboardingStage } from "@/lib/onboarding/checklist";
import { UnauthorizedState } from "./_components/unauthorized-state";
import { ErrorState } from "./_components/error-state";
import { NeedsAttention } from "./_components/needs-attention";
import { ClientOperations, type ClientRow } from "./_components/client-operations";
import { SystemHealth } from "./_components/system-health";
import { AgencyActivity } from "./_components/agency-activity";
import { OnboardingPipeline, type PipelineClient } from "./_components/onboarding-pipeline";
import { AgencyToolbar } from "./_components/agency-toolbar";
import { AgencySection } from "./_components/section";
import { formatCount } from "./_components/format";

const OVERVIEW_EYEBROW = "Agency · Overview";
const OVERVIEW_TITLE = "Agency Command Center";

/** The deeper agency pages - real routes, each with its own live figures. */
const INTELLIGENCE_LINKS: { href: string; title: string; description: string; icon: LucideIcon }[] = [
  {
    href: "/agency/expansion",
    title: "Expansion Opportunities",
    description: "Estimate recovery, reactivation, and other service opportunities across your managed clients.",
    icon: TrendingUp,
  },
  {
    href: "/agency/usage",
    title: "Client Usage",
    description: "Messaging, AI, and automation activity across your managed clients — usage visibility, not billing.",
    icon: BarChart3,
  },
  {
    href: "/agency/revenue",
    title: "Revenue",
    description: "Contractor Growth Co.’s own revenue from managed clients, recorded from real Stripe events.",
    icon: Receipt,
  },
  {
    href: "/agency/costs",
    title: "Costs",
    description: "Provider cost from managed clients - real usage at a real historical rate, never an estimate.",
    icon: Coins,
  },
];

export type AgencyClientFilter = "all" | "attention" | "live" | "onboarding";
const VALID_FILTERS = new Set<string>(["all", "attention", "live", "onboarding"]);

function normalizeFilter(value: string | undefined): AgencyClientFilter {
  return value && VALID_FILTERS.has(value) ? (value as AgencyClientFilter) : "all";
}

function matchesFilter(row: ClientRow, filter: AgencyClientFilter): boolean {
  switch (filter) {
    case "attention":
      // Phase 3E: the same distinct-client set the header counts.
      return row.needsAttention;
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
 * what happened recently. Agency overview redesign: laid out in the client
 * app's design system (Money, Today) - the shared page container, a
 * PageHeader with an eyebrow, the headline figures as a StatGrid of
 * StatCards, and each section as a titled card - presentation only; every
 * read, calculation and authorization check below is unchanged. On top of
 * that foundation: a richer per-issue Needs Attention feed
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
      <div className={`${PAGE_CONTAINER_CLASS} gap-8 ${PAGE_MAX_WIDTH_CLASS}`}>
        <PageHeader eyebrow={OVERVIEW_EYEBROW} title={OVERVIEW_TITLE} />
        <ErrorState retryHref="/agency" />
      </div>
    );
  }

  if (!metrics.ok || !health.ok || !stages.ok || !activity.ok || !today.ok || !escalations.ok || !needsAttention.ok) {
    // Never passes agency data into the permission state - only the static page title.
    return (
      <div className={`${PAGE_CONTAINER_CLASS} gap-8 ${PAGE_MAX_WIDTH_CLASS}`}>
        <PageHeader eyebrow={OVERVIEW_EYEBROW} title={OVERVIEW_TITLE} />
        <UnauthorizedState />
      </div>
    );
  }

  const healthByOrg = new Map<string, AgencyOrganizationHealth>(health.organizations.map((org) => [org.organizationId, org]));

  // Usability audit fix (#4, Agency Clients co-primary): the Clients table's
  // new "Next action" column reuses NeedsAttention's own per-item `why` text
  // - the first (most urgent, since needsAttention.items is already severity-
  // then-recency ordered) open item per organization - never invented copy.
  // An organization with no open item gets `null`, rendered as a plain dash.
  const nextActionByOrg = new Map<string, string>();
  for (const item of needsAttention.items) {
    if (!nextActionByOrg.has(item.organizationId)) {
      nextActionByOrg.set(item.organizationId, item.why);
    }
  }

  // Phase 3E: one distinct-client set - a client's own health flag or any
  // open feed item (lib/agency/needs-attention.ts) - drives the header count,
  // the "attention" filter and each row's attention state alike.
  const attentionOrganizationIds = new Set(needsAttention.attentionOrganizationIds);

  const allRows: ClientRow[] = metrics.organizations.map((org) => {
    const stageInfo = stages.stageByOrg.get(org.organizationId);
    return {
      organization: org,
      health: healthByOrg.get(org.organizationId),
      needsAttention: attentionOrganizationIds.has(org.organizationId),
      stage: stageInfo?.stage ?? "new",
      incompleteCount: stageInfo?.incompleteCount ?? 0,
      lastActivityAt: activity.lastActivityByOrg.get(org.organizationId) ?? null,
      // Phase 3E: null when the escalation read failed - never "no escalations".
      escalationCount: escalations.failed ? null : (escalations.countByOrg.get(org.organizationId) ?? 0),
      nextAction: nextActionByOrg.get(org.organizationId) ?? null,
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

  const attentionClientCount = allRows.filter((row) => row.needsAttention).length;
  const hasAttentionClients = attentionClientCount > 0;
  // Phase 3E: any read failure behind this page - agency health (Phase 4C,
  // 2J, 2K, heartbeat, incidents), escalations, or a client's shared metrics
  // snapshot - is disclosed, never shown as a clean, healthy page.
  const snapshotPartialData = metrics.organizations.some((org) => org.metrics.partialData || org.metrics.reviewReferralUnavailable || org.aiFailed);
  const pagePartialData = health.partialData || escalations.failed || needsAttention.partialData || snapshotPartialData;

  return (
    <div className={`${PAGE_CONTAINER_CLASS} gap-8 ${PAGE_MAX_WIDTH_CLASS}`}>
      <PageHeader
        eyebrow={OVERVIEW_EYEBROW}
        title={OVERVIEW_TITLE}
        description={`Contractor Growth Co. · ${formatCount(metrics.organizations.length)} client organization${metrics.organizations.length === 1 ? "" : "s"}`}
      />

      {/* Trackpr 2.0, Phase 4C (P2 #1): a real Postgrest error on the
          stuck-execution, calendar-health, or payment/pause read must never
          silently render as "nothing wrong" in the System Health section
          below - see getAgencyHealth's own AgencyHealthResult.partialData
          comment. Phase 3E: also escalations, the feed, and the shared
          metrics snapshot (pagePartialData above). */}
      {pagePartialData ? (
        <div role="status" className="flex items-start gap-2.5 rounded-xl border border-warning-border bg-warning-muted px-4 py-2.5 text-sm text-warning-text">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>Some information is temporarily unavailable, so figures and lists below may be incomplete - a missing issue doesn&rsquo;t mean everything is fine. Please try again.</p>
        </div>
      ) : null}

      {/*
        Agency overview redesign: the headline figures as the client app's
        StatGrid/StatCard (Money, Today) - every value is the same real
        number the old reference rail and header hero showed, computed the
        same way above. "Needs attention" counts distinct clients (the shared
        attention set), never feed items, and links to the real filtered
        Clients list when there is anyone to review.
      */}
      <section aria-label="Agency at a glance">
        <StatGrid columns={5}>
          <StatCard
            label="Needs attention"
            value={formatCount(attentionClientCount)}
            description={hasAttentionClients ? `client${attentionClientCount === 1 ? "" : "s"} to review` : pagePartialData ? "Some data is unavailable" : "All clients operating normally"}
            tone={hasAttentionClients ? "danger" : pagePartialData ? "warning" : "success"}
            icon={AlertTriangle}
          />
          <StatCard label="Clients" value={formatCount(allRows.length)} description={`${formatCount(liveCount)} live · ${formatCount(settingUpCount)} setting up`} icon={Building2} />
          <StatCard label="Leads today" value={formatCount(today.leadsToday)} description="Across every client" icon={UserPlus} />
          <StatCard label="Appointments today" value={formatCount(today.appointmentsToday)} description="Across every client" icon={CalendarCheck} />
          <StatCard
            label="System health"
            value={`${formatCount(health.incidentRollup.organizationsHealthy)}/${formatCount(allRows.length)}`}
            description="organizations healthy"
            tone={health.incidentRollup.organizationsUnhealthy > 0 ? "danger" : health.incidentRollup.organizationsDegraded > 0 ? "warning" : "neutral"}
            icon={HeartPulse}
          />
        </StatGrid>
      </section>

      <NeedsAttention items={needsAttention.items} partialData={pagePartialData} />

      <AgencySection
        id="clients"
        title="Clients"
        count={allRows.length}
        description={rows.length === allRows.length ? "Every client organization you manage · open one for its full detail" : `Showing ${formatCount(rows.length)} of ${formatCount(allRows.length)}`}
      >
        {allRows.length > 0 ? (
          <div className="px-4 pb-4 sm:px-5">
            <AgencyToolbar initialQuery={query} initialFilter={filter} />
          </div>
        ) : null}
        <ClientOperations rows={rows} totalCount={allRows.length} />
      </AgencySection>

      {/*
        Trackpr Phase 5A/5B/5D-1 links to Expansion, Usage, Revenue and
        Costs - deliberately NOT live summaries with their own numbers.
        Computing live numbers here would mean this already-heavy overview
        page (7 parallel agency reads on every load) runs each page's own
        full per-organization fan-out a second time, for numbers whose only
        real destination is that dedicated page. A plain link keeps this
        page's existing query cost unchanged; the real numbers live on
        /agency/expansion, /agency/usage, /agency/revenue and /agency/costs,
        each fetched exactly once.
      */}
      <AgencySection id="deeper-intelligence" title="Deeper intelligence" description="Each opens its own page with the full, live figures.">
        <ul className="grid grid-cols-1 border-t border-line sm:grid-cols-2">
          {INTELLIGENCE_LINKS.map((link) => (
            <li key={link.href} className="border-b border-line last:border-b-0 sm:odd:border-r sm:[&:nth-last-child(-n+2)]:border-b-0">
              <Link
                href={link.href}
                className="group flex h-full min-h-12 items-center gap-3 px-4 py-3.5 transition-colors hover:bg-hover focus:outline-none focus-visible:inset-ring-2 focus-visible:inset-ring-accent/40 sm:px-5"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-inset text-ink-3 inset-ring inset-ring-line">
                  <link.icon className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink">{link.title}</span>
                  <span className="mt-0.5 block text-xs text-ink-3">{link.description}</span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-ink-4 transition-colors group-hover:text-ink-3" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      </AgencySection>

      {/* The secondary/reference tier - onboarding and system health side by
          side on wide screens, then recent activity. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
        <OnboardingPipeline byStage={byStage} />
        <SystemHealth
          rollup={health.incidentRollup}
          schedulerHeartbeat={health.schedulerHeartbeat}
          smsFailureCount={smsFailureCount}
          aiEscalationCount={escalations.failed ? null : escalations.conversations.length}
          paymentIssueCount={health.organizations.filter((org) => org.paymentStatus === "suspended" || org.paymentStatus === "cancelled").length}
          automationPausedCount={health.organizations.filter((org) => org.automationPaused).length}
        />
      </div>

      <AgencyActivity items={activity.items} />
    </div>
  );
}

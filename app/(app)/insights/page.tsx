import { redirect } from "next/navigation";
import { getRequestMembership, getRequestSupabase } from "@/lib/auth/request-context";
import { AlertCircle } from "lucide-react";
import {
  ACTIVITY_PAGE_SIZE,
  getActivityEntries,
  getActivitySummary,
} from "@/lib/activity/queries";
import { getBusinessMetricsSnapshot } from "@/lib/bi/metrics";
import { resolveDateRange } from "@/lib/bi/queries";
import { getLeadsCreatedPerDay } from "@/lib/bi/series";
import type { DateRangePreset } from "@/lib/bi/types";
import { getRepeatCustomerSummaryResult } from "@/lib/customers/lifecycle";
import { getCachedBusinessInsights } from "@/lib/dashboard/business-metrics";
import { PageHeader } from "@/lib/ui/page-header";
import { ActivityEmptyState } from "./_components/activity-empty-state";
import { ActivityTimeline } from "./_components/activity-timeline";
import { ActivityToolbar } from "./_components/activity-toolbar";
import { RangeTabs } from "./_components/range-tabs";
import { TrendSection } from "./_components/trend-section";
import {
  RevenuePaymentsPanel,
  LeadsConversionPanel,
  PipelineLeaksPanel,
  EstimatesJobsPanel,
  ResponseCommunicationPanel,
  SchedulingPanel,
  RetentionPanel,
  AutomationPanel,
  CalculationsPanel,
} from "./_components/business-metrics-sections";
import { Panel } from "./_components/metric-panel";
import { ObservationsPanel } from "./_components/observations";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";

const VALID_RANGES = new Set<string>(["today", "last7Days", "last30Days", "currentMonth", "previousMonth", "allTime"]);

function normalizeRange(value: string | undefined): DateRangePreset {
  return value && VALID_RANGES.has(value) ? (value as DateRangePreset) : "last30Days";
}

export default async function InsightsPage({ searchParams }: PageProps<"/insights">) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : "";
  const entityType = typeof params.entityType === "string" ? params.entityType : "all";
  const from = typeof params.from === "string" ? params.from : "";
  const to = typeof params.to === "string" ? params.to : "";
  const range = normalizeRange(typeof params.range === "string" ? params.range : undefined);
  const requestedLimit = typeof params.limit === "string" ? Number.parseInt(params.limit, 10) : NaN;
  const limit =
    Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, ACTIVITY_PAGE_SIZE * 10)
      : ACTIVITY_PAGE_SIZE;

  const supabase = await getRequestSupabase();
  const { user, membership } = await getRequestMembership();

  if (!user) {
    redirect("/login");
  }

  if (!membership) {
    redirect("/onboarding");
  }

  // Phase 6 (Trend chart pass): a day-bucketed chart needs concrete bounds -
  // "all time" (the one range-tabs preset resolveDateRange leaves
  // unbounded) falls back to the same last-30-days window the range tabs
  // themselves offer, purely for the chart's own x-axis. This never changes
  // what "all time" means for every other number on this page (snapshot is
  // still computed against the real, unbounded `range`) - only the trend
  // chart's own bounded window differs from it in that one case.
  const resolvedRange = resolveDateRange(range);
  const fallbackRange = resolveDateRange("last30Days");
  const chartRangeIsFallback = !(resolvedRange.from && resolvedRange.to);
  const chartRange = chartRangeIsFallback ? { from: fallbackRange.from!, to: fallbackRange.to! } : { from: resolvedRange.from!, to: resolvedRange.to! };

  const [summary, activityPage, snapshot, repeatCustomerSummary, leadSeries, cachedInsights] = await Promise.all([
    getActivitySummary(supabase, membership.organizationId),
    getActivityEntries(supabase, membership.organizationId, { query, entityType, from, to }, limit),
    getBusinessMetricsSnapshot(supabase, membership.organizationId, range),
    // Pass 3: deliberately not range-scoped (see RepeatCustomerSection's own
    // documentation) - "has this customer come back, ever" ignores whatever
    // period the range tabs above have selected.
    getRepeatCustomerSummaryResult(supabase, membership.organizationId),
    getLeadsCreatedPerDay(supabase, membership.organizationId, chartRange),
    // The persisted AI observations (moved here from Today) - a read of the
    // latest stored report only; generating one stays a deliberate click.
    getCachedBusinessInsights(supabase, membership.organizationId),
  ]);

  const hasActiveFilters = Boolean(query.trim()) || entityType !== "all" || Boolean(from) || Boolean(to);

  // Shared by both the range tabs (switch period) and "Load more" (fetch
  // more timeline rows) - every link on this page preserves every OTHER
  // param it doesn't itself control, so switching one control never resets
  // the other (see activity-toolbar.tsx's own matching discipline).
  function buildHref(overrides: { range?: DateRangePreset; limit?: number }) {
    const nextParams = new URLSearchParams();
    if (query.trim()) nextParams.set("q", query.trim());
    if (entityType !== "all") nextParams.set("entityType", entityType);
    if (from) nextParams.set("from", from);
    if (to) nextParams.set("to", to);
    nextParams.set("range", overrides.range ?? range);
    if (overrides.limit) nextParams.set("limit", String(overrides.limit));
    return `/insights?${nextParams.toString()}`;
  }

  const loadMoreHref = buildHref({ limit: limit + ACTIVITY_PAGE_SIZE });

  return (
    <div className={`${PAGE_CONTAINER_CLASS} gap-8 ${PAGE_MAX_WIDTH_CLASS}`}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <PageHeader title="Analytics" description="How the business is performing over time." />
        <RangeTabs current={range} buildHref={(nextRange) => buildHref({ range: nextRange })} />
      </div>

      {/* A real Postgrest error on one of the BI snapshot's core reads (or
          repeatCustomerSummary's) is disclosed, never rendered as a
          confident $0/0%/"no data" on the page whose purpose is "how is my
          business doing." */}
      {snapshot.partialData || repeatCustomerSummary.failed ? (
        <div className="flex items-start gap-2.5 rounded-lg border border-warning-border bg-warning-muted px-4 py-2.5 text-sm text-warning-text">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>Some information is temporarily unavailable. Please try again.</p>
        </div>
      ) : null}

      {/* One dashboard of bordered panels at one even gap. Each panel's
          header states the scope its numbers cover - the selected period,
          "As of today" or "All time" - and every definition the page used
          to repeat lives once, collapsed, in CalculationsPanel. */}
      <div className="flex flex-col gap-6">
        <RevenuePaymentsPanel snapshot={snapshot} />
        <ObservationsPanel cached={cachedInsights} />
        <LeadsConversionPanel
          snapshot={snapshot}
          trend={<TrendSection series={leadSeries.data} failed={leadSeries.failed} isFallbackWindow={chartRangeIsFallback} />}
        />
        <PipelineLeaksPanel snapshot={snapshot} />
        <EstimatesJobsPanel snapshot={snapshot} />
        <ResponseCommunicationPanel snapshot={snapshot} />
        <SchedulingPanel snapshot={snapshot} />
        <RetentionPanel snapshot={snapshot} repeat={repeatCustomerSummary} />
        <AutomationPanel snapshot={snapshot} />
        <CalculationsPanel snapshot={snapshot} />

        <Panel id="activity" title="Activity timeline" scope="Important actions and events">
          {summary.total === 0 ? (
            <div className="px-4 py-4 sm:px-5">
              <ActivityEmptyState />
            </div>
          ) : (
            <div className="px-4 py-4 sm:px-5">
              <ActivityToolbar initialQuery={query} initialEntityType={entityType} initialFrom={from} initialTo={to} />
              <div className="mt-5">
                <ActivityTimeline
                  entries={activityPage.entries}
                  currentUserId={user.id}
                  hasActiveFilters={hasActiveFilters}
                  hasMore={activityPage.hasMore}
                  loadMoreHref={loadMoreHref}
                />
              </div>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

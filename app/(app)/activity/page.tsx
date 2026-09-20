import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import {
  ACTIVITY_PAGE_SIZE,
  getActivityEntries,
  getActivitySummary,
} from "@/lib/activity/queries";
import { getBusinessMetricsSnapshot } from "@/lib/bi/metrics";
import type { DateRangePreset } from "@/lib/bi/types";
import { pageTitleClass, pageDescriptionClass, sectionLabelClass, primarySectionTitleClass, metaClass } from "@/lib/ui/typography";
import { ActivityEmptyState } from "./_components/activity-empty-state";
import { ActivitySummaryCards } from "./_components/activity-summary";
import { ActivityTimeline } from "./_components/activity-timeline";
import { ActivityToolbar } from "./_components/activity-toolbar";
import { RangeTabs } from "./_components/range-tabs";
import {
  LeadsPipelineSection,
  EstimatesSection,
  JobsSection,
  AppointmentsSection,
  FollowUpSection,
  CommunicationSection,
  AiActivitySection,
  AutomationSection,
  DataQualitySection,
} from "./_components/business-metrics-sections";

const VALID_RANGES = new Set<string>(["today", "last7Days", "last30Days", "currentMonth", "previousMonth", "allTime"]);

function normalizeRange(value: string | undefined): DateRangePreset {
  return value && VALID_RANGES.has(value) ? (value as DateRangePreset) : "last30Days";
}

export default async function ActivityPage({ searchParams }: PageProps<"/activity">) {
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

  const [summary, activityPage, snapshot] = await Promise.all([
    getActivitySummary(supabase, membership.organizationId),
    getActivityEntries(supabase, membership.organizationId, { query, entityType, from, to }, limit),
    getBusinessMetricsSnapshot(supabase, membership.organizationId, range),
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
    return `/activity?${nextParams.toString()}`;
  }

  const loadMoreHref = buildHref({ limit: limit + ACTIVITY_PAGE_SIZE });

  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-accent">Insights</p>
        <h1 className={pageTitleClass}>Analytics</h1>
        <p className={`mt-1.5 ${pageDescriptionClass}`}>
          Business performance across leads, pipeline, sales, scheduling, communication, and automation - plus a
          history of activity across your business.
        </p>
      </div>

      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className={sectionLabelClass}>Business performance · {snapshot.period.label}</p>
          <RangeTabs current={range} buildHref={(nextRange) => buildHref({ range: nextRange })} />
        </div>

        <div className="divide-y divide-slate-200">
          <LeadsPipelineSection snapshot={snapshot} />
          <EstimatesSection snapshot={snapshot} />
          <JobsSection snapshot={snapshot} />
          <AppointmentsSection snapshot={snapshot} />
          <FollowUpSection snapshot={snapshot} />
          <CommunicationSection snapshot={snapshot} />
          <AiActivitySection snapshot={snapshot} />
          <AutomationSection snapshot={snapshot} />
          <DataQualitySection snapshot={snapshot} />
        </div>
      </div>

      <div className="border-t border-slate-200 pt-8">
        <h2 className={primarySectionTitleClass}>Activity timeline</h2>
        <p className={`mt-1 ${metaClass}`}>A history of important actions and events across your business.</p>

        <div className="mt-5">
          <ActivitySummaryCards summary={summary} />
        </div>

        {summary.total === 0 ? (
          <div className="mt-5">
            <ActivityEmptyState />
          </div>
        ) : (
          <div className="mt-6 border-t border-slate-200 pt-6">
            <ActivityToolbar
              initialQuery={query}
              initialEntityType={entityType}
              initialFrom={from}
              initialTo={to}
            />
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
      </div>
    </div>
  );
}

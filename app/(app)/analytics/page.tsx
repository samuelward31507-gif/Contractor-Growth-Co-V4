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
  BusinessAtAGlance,
  LeadsPipelineSection,
  EstimatesSection,
  JobsSection,
  AppointmentsSection,
  ConversionSection,
  RevenueOpportunitySection,
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

export default async function AnalyticsPage({ searchParams }: PageProps<"/analytics">) {
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
    return `/analytics?${nextParams.toString()}`;
  }

  const loadMoreHref = buildHref({ limit: limit + ACTIVITY_PAGE_SIZE });

  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-accent">Grow</p>
        <h1 className={pageTitleClass}>Analytics</h1>
        <p className={`mt-1.5 ${pageDescriptionClass}`}>
          How leads turn into booked work and completed jobs, where follow-up is leaking, and what AI and automation
          are doing - plus a history of activity across your business.
        </p>
      </div>

      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className={sectionLabelClass}>Business performance · {snapshot.period.label}</p>
          <RangeTabs current={range} buildHref={(nextRange) => buildHref({ range: nextRange })} />
        </div>

        <div className="mt-5">
          <BusinessAtAGlance snapshot={snapshot} />
        </div>

        {/* Trackpr 2.0 Phase 5: named groups tell the revenue story in order -
            the raw numbers per pipeline stage, how well each stage converts
            to the next, where real opportunity is stalling, what AI/
            automation did, then the honesty footer. Every individual section
            is unchanged in what it computes (see business-metrics-sections.tsx) -
            only this grouping, and the two new sections built entirely from
            already-computed snapshot fields, are new. */}
        <div className="mt-10 flex flex-col gap-10">
          <div>
            <h2 className={primarySectionTitleClass}>Revenue pipeline</h2>
            <p className={`mt-1 ${metaClass}`}>Leads in, estimates sent, jobs won and completed - the raw numbers at each stage.</p>
            <div className="divide-y divide-slate-200">
              <LeadsPipelineSection snapshot={snapshot} />
              <EstimatesSection snapshot={snapshot} />
              <JobsSection snapshot={snapshot} />
              <AppointmentsSection snapshot={snapshot} />
            </div>
          </div>

          <div className="border-t border-slate-200 pt-10">
            <h2 className={primarySectionTitleClass}>Conversion</h2>
            <p className={`mt-1 ${metaClass}`}>How well each stage above converts to the next.</p>
            <div className="divide-y divide-slate-200">
              <ConversionSection snapshot={snapshot} />
              <RevenueOpportunitySection snapshot={snapshot} />
            </div>
          </div>

          <div className="border-t border-slate-200 pt-10">
            <h2 className={primarySectionTitleClass}>Follow-up &amp; communication</h2>
            <p className={`mt-1 ${metaClass}`}>Automated touches sent, and how customers are responding.</p>
            <div className="divide-y divide-slate-200">
              <FollowUpSection snapshot={snapshot} />
              <CommunicationSection snapshot={snapshot} />
            </div>
          </div>

          <div className="border-t border-slate-200 pt-10">
            <h2 className={primarySectionTitleClass}>AI &amp; automation</h2>
            <p className={`mt-1 ${metaClass}`}>What AI is doing, and whether automated dispatch is running cleanly.</p>
            <div className="divide-y divide-slate-200">
              <AiActivitySection snapshot={snapshot} />
              <AutomationSection snapshot={snapshot} />
            </div>
          </div>

          <div className="border-t border-slate-200 pt-10">
            <DataQualitySection snapshot={snapshot} />
          </div>
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

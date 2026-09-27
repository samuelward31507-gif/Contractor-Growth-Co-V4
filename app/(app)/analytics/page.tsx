import { redirect } from "next/navigation";
import { AlertCircle } from "lucide-react";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import {
  ACTIVITY_PAGE_SIZE,
  getActivityEntries,
  getActivitySummary,
} from "@/lib/activity/queries";
import { getBusinessMetricsSnapshot } from "@/lib/bi/metrics";
import type { DateRangePreset } from "@/lib/bi/types";
import { getRepeatCustomerSummaryResult } from "@/lib/customers/lifecycle";
import { PageHeader } from "@/lib/ui/page-header";
import { sectionLabelClass, primarySectionTitleClass, metaClass } from "@/lib/ui/typography";
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
  HistoricalFunnelSection,
  RevenueOpportunitySection,
  ReviewReferralSection,
  RepeatCustomerSection,
  FollowUpSection,
  CommunicationSection,
  ResponseTimeSection,
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

  const [summary, activityPage, snapshot, repeatCustomerSummary] = await Promise.all([
    getActivitySummary(supabase, membership.organizationId),
    getActivityEntries(supabase, membership.organizationId, { query, entityType, from, to }, limit),
    getBusinessMetricsSnapshot(supabase, membership.organizationId, range),
    // Pass 3: deliberately not range-scoped (see RepeatCustomerSection's own
    // documentation) - "has this customer come back, ever" ignores whatever
    // period the range tabs above have selected.
    getRepeatCustomerSummaryResult(supabase, membership.organizationId),
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
      <PageHeader
        eyebrow="Intelligence"
        title="Analytics"
        description="Understand your pipeline, conversion, revenue, and business performance."
      />

      {/* Trackpr 2.0, Phase 4B (P1 #2): a real Postgrest error on one of the
          BI snapshot's own core reads (lead/pipeline, estimates, jobs,
          appointments, AI) used to silently render as $0/0%/"no data" -
          indistinguishable from genuine emptiness on the one page whose
          entire purpose is "how is my business doing." Mirrors Dashboard's
          own partialData notice exactly (app/(app)/dashboard/page.tsx).
          Trackpr 2.0, Phase 4C (P2 #1): also covers repeatCustomerSummary's
          own failed signal - a failure there would otherwise render as a
          false "0 repeat customers" in the Customers section below. */}
      {snapshot.partialData || repeatCustomerSummary.failed ? (
        <div className="flex items-start gap-2.5 rounded-lg border border-warning-border bg-warning-muted px-4 py-2.5 text-sm text-warning-text">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>Some information is temporarily unavailable. Please try again.</p>
        </div>
      ) : null}

      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className={sectionLabelClass}>Business performance · {snapshot.period.label}</p>
          <RangeTabs current={range} buildHref={(nextRange) => buildHref({ range: nextRange })} />
        </div>

        {/* Trackpr 2.0 UI optimization pass: three deliberate tiers instead
            of six equal-weight primarySectionTitleClass headings (that
            token's own doc comment reserves it for "the one (or two)
            sections... that should genuinely lead the eye" - six uses
            recreated the exact uniform-heading syndrome it warns against).
            Every individual section below is unchanged in what it reads,
            computes, or renders internally (see business-metrics-sections.tsx,
            untouched) - only this page-level grouping/heading-weight/spacing
            changed:
              Tier 1 (primary, the one true primarySectionTitleClass use):
                Revenue & performance - the page's single headline story.
              Tier 2 (secondary intelligence, the one remaining
                primarySectionTitleClass use - "rarely twice," per the
                token's own doc comment, and justified here since pipeline/
                conversion/opportunity data is the page's clear second
                story): Pipeline, conversion & opportunities - merges the
                three former same-weight groups under one real heading;
                each already-labeled child section (Leads & pipeline,
                Conversion, Historical funnel, Where follow-up is leaking)
                keeps its own existing sectionLabelClass sub-label unchanged.
              Tier 3 (supporting/reference, demoted from
                primarySectionTitleClass to sectionLabelClass - matching
                every other genuinely-secondary label already used
                elsewhere in this app): Trends & supporting insights and,
                below it, Activity timeline - reached via a deliberately
                larger gap (pt-16 instead of pt-10) marking the one real
                tier break on the page, the same "you've left the core
                workspace" signal already proven on /agency. */}
        <div className="mt-8 flex flex-col gap-10">
          <div>
            <h2 className={primarySectionTitleClass}>Revenue &amp; performance</h2>
            <p className={`mt-1 ${metaClass}`}>How the business is doing, and where quoted/contracted value is coming from - never collected revenue, since no payment ledger exists.</p>
            <div className="mt-3">
              <BusinessAtAGlance snapshot={snapshot} />
            </div>
            <div className="mt-6 divide-y divide-slate-200">
              <EstimatesSection snapshot={snapshot} />
              <JobsSection snapshot={snapshot} />
            </div>
          </div>

          <div className="border-t border-slate-200 pt-10">
            <h2 className={primarySectionTitleClass}>Pipeline, conversion &amp; opportunities</h2>
            <p className={`mt-1 ${metaClass}`}>Current-state opportunity and lead-stage data, movement through the lifecycle, and real, quoted work that may be slipping away - never guaranteed revenue or a close probability.</p>
            <div className="divide-y divide-slate-200">
              <LeadsPipelineSection snapshot={snapshot} />
              <ConversionSection snapshot={snapshot} />
              <HistoricalFunnelSection snapshot={snapshot} />
              <RevenueOpportunitySection snapshot={snapshot} />
            </div>
          </div>

          <div className="border-t border-slate-200 pt-16">
            <p className={sectionLabelClass}>Trends &amp; supporting insights</p>
            <p className={`mt-1 ${metaClass}`}>Scheduling, follow-up, communication, reviews, AI, and automation health for the period above. Repeat customers is the one exception - always all-time, since &ldquo;has this customer come back, ever&rdquo; isn&apos;t a date-range question.</p>
            <div className="mt-3 divide-y divide-slate-200">
              <AppointmentsSection snapshot={snapshot} />
              <FollowUpSection snapshot={snapshot} />
              <CommunicationSection snapshot={snapshot} />
              <ResponseTimeSection snapshot={snapshot} />
              <ReviewReferralSection snapshot={snapshot} />
              <RepeatCustomerSection summary={repeatCustomerSummary} />
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
        <p className={sectionLabelClass}>Activity timeline</p>
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

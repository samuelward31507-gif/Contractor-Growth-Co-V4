import { AlertCircle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getAgencyRevenue } from "@/lib/agency/revenue";
import type { DateRangeInput } from "@/lib/bi/types";
import { metaClass } from "@/lib/ui/typography";
import { PageHeader } from "@/lib/ui/page-header";
import { SectionCard } from "@/lib/ui/section-card";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";
import { UnauthorizedState } from "../_components/unauthorized-state";
import { ErrorState } from "../_components/error-state";
import { RangeSelector, type RevenueRangeKey } from "./_components/range-selector";
import { CollectedByCategory, RevenueHeadline } from "./_components/revenue-summary";
import { ClientRevenueTable } from "./_components/client-revenue-table";
import { RecentRevenueEvents } from "./_components/recent-revenue-events";

/**
 * Trackpr Phase 5D-1 - Agency Revenue. The first real Contractor Growth Co.
 * revenue surface: every figure comes from revenue_events (populated by
 * app/api/webhooks/stripe/route.ts from real Stripe invoice/refund events),
 * never from current Price IDs, subscription config, or estimation. This is
 * agency revenue from its own clients - not contractor/customer job revenue
 * (see app/agency/usage's own "Cost readiness" section, unmodified by this
 * page, for that distinction already established in Phase 5C).
 *
 * One surface only, per the Phase 5D-1 task's own scope: no
 * /agency/revenue/[organizationId] drill-down page - a client's own name
 * here links to the existing /agency/organizations/[organizationId] page
 * instead.
 *
 * Agency redesign: the client app's page anatomy (standard page container,
 * PageHeader, StatGrid, SectionCards, shared table primitives). Data reads,
 * range handling, authorization and the error path are unchanged. A failed
 * revenue read (partialData) returns no rows at all, so every figure renders
 * as "—" with the disclosure banner rather than as a placeholder $0.00.
 */
const RANGE_PARAM_TO_INPUT: Record<RevenueRangeKey, DateRangeInput> = {
  today: "today",
  month: "currentMonth",
  lastMonth: "previousMonth",
  lifetime: "allTime",
};

function resolveRangeKey(param: string | string[] | undefined): RevenueRangeKey {
  const value = Array.isArray(param) ? param[0] : param;
  if (value === "today" || value === "month" || value === "lastMonth") return value;
  return "lifetime";
}

const PAGE_CLASS = `${PAGE_CONTAINER_CLASS} gap-8 ${PAGE_MAX_WIDTH_CLASS}`;

export default async function AgencyRevenuePage({ searchParams }: { searchParams: Promise<{ range?: string | string[] }> }) {
  const { range: rangeParam } = await searchParams;
  const rangeKey = resolveRangeKey(rangeParam);

  const supabase = await createClient();
  const service = createServiceRoleClient();

  let result: Awaited<ReturnType<typeof getAgencyRevenue>>;

  try {
    result = await getAgencyRevenue(supabase, service, RANGE_PARAM_TO_INPUT[rangeKey]);
  } catch {
    return (
      <div className={PAGE_CLASS}>
        <ErrorState />
      </div>
    );
  }

  if (!result.ok) {
    return (
      <div className={PAGE_CLASS}>
        <UnauthorizedState />
      </div>
    );
  }

  const { totals, clients, recentEvents, partialData, range } = result;

  return (
    <div className={PAGE_CLASS}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <PageHeader
            eyebrow="Agency"
            title="Revenue"
            description="Contractor Growth Co.’s own revenue from managed clients, recorded from real Stripe payment events."
          />
          <p className={`mt-1.5 ${metaClass}`}>Period: {range.label}</p>
        </div>
        <RangeSelector active={rangeKey} />
      </div>

      {partialData ? (
        <div role="status" className="flex items-start gap-2.5 rounded-lg border border-warning-border bg-warning-muted px-4 py-2.5 text-sm text-warning-text">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>Revenue data could not be fully loaded for this period, so figures are shown as &ldquo;—&rdquo;. This is different from a genuine $0, which means the data loaded successfully and found no revenue.</p>
        </div>
      ) : null}

      <RevenueHeadline totals={totals} unavailable={partialData} />

      <div className="flex flex-col gap-6">
        <CollectedByCategory totals={totals} unavailable={partialData} />
        <ClientRevenueTable clients={clients} unavailable={partialData} />
        <RecentRevenueEvents events={recentEvents} unavailable={partialData} />

        <SectionCard title="About this page">
          <ul className="space-y-1.5 text-xs text-ink-3">
            <li className="flex gap-2">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-line-strong" aria-hidden />
              Every figure here comes from a real Stripe webhook event Trackpr recorded - never from current subscription pricing, Price IDs, or an estimate.
            </li>
            <li className="flex gap-2">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-line-strong" aria-hidden />
              &ldquo;Uncategorized&rdquo; means the invoice mixed a one-time setup fee with the first recurring charge and could not be honestly split - never guessed into either bucket.
            </li>
            <li className="flex gap-2">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-line-strong" aria-hidden />
              Failed payment attempts are never counted as collected or included in Net collected.
            </li>
            <li className="flex gap-2">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-line-strong" aria-hidden />
              This is Contractor Growth Co.&rsquo;s own revenue from its clients - not contractor/customer job revenue, which is shown separately across the client CRM and never mixed in here.
            </li>
          </ul>
        </SectionCard>
      </div>
    </div>
  );
}

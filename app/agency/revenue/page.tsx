import Link from "next/link";
import { AlertCircle, ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getAgencyRevenue } from "@/lib/agency/revenue";
import type { DateRangeInput } from "@/lib/bi/types";
import { pageTitleClass, pageDescriptionClass, sectionLabelClass, metaClass } from "@/lib/ui/typography";
import { UnauthorizedState } from "../_components/unauthorized-state";
import { ErrorState } from "../_components/error-state";
import { RangeSelector, type RevenueRangeKey } from "./_components/range-selector";
import { RevenueSummary } from "./_components/revenue-summary";
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
      <div className="mx-auto flex w-full max-w-[1150px] flex-1 flex-col px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
        <ErrorState />
      </div>
    );
  }

  if (!result.ok) {
    return (
      <div className="mx-auto flex w-full max-w-[1150px] flex-1 flex-col px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
        <UnauthorizedState />
      </div>
    );
  }

  const { totals, clients, recentEvents, partialData, range } = result;

  return (
    <div className="mx-auto w-full max-w-[1150px] px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
      <Link href="/agency" className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-700">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Agency Command Center
      </Link>

      <div className="mt-3">
        <p className={sectionLabelClass}>Finance</p>
        <h1 className={`mt-1.5 ${pageTitleClass}`}>Revenue</h1>
        <p className={`mt-1.5 ${pageDescriptionClass}`}>
          Contractor Growth Co.&rsquo;s own revenue from managed clients, recorded from real Stripe payment events.
        </p>
        <p className={`mt-1 ${metaClass}`}>Period: {range.label}</p>
      </div>

      <RangeSelector active={rangeKey} />

      {partialData ? (
        <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-warning-border bg-warning-muted px-4 py-2.5 text-sm text-warning-text">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>Revenue data could not be fully loaded for this period. Figures below may be incomplete - this is different from a genuine $0, which means the data loaded successfully and found no revenue.</p>
        </div>
      ) : null}

      <RevenueSummary totals={totals} />
      <ClientRevenueTable clients={clients} />
      <RecentRevenueEvents events={recentEvents} />

      <div className="mt-8 border-t border-slate-200 pt-8">
        <p className={sectionLabelClass}>About this page</p>
        <ul className="mt-2 space-y-1.5 text-xs text-slate-500">
          <li className="flex gap-2">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-300" aria-hidden />
            Every figure here comes from a real Stripe webhook event Trackpr recorded - never from current subscription pricing, Price IDs, or an estimate.
          </li>
          <li className="flex gap-2">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-300" aria-hidden />
            &ldquo;Uncategorized&rdquo; means the invoice mixed a one-time setup fee with the first recurring charge and could not be honestly split - never guessed into either bucket.
          </li>
          <li className="flex gap-2">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-300" aria-hidden />
            Failed payment attempts are never counted as collected or included in Net collected.
          </li>
          <li className="flex gap-2">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-300" aria-hidden />
            This is Contractor Growth Co.&rsquo;s own revenue from its clients - not contractor/customer job revenue, which is shown separately across the client CRM and never mixed in here.
          </li>
        </ul>
      </div>
    </div>
  );
}

import Link from "next/link";
import { AlertCircle, ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getAgencyAiCosts, getAgencySmsCosts } from "@/lib/agency/costs";
import type { DateRangeInput } from "@/lib/bi/types";
import { sectionLabelClass, metaClass } from "@/lib/ui/typography";
import { PageHeader } from "@/lib/ui/page-header";
import { UnauthorizedState } from "../_components/unauthorized-state";
import { ErrorState } from "../_components/error-state";
import { RangeSelector, type CostRangeKey } from "./_components/range-selector";
import { AiCostSummary } from "./_components/ai-cost-summary";
import { ClientCostTable } from "./_components/client-cost-table";
import { SmsCostSummary } from "./_components/sms-cost-summary";
import { UnsupportedProviders } from "./_components/unsupported-providers";

/**
 * Trackpr Phase 5D-2 - Agency Cost. The first real dollar-cost surface:
 * every figure comes from ai_cost_events (real usage x a real, historically
 * accurate rate card - see lib/costs/ai-cost-events.ts and
 * lib/agency/costs.ts), never an estimate. Deliberately narrow: AI cost
 * only, per the Phase 5D-2 audit's own scope. This does NOT replace or
 * duplicate app/agency/usage's existing "Cost Readiness" section (Phase
 * 5C, left completely untouched) - that section remains the
 * usage-visibility surface for providers that still have no rate at all;
 * this page is the authoritative dollar-cost surface for the one provider
 * that now does.
 *
 * No margin, no profit, no client pricing/billing anywhere on this page -
 * out of scope for this phase (see UnsupportedProviders and the audit's own
 * §19 contribution-margin-dependency finding).
 *
 * Phase 5D-4 adds a second, independent section for Twilio SMS cost (see
 * sms-cost-summary.tsx) - every figure there comes from sms_cost_events
 * (lib/costs/sms-cost-events.ts), Twilio's own authoritative fetched price,
 * never a rate card and never an estimate. The existing AI section above it
 * is completely unchanged.
 */
const RANGE_PARAM_TO_INPUT: Record<CostRangeKey, DateRangeInput> = {
  today: "today",
  month: "currentMonth",
  lastMonth: "previousMonth",
  lifetime: "allTime",
};

function resolveRangeKey(param: string | string[] | undefined): CostRangeKey {
  const value = Array.isArray(param) ? param[0] : param;
  if (value === "today" || value === "month" || value === "lastMonth") return value;
  return "lifetime";
}

export default async function AgencyCostsPage({ searchParams }: { searchParams: Promise<{ range?: string | string[] }> }) {
  const { range: rangeParam } = await searchParams;
  const rangeKey = resolveRangeKey(rangeParam);

  const supabase = await createClient();
  const service = createServiceRoleClient();

  let result: Awaited<ReturnType<typeof getAgencyAiCosts>>;
  let smsResult: Awaited<ReturnType<typeof getAgencySmsCosts>>;

  try {
    // Phase 5D-4: a second, independent read alongside the existing AI cost
    // read - each calls resolveAgencyOrganizations() exactly once, on its
    // own, matching this codebase's established "one entry point per report
    // type" convention (see lib/agency/costs.ts's own header comment).
    [result, smsResult] = await Promise.all([
      getAgencyAiCosts(supabase, service, RANGE_PARAM_TO_INPUT[rangeKey]),
      getAgencySmsCosts(supabase, service, RANGE_PARAM_TO_INPUT[rangeKey]),
    ]);
  } catch {
    return (
      <div className="mx-auto flex w-full max-w-[1150px] flex-1 flex-col px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
        <ErrorState />
      </div>
    );
  }

  if (!result.ok || !smsResult.ok) {
    return (
      <div className="mx-auto flex w-full max-w-[1150px] flex-1 flex-col px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
        <UnauthorizedState />
      </div>
    );
  }

  const { totals, clients, partialData, range } = result;
  const { totals: smsTotals, clients: smsClients, partialData: smsPartialData } = smsResult;

  return (
    <div className="mx-auto w-full max-w-[1150px] px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
      <Link href="/agency" className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-700">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Agency Command Center
      </Link>

      <div className="mt-3">
        <PageHeader
          eyebrow="Finance"
          title="Costs"
          description="Contractor Growth Co.’s own provider cost from managed clients - real usage, a real historical rate, never an estimate."
        />
        <p className={`mt-1 ${metaClass}`}>Period: {range.label}</p>
      </div>

      <RangeSelector active={rangeKey} />

      {partialData || smsPartialData ? (
        <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-warning-border bg-warning-muted px-4 py-2.5 text-sm text-warning-text">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>Cost data could not be fully loaded for this period. Figures below may be incomplete - this is different from a genuine $0, which means the data loaded successfully and found no known cost.</p>
        </div>
      ) : null}

      <AiCostSummary totals={totals} />
      <ClientCostTable clients={clients} />
      <SmsCostSummary totals={smsTotals} clients={smsClients} />
      <UnsupportedProviders />

      <div className="mt-8 border-t border-slate-200 pt-8">
        <p className={sectionLabelClass}>About this page</p>
        <ul className="mt-2 space-y-1.5 text-xs text-slate-500">
          <li className="flex gap-2">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-300" aria-hidden />
            Known AI cost is calculated only from real token usage, a trusted provider/model, and a matching historical rate card - never an estimate, never today&rsquo;s rate applied to past usage.
          </li>
          <li className="flex gap-2">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-300" aria-hidden />
            &ldquo;Unpriced&rdquo; and &ldquo;Unknown&rdquo; are always shown as counts, never as $0 - a missing rate or an unreliable identity is not the same as zero cost.
          </li>
          <li className="flex gap-2">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-300" aria-hidden />
            Known SMS cost is Twilio&rsquo;s own authoritative price for that exact message - no local rate, no segment estimate, and no rate card is used for SMS.
          </li>
          <li className="flex gap-2">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-300" aria-hidden />
            This is Contractor Growth Co.&rsquo;s own provider cost - not a margin, not a profit figure, and not client pricing or billing.
          </li>
        </ul>
      </div>
    </div>
  );
}

import { AlertCircle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getAgencyAiCosts, getAgencySmsCosts } from "@/lib/agency/costs";
import type { DateRangeInput } from "@/lib/bi/types";
import { metaClass } from "@/lib/ui/typography";
import { PageHeader } from "@/lib/ui/page-header";
import { SectionCard } from "@/lib/ui/section-card";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";
import { UnauthorizedState } from "../_components/unauthorized-state";
import { ErrorState } from "../_components/error-state";
import { RangeSelector, type CostRangeKey } from "./_components/range-selector";
import { CostHeadline } from "./_components/ai-cost-summary";
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
 * 5C) - that section remains the usage-visibility surface for providers
 * that still have no rate at all; this page is the authoritative dollar-cost
 * surface for the providers that now do.
 *
 * No margin, no profit, no client pricing/billing anywhere on this page -
 * out of scope for this phase (see UnsupportedProviders and the audit's own
 * §19 contribution-margin-dependency finding).
 *
 * Phase 5D-4 adds a second, independent read for Twilio SMS cost - every
 * figure there comes from sms_cost_events (lib/costs/sms-cost-events.ts),
 * Twilio's own authoritative fetched price, never a rate card and never an
 * estimate.
 *
 * Agency redesign: the client app's page anatomy (standard page container,
 * PageHeader, StatGrid, SectionCards, shared table primitives). Reads, range
 * handling, authorization and the error path are unchanged. Each failed read
 * (partialData / smsPartialData) returns no rows, so that side's figures
 * render as "—" with the disclosure banner, never as a placeholder zero.
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

const PAGE_CLASS = `${PAGE_CONTAINER_CLASS} gap-8 ${PAGE_MAX_WIDTH_CLASS}`;

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
      <div className={PAGE_CLASS}>
        <ErrorState />
      </div>
    );
  }

  if (!result.ok || !smsResult.ok) {
    return (
      <div className={PAGE_CLASS}>
        <UnauthorizedState />
      </div>
    );
  }

  const { totals, clients, partialData, range } = result;
  const { totals: smsTotals, clients: smsClients, partialData: smsPartialData } = smsResult;

  return (
    <div className={PAGE_CLASS}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <PageHeader
            eyebrow="Agency"
            title="Costs"
            description="Contractor Growth Co.’s own provider cost from managed clients - real usage, a real historical rate, never an estimate."
          />
          <p className={`mt-1.5 ${metaClass}`}>Period: {range.label}</p>
        </div>
        <RangeSelector active={rangeKey} />
      </div>

      {partialData || smsPartialData ? (
        <div role="status" className="flex items-start gap-2.5 rounded-lg border border-warning-border bg-warning-muted px-4 py-2.5 text-sm text-warning-text">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>
            {partialData && smsPartialData ? "AI and SMS cost data" : partialData ? "AI cost data" : "SMS cost data"} could not be fully loaded for this period, so those figures are shown as &ldquo;—&rdquo;. This is different from a genuine $0, which means the data
            loaded successfully and found no known cost.
          </p>
        </div>
      ) : null}

      <CostHeadline ai={totals} aiUnavailable={partialData} sms={smsTotals} smsUnavailable={smsPartialData} />

      <div className="flex flex-col gap-6">
        <ClientCostTable clients={clients} unavailable={partialData} />
        <SmsCostSummary clients={smsClients} unavailable={smsPartialData} />
        <UnsupportedProviders />

        <SectionCard title="About this page">
          <ul className="space-y-1.5 text-xs text-ink-3">
            <li className="flex gap-2">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-line-strong" aria-hidden />
              Known AI cost is calculated only from real token usage, a trusted provider/model, and a matching historical rate card - never an estimate, never today&rsquo;s rate applied to past usage.
            </li>
            <li className="flex gap-2">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-line-strong" aria-hidden />
              &ldquo;Unpriced&rdquo; and &ldquo;Unknown&rdquo; are always shown as counts, never as $0 - a missing rate or an unreliable identity is not the same as zero cost.
            </li>
            <li className="flex gap-2">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-line-strong" aria-hidden />
              Known SMS cost is Twilio&rsquo;s own authoritative price for that exact message - no local rate, no segment estimate, and no rate card is used for SMS.
            </li>
            <li className="flex gap-2">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-line-strong" aria-hidden />
              This is Contractor Growth Co.&rsquo;s own provider cost - not a margin, not a profit figure, and not client pricing or billing.
            </li>
          </ul>
        </SectionCard>
      </div>
    </div>
  );
}

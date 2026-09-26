import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { formatCurrency } from "@/lib/dashboard/format";
import { formatCount } from "../../_components/format";
import type { AgencyExpansionOpportunity } from "@/lib/agency/expansion";

type ServiceGroup = {
  service: string;
  count: number;
  knownValue: number;
  hasUnknownValue: boolean;
  isContextual: boolean;
};

/**
 * Presentation-layer grouping only - mirrors
 * app/agency/_components/needs-attention.tsx's own byCategory Map built
 * inside the component, not returned by lib/agency/expansion.ts. Every
 * AgencyExpansionOpportunity always has affectedCount 1 (see that type's own
 * comment); "N opportunities for this service" is simply the length of the
 * items sharing a recommendedService, computed here.
 */
function groupByService(opportunities: AgencyExpansionOpportunity[]): ServiceGroup[] {
  const byService = new Map<string, ServiceGroup>();

  for (const opportunity of opportunities) {
    const group = byService.get(opportunity.recommendedService) ?? {
      service: opportunity.recommendedService,
      count: 0,
      knownValue: 0,
      hasUnknownValue: false,
      isContextual: opportunity.isContextualValue,
    };

    group.count += 1;
    if (!opportunity.isContextualValue) {
      if (opportunity.estimatedValue != null) group.knownValue += opportunity.estimatedValue;
      else group.hasUnknownValue = true;
    }

    byService.set(opportunity.recommendedService, group);
  }

  return [...byService.values()].sort((a, b) => b.knownValue - a.knownValue || b.count - a.count);
}

export function ClientExpansionCard({
  organizationId,
  organizationName,
  opportunities,
}: {
  organizationId: string;
  organizationName: string;
  opportunities: AgencyExpansionOpportunity[];
}) {
  const groups = groupByService(opportunities);
  const knownValue = groups.reduce((sum, group) => sum + group.knownValue, 0);
  // The single group most worth the agency's attention first: prefer the
  // highest known dollar value; when nothing has a known value, fall back to
  // the group with the most affected records. Never a scored/ranked "best"
  // opportunity - purely the same sort order already rendered above it.
  const topGroup = groups[0];

  return (
    <div className="border-b border-slate-200 py-6 last:border-b-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <Link href={`/agency/organizations/${organizationId}`} className="text-base font-semibold text-slate-900 hover:underline">
          {organizationName}
        </Link>
        <span className="text-xs text-slate-500">
          {formatCount(opportunities.length)} open opportunit{opportunities.length === 1 ? "y" : "ies"}
          {knownValue > 0 ? ` · ${formatCurrency(knownValue)} known value` : ""}
        </span>
      </div>

      <div className="mt-3 divide-y divide-slate-100">
        {groups.map((group) => (
          <div key={group.service} className="flex items-center justify-between gap-3 py-2">
            <div>
              <p className="text-sm font-medium text-slate-800">{group.service}</p>
              <p className="text-xs text-slate-500">
                {formatCount(group.count)} opportunit{group.count === 1 ? "y" : "ies"}
              </p>
            </div>
            <p className="shrink-0 text-sm font-medium tabular-nums text-slate-900">
              {group.isContextual
                ? "Context only"
                : group.knownValue > 0
                  ? `${formatCurrency(group.knownValue)}${group.hasUnknownValue ? " + unknown" : ""}`
                  : "Unknown value"}
            </p>
          </div>
        ))}
      </div>

      {topGroup ? (
        <Link
          href={`/agency/organizations/${organizationId}`}
          className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-accent-text hover:underline"
        >
          Investigate {topGroup.service}
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      ) : null}
    </div>
  );
}

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Badge } from "@/lib/ui/badge";
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

/**
 * Agency redesign: one bordered block per client inside the page's "Client
 * opportunities" SectionCard. Same grouping, same values, same single
 * "Investigate" link to the client's real detail page.
 */
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
    <article className="rounded-xl border border-line px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="min-w-0">
          <Link href={`/agency/organizations/${organizationId}`} className="break-words text-[15px] font-semibold text-ink hover:underline">
            {organizationName}
          </Link>
        </h3>
        <span className="text-xs text-ink-3">
          {formatCount(opportunities.length)} open opportunit{opportunities.length === 1 ? "y" : "ies"}
          {knownValue > 0 ? ` · ${formatCurrency(knownValue)} known value` : ""}
        </span>
      </div>

      <ul className="mt-2 divide-y divide-line">
        {groups.map((group) => (
          <li key={group.service} className="flex items-center justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <p className="break-words text-sm font-medium text-ink">{group.service}</p>
              <p className="text-xs text-ink-3">
                {formatCount(group.count)} opportunit{group.count === 1 ? "y" : "ies"}
              </p>
            </div>
            <p className="shrink-0 text-right text-sm font-medium tabular-nums text-ink">
              {group.isContextual ? (
                <Badge tone="neutral">Context only</Badge>
              ) : group.knownValue > 0 ? (
                `${formatCurrency(group.knownValue)}${group.hasUnknownValue ? " + unknown" : ""}`
              ) : (
                <span className="text-ink-3">Unknown value</span>
              )}
            </p>
          </li>
        ))}
      </ul>

      {topGroup ? (
        <Link
          href={`/agency/organizations/${organizationId}`}
          className="mt-2 inline-flex min-h-11 items-center gap-1 text-xs font-medium text-accent-text hover:underline sm:min-h-0"
        >
          Investigate {topGroup.service}
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      ) : null}
    </article>
  );
}

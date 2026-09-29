import Link from "next/link";
import { sectionLabelClass, metaClass } from "@/lib/ui/typography";
import { formatCurrencyAmounts } from "./format";
import type { ClientRevenueSummary } from "@/lib/agency/revenue";

/**
 * Trackpr Phase 5D-1 - Client Revenue. Per-organization breakdown, busiest
 * (by revenue event count) first. Section 12 of the Phase 5D-1 task is
 * explicit that a per-organization drill-down page is not necessary for this
 * phase - the organization name links to the existing
 * /agency/organizations/[organizationId] detail page (same convention as
 * app/agency/usage/_components/cost-readiness-section.tsx), not a new
 * revenue-specific route.
 */
export function ClientRevenueTable({ clients }: { clients: ClientRevenueSummary[] }) {
  const sorted = [...clients].sort((a, b) => b.eventCount - a.eventCount);

  return (
    <div className="mt-8">
      <div className="flex items-baseline justify-between">
        <p className={sectionLabelClass}>Client revenue</p>
        {clients.length > 0 ? <span className={metaClass}>{clients.length} client{clients.length === 1 ? "" : "s"}</span> : null}
      </div>

      {sorted.length === 0 ? (
        <p className="mt-3 text-sm text-ink-3">No managed clients yet.</p>
      ) : (
        <div className="mt-2 space-y-3">
          {sorted.map((client) => (
            <div key={client.organizationId} className="rounded-lg border border-line px-5 py-4">
              <div className="flex items-center justify-between gap-3">
                <Link href={`/agency/organizations/${client.organizationId}`} className="text-sm font-semibold text-ink hover:underline">
                  {client.organizationName}
                </Link>
                <span className={metaClass}>{client.eventCount} event{client.eventCount === 1 ? "" : "s"}</span>
              </div>
              {client.eventCount === 0 ? (
                <p className="mt-1.5 text-xs text-ink-3">No revenue events recorded in this period.</p>
              ) : (
                <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs">
                  <span className="text-ink-3">
                    Collected <span className="ml-1 font-medium tabular-nums text-ink">{formatCurrencyAmounts(client.totals.collected)}</span>
                  </span>
                  <span className="text-ink-3">
                    Refunded <span className="ml-1 font-medium tabular-nums text-ink">{formatCurrencyAmounts(client.totals.refunded)}</span>
                  </span>
                  <span className="text-ink-3">
                    Net <span className="ml-1 font-medium tabular-nums text-ink">{formatCurrencyAmounts(client.totals.netCollected)}</span>
                  </span>
                  <span className="text-ink-3">
                    Failed attempts <span className="ml-1 font-medium tabular-nums text-ink">{formatCurrencyAmounts(client.totals.failedAttempted)}</span>
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

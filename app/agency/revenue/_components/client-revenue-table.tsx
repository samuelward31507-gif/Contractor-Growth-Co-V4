import Link from "next/link";
import { Building2 } from "lucide-react";
import { SectionCard } from "@/lib/ui/section-card";
import { EmptyState } from "@/lib/ui/empty-state";
import { Table, TableBody, TableCell, TableHeadCell, TableRow } from "@/lib/ui/table";
import { revenueValue } from "./revenue-summary";
import type { ClientRevenueSummary } from "@/lib/agency/revenue";

const COLUMNS = "grid-cols-[minmax(0,1.4fr)_64px_repeat(4,minmax(0,1fr))]";

function eventsLabel(count: number): string {
  return `${count} event${count === 1 ? "" : "s"}`;
}

/**
 * Trackpr Phase 5D-1 - Client Revenue. Per-organization breakdown, busiest
 * (by revenue event count) first. Section 12 of the Phase 5D-1 task is
 * explicit that a per-organization drill-down page is not necessary for this
 * phase - the organization name links to the existing
 * /agency/organizations/[organizationId] detail page (same convention as
 * app/agency/usage/_components/cost-readiness-section.tsx), not a new
 * revenue-specific route.
 *
 * Agency redesign: the shared table primitives (lib/ui/table.tsx) on desktop,
 * a stacked row list below `lg` - the same split every client-app list uses.
 * A client with no events in the period says so instead of a column of
 * $0.00 figures, exactly as before; when the revenue read failed every
 * figure is "—" (see revenueValue), never a placeholder zero.
 */
export function ClientRevenueTable({ clients, unavailable }: { clients: ClientRevenueSummary[]; unavailable: boolean }) {
  const sorted = [...clients].sort((a, b) => b.eventCount - a.eventCount);

  return (
    <SectionCard
      title="Client revenue"
      description="Per managed client, busiest first. Open a client for its full record."
      action={clients.length > 0 ? <span className="shrink-0 text-xs text-ink-3">{clients.length} client{clients.length === 1 ? "" : "s"}</span> : undefined}
    >
      {sorted.length === 0 ? (
        <EmptyState icon={Building2} title="No managed clients yet" description="Once a client organization is connected to the agency, its Stripe revenue will appear here." />
      ) : (
        <>
          <Table columns={COLUMNS}>
            <TableHeadCell>Client</TableHeadCell>
            <TableHeadCell align="right">Events</TableHeadCell>
            <TableHeadCell align="right">Collected</TableHeadCell>
            <TableHeadCell align="right">Refunded</TableHeadCell>
            <TableHeadCell align="right">Net</TableHeadCell>
            <TableHeadCell align="right">Failed attempts</TableHeadCell>
          </Table>
          <TableBody>
            {sorted.map((client) => (
              <TableRow key={client.organizationId} href={`/agency/organizations/${client.organizationId}`} columns={COLUMNS}>
                <TableCell className="font-medium">{client.organizationName}</TableCell>
                <TableCell align="right" muted>
                  {unavailable ? "—" : client.eventCount}
                </TableCell>
                {!unavailable && client.eventCount === 0 ? (
                  <TableCell muted className="col-span-4 text-right">
                    No revenue events recorded in this period
                  </TableCell>
                ) : (
                  <>
                    <TableCell align="right">{revenueValue(client.totals.collected, unavailable)}</TableCell>
                    <TableCell align="right">{revenueValue(client.totals.refunded, unavailable)}</TableCell>
                    <TableCell align="right" className="font-medium">
                      {revenueValue(client.totals.netCollected, unavailable)}
                    </TableCell>
                    <TableCell align="right">{revenueValue(client.totals.failedAttempted, unavailable)}</TableCell>
                  </>
                )}
              </TableRow>
            ))}
          </TableBody>

          <ul className="divide-y divide-line lg:hidden">
            {sorted.map((client) => (
              <li key={client.organizationId}>
                <Link
                  href={`/agency/organizations/${client.organizationId}`}
                  className="-mx-2 block rounded-md px-2 py-3 transition-colors hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-sm font-medium text-ink">{client.organizationName}</span>
                    <span className="shrink-0 text-xs text-ink-3">{unavailable ? "Unavailable" : eventsLabel(client.eventCount)}</span>
                  </span>
                  {!unavailable && client.eventCount === 0 ? (
                    <span className="mt-1 block text-xs text-ink-3">No revenue events recorded in this period.</span>
                  ) : (
                    <span className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-ink-3">
                      <span>
                        Collected <span className="ml-1 font-medium tabular-nums text-ink">{revenueValue(client.totals.collected, unavailable)}</span>
                      </span>
                      <span>
                        Refunded <span className="ml-1 font-medium tabular-nums text-ink">{revenueValue(client.totals.refunded, unavailable)}</span>
                      </span>
                      <span>
                        Net <span className="ml-1 font-medium tabular-nums text-ink">{revenueValue(client.totals.netCollected, unavailable)}</span>
                      </span>
                      <span>
                        Failed <span className="ml-1 font-medium tabular-nums text-ink">{revenueValue(client.totals.failedAttempted, unavailable)}</span>
                      </span>
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </SectionCard>
  );
}

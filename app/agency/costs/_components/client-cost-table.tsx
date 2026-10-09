import Link from "next/link";
import { Building2 } from "lucide-react";
import { SectionCard } from "@/lib/ui/section-card";
import { EmptyState } from "@/lib/ui/empty-state";
import { Table, TableBody, TableCell, TableHeadCell, TableRow } from "@/lib/ui/table";
import { costValue, countValue } from "./format";
import { QualityBadge } from "./quality-badge";
import type { ClientAiCostSummary } from "@/lib/agency/costs";

const COLUMNS = "grid-cols-[minmax(0,1.4fr)_96px_repeat(4,minmax(0,1fr))]";

/**
 * Trackpr Phase 5D-2 - Client Cost. Busiest (by resolved interaction count)
 * first. No per-organization drill-down page is created for this phase - the
 * organization name links to the existing
 * /agency/organizations/[organizationId] page, matching
 * app/agency/revenue/_components/client-revenue-table.tsx's own convention.
 *
 * Agency redesign: shared table primitives on desktop, a stacked list below
 * `lg`, inside a SectionCard.
 */
export function ClientCostTable({ clients, unavailable }: { clients: ClientAiCostSummary[]; unavailable: boolean }) {
  const sorted = [...clients].sort(
    (a, b) => b.knownInteractionCount + b.unpricedInteractionCount + b.unknownInteractionCount - (a.knownInteractionCount + a.unpricedInteractionCount + a.unknownInteractionCount),
  );

  return (
    <SectionCard
      title="AI cost by client"
      description="Known cost and the interactions that could not be costed, busiest client first."
      action={clients.length > 0 ? <span className="shrink-0 text-xs text-ink-3">{clients.length} client{clients.length === 1 ? "" : "s"}</span> : undefined}
    >
      {sorted.length === 0 ? (
        <EmptyState icon={Building2} title="No managed clients yet" description="Once a client organization is connected to the agency, its AI cost will appear here." />
      ) : (
        <>
          <Table columns={COLUMNS}>
            <TableHeadCell>Client</TableHeadCell>
            <TableHeadCell>Data</TableHeadCell>
            <TableHeadCell align="right">Known cost</TableHeadCell>
            <TableHeadCell align="right">Known</TableHeadCell>
            <TableHeadCell align="right">Unpriced</TableHeadCell>
            <TableHeadCell align="right">Unknown</TableHeadCell>
          </Table>
          <TableBody>
            {sorted.map((client) => (
              <TableRow key={client.organizationId} href={`/agency/organizations/${client.organizationId}`} columns={COLUMNS}>
                <TableCell className="font-medium">{client.organizationName}</TableCell>
                <span>
                  <QualityBadge quality={client.dataQuality} unavailable={unavailable} />
                </span>
                <TableCell align="right" className="font-medium">
                  {costValue(client.knownCost, unavailable)}
                </TableCell>
                <TableCell align="right">{countValue(client.knownInteractionCount, unavailable)}</TableCell>
                <TableCell align="right">{countValue(client.unpricedInteractionCount, unavailable)}</TableCell>
                <TableCell align="right">{countValue(client.unknownInteractionCount, unavailable)}</TableCell>
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
                  <span className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate text-sm font-medium text-ink">{client.organizationName}</span>
                    <QualityBadge quality={client.dataQuality} unavailable={unavailable} />
                  </span>
                  <span className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-ink-3">
                    <span>
                      Known cost <span className="ml-1 font-medium tabular-nums text-ink">{costValue(client.knownCost, unavailable)}</span>
                    </span>
                    <span>
                      Known <span className="ml-1 font-medium tabular-nums text-ink">{countValue(client.knownInteractionCount, unavailable)}</span>
                    </span>
                    <span>
                      Unpriced <span className="ml-1 font-medium tabular-nums text-ink">{countValue(client.unpricedInteractionCount, unavailable)}</span>
                    </span>
                    <span>
                      Unknown <span className="ml-1 font-medium tabular-nums text-ink">{countValue(client.unknownInteractionCount, unavailable)}</span>
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </SectionCard>
  );
}

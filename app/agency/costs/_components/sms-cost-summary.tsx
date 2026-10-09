import Link from "next/link";
import { Building2 } from "lucide-react";
import { SectionCard } from "@/lib/ui/section-card";
import { EmptyState } from "@/lib/ui/empty-state";
import { Table, TableBody, TableCell, TableHeadCell, TableRow } from "@/lib/ui/table";
import { costValue, countValue } from "./format";
import { QualityBadge } from "./quality-badge";
import type { ClientSmsCostSummary } from "@/lib/agency/costs";

const COLUMNS = "grid-cols-[minmax(0,1.4fr)_96px_repeat(3,minmax(0,1fr))]";

/**
 * Trackpr Phase 5D-4 - SMS Cost. A separate section, below the AI cost
 * section - never merged into it. There is no "Unpriced" state here (unlike
 * AI): Twilio's own fetched price is the authoritative cost directly, with
 * no rate_cards lookup involved - a message either has a real, known cost or
 * it doesn't (no provider SID, a permanently failed fetch, or a price Twilio
 * hadn't finalized at the one best-effort attempt this phase makes -
 * automatic reconciliation is explicitly deferred to a future phase).
 *
 * Agency redesign: the agency-wide SMS totals moved into the page's
 * headline StatGrid (CostHeadline); this section is the per-client table.
 */
export function SmsCostSummary({ clients, unavailable }: { clients: ClientSmsCostSummary[]; unavailable: boolean }) {
  const sorted = [...clients].sort((a, b) => b.knownMessageCount + b.unknownMessageCount - (a.knownMessageCount + a.unknownMessageCount));

  return (
    <SectionCard
      title="SMS cost by client"
      description="Twilio's own price per message - no rate card, no estimate. Busiest client first."
      action={clients.length > 0 ? <span className="shrink-0 text-xs text-ink-3">{clients.length} client{clients.length === 1 ? "" : "s"}</span> : undefined}
    >
      {sorted.length === 0 ? (
        <EmptyState icon={Building2} title="No managed clients yet" description="Once a client organization is connected to the agency, its SMS cost will appear here." />
      ) : (
        <>
          <Table columns={COLUMNS}>
            <TableHeadCell>Client</TableHeadCell>
            <TableHeadCell>Data</TableHeadCell>
            <TableHeadCell align="right">Known cost</TableHeadCell>
            <TableHeadCell align="right">Known messages</TableHeadCell>
            <TableHeadCell align="right">Unknown messages</TableHeadCell>
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
                <TableCell align="right">{countValue(client.knownMessageCount, unavailable)}</TableCell>
                <TableCell align="right">{countValue(client.unknownMessageCount, unavailable)}</TableCell>
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
                    <span className="col-span-2">
                      Known cost <span className="ml-1 font-medium tabular-nums text-ink">{costValue(client.knownCost, unavailable)}</span>
                    </span>
                    <span>
                      Known <span className="ml-1 font-medium tabular-nums text-ink">{countValue(client.knownMessageCount, unavailable)}</span>
                    </span>
                    <span>
                      Unknown <span className="ml-1 font-medium tabular-nums text-ink">{countValue(client.unknownMessageCount, unavailable)}</span>
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

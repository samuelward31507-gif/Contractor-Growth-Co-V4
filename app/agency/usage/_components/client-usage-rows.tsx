import Link from "next/link";
import { AlertTriangle, Building2 } from "lucide-react";
import { RAIL_TONE_CLASS, Badge } from "@/lib/ui/badge";
import { EmptyState } from "@/lib/ui/empty-state";
import { Table, TableBody, TableHeadCell, TableRow } from "@/lib/ui/table";
import type { ClientUsageSummary } from "@/lib/agency/usage";
import { formatNullableCount } from "./format";
import { formatRate, formatCount } from "../../_components/format";

/**
 * Trackpr Phase 5B: the client usage list - desktop table / mobile stacked
 * list split (`hidden lg:block` / `lg:hidden`), a warning rail on any client
 * whose own data is partial.
 *
 * Agency redesign: the desktop half now renders through the shared table
 * primitives (lib/ui/table.tsx). Business activity moved under the client
 * name so the numeric columns keep their room at narrower desktop widths.
 * Every figure, every "Unavailable" and every "Partial" marker is the same
 * as before.
 */
const COLUMNS = "grid-cols-[minmax(0,1.8fr)_repeat(4,minmax(0,1fr))_88px]";

/**
 * Only reachable when the agency has zero authorized client organizations at
 * all - a client with genuinely zero recorded usage still gets its own row
 * (0 is a real, displayable value), so this never fires just because usage
 * happens to be quiet.
 */
function NoClientsState() {
  return (
    <EmptyState
      icon={Building2}
      title="No client organizations are connected yet."
      description="Once a client organization is associated with the agency, its usage will appear here."
    />
  );
}

export function ClientUsageRows({ clients }: { clients: ClientUsageSummary[] }) {
  if (clients.length === 0) {
    return <NoClientsState />;
  }

  return (
    <div>
      <Table columns={COLUMNS}>
        <TableHeadCell>Client</TableHeadCell>
        <TableHeadCell align="right">Messages</TableHeadCell>
        <TableHeadCell align="right">AI interactions</TableHeadCell>
        <TableHeadCell align="right">Automation</TableHeadCell>
        <TableHeadCell align="right">Missed calls</TableHeadCell>
        <TableHeadCell>Data</TableHeadCell>
      </Table>
      <TableBody>
        {clients.map((client) => (
          <ClientUsageRowDesktop key={client.organizationId} client={client} />
        ))}
      </TableBody>

      <ul className="divide-y divide-line lg:hidden">
        {clients.map((client) => (
          <ClientUsageRowMobile key={client.organizationId} client={client} />
        ))}
      </ul>
    </div>
  );
}

function operationalSummary(client: ClientUsageSummary): string {
  const { leads, appointments, estimates, jobs } = client.operational;
  return `${formatCount(leads)} leads · ${formatCount(appointments)} appts · ${formatCount(estimates)} estimates · ${formatCount(jobs)} jobs`;
}

function PartialBadge() {
  return (
    <Badge tone="warning" icon={AlertTriangle}>
      Partial
    </Badge>
  );
}

const NUMBER_CELL = "min-w-0 text-right text-sm tabular-nums text-ink";
const SUB_LINE = "block truncate text-[11px] text-ink-3";

function ClientUsageRowDesktop({ client }: { client: ClientUsageSummary }) {
  return (
    <TableRow href={`/agency/organizations/${client.organizationId}`} columns={COLUMNS} tone={client.dataQuality.partialData ? "warning" : "neutral"}>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-ink">{client.organizationName}</span>
        <span className="block truncate text-xs text-ink-3">{operationalSummary(client)}</span>
      </span>

      <span className={NUMBER_CELL}>
        {formatCount(client.messaging.total)}
        <span className={SUB_LINE}>
          {formatCount(client.messaging.inbound)} in / {formatCount(client.messaging.outbound)} out
        </span>
      </span>

      {/* Phase 3E: an unreadable AI read shows as Unavailable, never as zero usage. */}
      <span className={NUMBER_CELL}>
        {client.ai.unavailable ? (
          <span className="text-ink-3">Unavailable</span>
        ) : (
          <>
            {formatCount(client.ai.interactions)}
            <span className={SUB_LINE}>{formatNullableCount(client.ai.tokens)} tokens</span>
          </>
        )}
      </span>

      <span className={NUMBER_CELL}>
        {formatCount(client.automation.executions)}
        <span className={SUB_LINE}>{formatRate(client.automation.successRate)} success</span>
      </span>

      <span className={NUMBER_CELL}>{client.voice.missedCalls === null ? <span className="text-ink-3">Unavailable</span> : formatCount(client.voice.missedCalls)}</span>

      <span>
        {client.dataQuality.partialData ? (
          <PartialBadge />
        ) : (
          <span className="text-xs text-ink-4">
            <span aria-hidden>—</span>
            <span className="sr-only">Complete</span>
          </span>
        )}
      </span>
    </TableRow>
  );
}

function ClientUsageRowMobile({ client }: { client: ClientUsageSummary }) {
  const railTone = client.dataQuality.partialData ? "warning" : "neutral";

  return (
    <li>
      <Link
        href={`/agency/organizations/${client.organizationId}`}
        className={`flex items-start gap-3 border-l-2 py-3.5 pl-3 pr-2 transition-colors hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${RAIL_TONE_CLASS[railTone]}`}
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium text-ink">{client.organizationName}</span>
            {client.dataQuality.partialData ? <PartialBadge /> : null}
          </span>
          <span className="mt-1 block text-xs tabular-nums text-ink-3">
            {formatCount(client.messaging.total)} messages · {client.ai.unavailable ? "AI unavailable" : `${formatCount(client.ai.interactions)} AI`} · {formatCount(client.automation.executions)} automation ·{" "}
            {client.voice.missedCalls === null ? "missed calls unavailable" : `${formatCount(client.voice.missedCalls)} missed calls`}
          </span>
          <span className="mt-0.5 block text-xs text-ink-3">{operationalSummary(client)}</span>
        </span>
      </Link>
    </li>
  );
}

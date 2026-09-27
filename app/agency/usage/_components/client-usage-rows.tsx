import Link from "next/link";
import { ChevronRight, AlertTriangle, Search } from "lucide-react";
import { RAIL_TONE_CLASS } from "@/lib/ui/badge";
import { EmptyState } from "@/lib/ui/empty-state";
import type { ClientUsageSummary } from "@/lib/agency/usage";
import { formatNullableCount } from "./format";
import { formatRate, formatCount } from "../../_components/format";

/**
 * Trackpr Phase 5B: mirrors app/agency/_components/client-operations.tsx's
 * exact desktop-grid / mobile-stacked-list pattern (same rail-color
 * convention, same `hidden lg:block` / `lg:hidden` split) rather than a new
 * table primitive - this is the established Agency Command Center list
 * shape, just with usage columns instead of health/stage columns.
 */
const ROW_GRID = "grid-cols-[minmax(0,1.2fr)_110px_110px_120px_90px_minmax(0,1.3fr)_70px_20px]";

/**
 * Only reachable when the agency has zero authorized client organizations at
 * all - a client with genuinely zero recorded usage still gets its own row
 * (0 is a real, displayable value), so this never fires just because usage
 * happens to be quiet.
 */
function NoClientsState() {
  return (
    <EmptyState
      icon={Search}
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
      <div className="hidden lg:block">
        <div className={`grid ${ROW_GRID} items-center gap-3 border-b border-l-2 border-l-transparent border-slate-200 pl-3 pr-2 pb-3`}>
          <span className="text-xs text-slate-400">Client</span>
          <span className="text-right text-xs text-slate-400">Messages</span>
          <span className="text-right text-xs text-slate-400">AI interactions</span>
          <span className="text-right text-xs text-slate-400">Automation</span>
          <span className="text-right text-xs text-slate-400">Missed calls</span>
          <span className="text-xs text-slate-400">Business activity</span>
          <span className="text-xs text-slate-400">Data</span>
          <span />
        </div>
        <div className="divide-y divide-slate-100">
          {clients.map((client) => (
            <ClientUsageRowDesktop key={client.organizationId} client={client} />
          ))}
        </div>
      </div>

      <ul className="divide-y divide-slate-100 lg:hidden">
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

function ClientUsageRowDesktop({ client }: { client: ClientUsageSummary }) {
  const railTone = client.dataQuality.partialData ? "warning" : "neutral";

  return (
    <Link
      href={`/agency/organizations/${client.organizationId}`}
      className={`group grid ${ROW_GRID} items-center gap-3 rounded-r-md border-l-2 py-3.5 pl-3 pr-2 transition-colors hover:bg-slate-50 ${RAIL_TONE_CLASS[railTone]}`}
    >
      <span className="min-w-0 truncate text-sm font-medium text-slate-900">{client.organizationName}</span>

      <span className="text-right text-xs tabular-nums text-slate-700">
        {formatCount(client.messaging.total)}
        <span className="block text-[11px] text-slate-400">
          {formatCount(client.messaging.inbound)} in / {formatCount(client.messaging.outbound)} out
        </span>
      </span>

      <span className="text-right text-xs tabular-nums text-slate-700">
        {formatCount(client.ai.interactions)}
        <span className="block text-[11px] text-slate-400">{formatNullableCount(client.ai.tokens)} tokens</span>
      </span>

      <span className="text-right text-xs tabular-nums text-slate-700">
        {formatCount(client.automation.executions)}
        <span className="block text-[11px] text-slate-400">{formatRate(client.automation.successRate)} success</span>
      </span>

      <span className="text-right text-xs tabular-nums text-slate-700">
        {client.voice.missedCalls === null ? <span className="text-slate-400">Unavailable</span> : formatCount(client.voice.missedCalls)}
      </span>

      <span className="truncate text-xs text-slate-500">{operationalSummary(client)}</span>

      <span>
        {client.dataQuality.partialData ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600">
            <AlertTriangle className="h-3 w-3" aria-hidden />
            Partial
          </span>
        ) : (
          <span className="text-xs text-slate-300">—</span>
        )}
      </span>

      <ChevronRight className="h-4 w-4 shrink-0 justify-self-end text-slate-300 transition-colors group-hover:text-slate-500" aria-hidden />
    </Link>
  );
}

function ClientUsageRowMobile({ client }: { client: ClientUsageSummary }) {
  const railTone = client.dataQuality.partialData ? "warning" : "neutral";

  return (
    <li>
      <Link href={`/agency/organizations/${client.organizationId}`} className={`flex items-start gap-3 border-l-2 py-3.5 pl-3 pr-2 ${RAIL_TONE_CLASS[railTone]}`}>
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium text-slate-900">{client.organizationName}</span>
            {client.dataQuality.partialData ? (
              <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-amber-600">
                <AlertTriangle className="h-3 w-3" aria-hidden />
                Partial
              </span>
            ) : null}
          </span>
          <span className="mt-1 block text-xs tabular-nums text-slate-500">
            {formatCount(client.messaging.total)} messages · {formatCount(client.ai.interactions)} AI · {formatCount(client.automation.executions)} automation ·{" "}
            {client.voice.missedCalls === null ? "missed calls unavailable" : `${formatCount(client.voice.missedCalls)} missed calls`}
          </span>
          <span className="mt-0.5 block text-xs text-slate-400">{operationalSummary(client)}</span>
        </span>
      </Link>
    </li>
  );
}

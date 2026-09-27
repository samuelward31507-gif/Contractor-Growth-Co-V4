import Link from "next/link";
import { sectionLabelClass, metaClass } from "@/lib/ui/typography";
import { formatCount } from "../../_components/format";
import { formatCostAmounts } from "./format";
import type { ClientAiCostSummary } from "@/lib/agency/costs";

const QUALITY_LABEL: Record<ClientAiCostSummary["dataQuality"], string> = {
  known: "Known",
  unknown: "Unknown",
  partial: "Partial",
};

const QUALITY_TONE: Record<ClientAiCostSummary["dataQuality"], string> = {
  known: "text-accent-text",
  unknown: "text-slate-400",
  partial: "text-amber-600",
};

/**
 * Trackpr Phase 5D-2 - Client Cost. Busiest (by resolved interaction count)
 * first. No per-organization drill-down page is created for this phase - the
 * organization name links to the existing
 * /agency/organizations/[organizationId] page, matching
 * app/agency/revenue/_components/client-revenue-table.tsx's own convention.
 */
export function ClientCostTable({ clients }: { clients: ClientAiCostSummary[] }) {
  const sorted = [...clients].sort(
    (a, b) => b.knownInteractionCount + b.unpricedInteractionCount + b.unknownInteractionCount - (a.knownInteractionCount + a.unpricedInteractionCount + a.unknownInteractionCount),
  );

  return (
    <div className="mt-8">
      <div className="flex items-baseline justify-between">
        <p className={sectionLabelClass}>Client cost</p>
        {clients.length > 0 ? <span className={metaClass}>{clients.length} client{clients.length === 1 ? "" : "s"}</span> : null}
      </div>

      {sorted.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">No managed clients yet.</p>
      ) : (
        <div className="mt-2 space-y-3">
          {sorted.map((client) => (
            <div key={client.organizationId} className="rounded-lg border border-slate-200 px-5 py-4">
              <div className="flex items-center justify-between gap-3">
                <Link href={`/agency/organizations/${client.organizationId}`} className="text-sm font-semibold text-slate-900 hover:underline">
                  {client.organizationName}
                </Link>
                <span className={`text-xs font-medium ${QUALITY_TONE[client.dataQuality]}`}>{QUALITY_LABEL[client.dataQuality]}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs">
                <span className="text-slate-500">
                  Known cost <span className="ml-1 font-medium text-slate-800">{formatCostAmounts(client.knownCost)}</span>
                </span>
                <span className="text-slate-500">
                  Known interactions <span className="ml-1 font-medium text-slate-800">{formatCount(client.knownInteractionCount)}</span>
                </span>
                <span className="text-slate-500">
                  Unpriced <span className="ml-1 font-medium text-slate-800">{formatCount(client.unpricedInteractionCount)}</span>
                </span>
                <span className="text-slate-500">
                  Unknown <span className="ml-1 font-medium text-slate-800">{formatCount(client.unknownInteractionCount)}</span>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

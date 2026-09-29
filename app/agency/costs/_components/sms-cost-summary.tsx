import Link from "next/link";
import { sectionLabelClass, metaClass } from "@/lib/ui/typography";
import { Row } from "../../_components/row";
import { formatCount } from "../../_components/format";
import { formatCostAmounts } from "./format";
import type { AgencySmsCostTotals, ClientSmsCostSummary } from "@/lib/agency/costs";

const QUALITY_LABEL: Record<ClientSmsCostSummary["dataQuality"], string> = {
  known: "Known",
  unknown: "Unknown",
  partial: "Partial",
};

const QUALITY_TONE: Record<ClientSmsCostSummary["dataQuality"], string> = {
  known: "text-accent-text",
  unknown: "text-ink-3",
  partial: "text-warning",
};

/**
 * Trackpr Phase 5D-4 - SMS Cost. A separate section, below the existing AI
 * Cost section (untouched) - never merged into it, never reusing its
 * components. There is no "Unpriced" state here (unlike AI): Twilio's own
 * fetched price is the authoritative cost directly, with no rate_cards
 * lookup involved - a message either has a real, known cost or it doesn't
 * (no provider SID, a permanently failed fetch, or a price Twilio hadn't
 * finalized at the one best-effort attempt this phase makes - automatic
 * reconciliation is explicitly deferred to a future phase).
 */
export function SmsCostSummary({ totals, clients }: { totals: AgencySmsCostTotals; clients: ClientSmsCostSummary[] }) {
  const sorted = [...clients].sort((a, b) => b.knownMessageCount + b.unknownMessageCount - (a.knownMessageCount + a.unknownMessageCount));

  return (
    <div className="mt-8 border-t border-line pt-8">
      <p className={sectionLabelClass}>SMS cost</p>
      <div className="mt-2 divide-y divide-line">
        <Row label="Known SMS cost" value={formatCostAmounts(totals.knownCost)} tone="success" />
        <Row label="Known SMS messages" value={formatCount(totals.knownMessageCount)} description="A real Twilio-confirmed price, for either direction" />
        <Row label="Unknown SMS messages" value={formatCount(totals.unknownMessageCount)} description="No provider SID, a failed fetch, or a price not yet finalized - never shown as $0" />
      </div>

      <div className="mt-6">
        <div className="flex items-baseline justify-between">
          <p className={sectionLabelClass}>Client SMS cost</p>
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
                  <span className={`text-xs font-medium ${QUALITY_TONE[client.dataQuality]}`}>{QUALITY_LABEL[client.dataQuality]}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs">
                  <span className="text-ink-3">
                    Known cost <span className="ml-1 font-medium text-ink">{formatCostAmounts(client.knownCost)}</span>
                  </span>
                  <span className="text-ink-3">
                    Known messages <span className="ml-1 font-medium text-ink">{formatCount(client.knownMessageCount)}</span>
                  </span>
                  <span className="text-ink-3">
                    Unknown messages <span className="ml-1 font-medium text-ink">{formatCount(client.unknownMessageCount)}</span>
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

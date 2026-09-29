import { sectionLabelClass } from "@/lib/ui/typography";
import { Row } from "../../_components/row";
import { formatCurrencyAmounts } from "./format";
import type { RevenueTotals } from "@/lib/agency/revenue";

/**
 * Trackpr Phase 5D-1 - agency-wide Revenue Summary. Every figure here comes
 * straight from revenue_events via lib/agency/revenue.ts - never estimates,
 * never current Price IDs, never subscription config. A failed payment is
 * always shown in its own row, visually and numerically separate from
 * collected/net - never combined into either, so this page can never imply a
 * failed charge was actually collected.
 */
export function RevenueSummary({ totals }: { totals: RevenueTotals }) {
  return (
    <div className="mt-6 border-y border-line py-4">
      <p className={sectionLabelClass}>Revenue summary</p>
      <div className="mt-2 divide-y divide-line">
        <Row label="Collected" value={formatCurrencyAmounts(totals.collected)} />
        <Row label="— Setup fees" value={formatCurrencyAmounts(totals.setupCollected)} />
        <Row label="— Recurring" value={formatCurrencyAmounts(totals.recurringCollected)} />
        <Row label="— Uncategorized" value={formatCurrencyAmounts(totals.uncategorizedCollected)} description="Category could not be determined (e.g. a first invoice mixing setup + recurring) - never guessed" />
        <Row label="Refunded" value={formatCurrencyAmounts(totals.refunded)} tone={totals.refunded.some((a) => a.amount > 0) ? "warning" : "default"} />
        <Row label="Net collected" value={formatCurrencyAmounts(totals.netCollected)} tone="success" />
        <Row label="Failed payment attempts" value={formatCurrencyAmounts(totals.failedAttempted)} description="Never collected - shown separately, never part of Collected or Net collected" />
      </div>
    </div>
  );
}

import { sectionLabelClass } from "@/lib/ui/typography";
import { Row } from "../../_components/row";
import { formatCount } from "../../_components/format";
import { formatCostAmounts } from "./format";
import type { AgencyAiCostTotals } from "@/lib/agency/costs";

/**
 * Trackpr Phase 5D-2 - agency-wide AI Cost summary. Known Cost is the only
 * dollar figure this section ever shows - Unpriced/Unknown are always plain
 * counts, never a dollar amount, never $0. Mirrors
 * app/agency/revenue/_components/revenue-summary.tsx's own honesty
 * discipline.
 */
export function AiCostSummary({ totals }: { totals: AgencyAiCostTotals }) {
  return (
    <div className="mt-6 border-y border-slate-200 py-4">
      <p className={sectionLabelClass}>AI cost</p>
      <div className="mt-2 divide-y divide-slate-100">
        <Row label="Known AI cost" value={formatCostAmounts(totals.knownCost)} tone="success" />
        <Row label="Known AI interactions" value={formatCount(totals.knownInteractionCount)} description="Real usage, trusted provider/model, and a matching rate card" />
        <Row label="Unpriced" value={formatCount(totals.unpricedInteractionCount)} description="Real usage from a trusted provider, but no rate card covers this period - never shown as $0" />
        <Row label="Unknown" value={formatCount(totals.unknownInteractionCount)} description="Usage or provider/model identity could not be reliably established - never shown as $0" />
      </div>
    </div>
  );
}

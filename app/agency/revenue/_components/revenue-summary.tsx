import { Ban, CircleDollarSign, RotateCcw, Wallet } from "lucide-react";
import { StatGrid, StatCard } from "@/lib/ui/stat-card";
import { SectionCard } from "@/lib/ui/section-card";
import { Row } from "../../_components/row";
import { formatCurrencyAmounts } from "./format";
import type { CurrencyAmount, RevenueTotals } from "@/lib/agency/revenue";

/**
 * Shown in place of a figure when the revenue read failed. A failed read
 * returns no rows at all (lib/agency/revenue.ts's loadRevenueEvents), so the
 * totals computed from it are placeholders - rendering them would show a
 * confident $0.00 that was never measured.
 */
export const UNAVAILABLE = "—";
const UNAVAILABLE_NOTE = "Unavailable - revenue data could not be loaded";

export function revenueValue(amounts: CurrencyAmount[], unavailable: boolean): string {
  return unavailable ? UNAVAILABLE : formatCurrencyAmounts(amounts);
}

/**
 * Trackpr Phase 5D-1 - agency-wide Revenue Summary. Every figure here comes
 * straight from revenue_events via lib/agency/revenue.ts - never estimates,
 * never current Price IDs, never subscription config. A failed payment is
 * always shown in its own card, visually and numerically separate from
 * collected/net - never combined into either, so this page can never imply a
 * failed charge was actually collected.
 *
 * Agency redesign: the headline figures sit in the shared StatGrid; the
 * collected-by-category breakdown keeps the label/value Row list inside a
 * SectionCard.
 */
export function RevenueHeadline({ totals, unavailable }: { totals: RevenueTotals; unavailable: boolean }) {
  return (
    <StatGrid columns={4}>
      <StatCard
        label="Net collected"
        value={revenueValue(totals.netCollected, unavailable)}
        description={unavailable ? UNAVAILABLE_NOTE : "Collected minus refunds"}
        tone="success"
        icon={Wallet}
      />
      <StatCard
        label="Collected"
        value={revenueValue(totals.collected, unavailable)}
        description={unavailable ? UNAVAILABLE_NOTE : "Successful Stripe payments"}
        icon={CircleDollarSign}
      />
      <StatCard
        label="Refunded"
        value={revenueValue(totals.refunded, unavailable)}
        description={unavailable ? UNAVAILABLE_NOTE : "Stripe refunds"}
        tone={!unavailable && totals.refunded.some((a) => a.amount > 0) ? "warning" : "neutral"}
        icon={RotateCcw}
      />
      <StatCard
        label="Failed payment attempts"
        value={revenueValue(totals.failedAttempted, unavailable)}
        description={unavailable ? UNAVAILABLE_NOTE : "Never collected - not part of Collected or Net collected"}
        tone="danger"
        icon={Ban}
      />
    </StatGrid>
  );
}

export function CollectedByCategory({ totals, unavailable }: { totals: RevenueTotals; unavailable: boolean }) {
  return (
    <SectionCard title="Collected by category" description="How collected revenue splits between one-time setup fees and recurring charges.">
      <div className="divide-y divide-line">
        <Row label="Setup fees" value={revenueValue(totals.setupCollected, unavailable)} />
        <Row label="Recurring" value={revenueValue(totals.recurringCollected, unavailable)} />
        <Row label="Uncategorized" value={revenueValue(totals.uncategorizedCollected, unavailable)} />
      </div>
      <p className="mt-2 text-xs text-ink-3">Uncategorized: the category could not be determined (e.g. a first invoice mixing setup + recurring) - never guessed.</p>
    </SectionCard>
  );
}

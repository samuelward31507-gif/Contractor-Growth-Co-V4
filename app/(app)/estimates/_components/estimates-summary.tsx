import { Wallet, CheckCircle2 } from "lucide-react";
import { StatGrid, StatCard } from "@/lib/ui/stat-card";
import { sectionLabelClass } from "@/lib/ui/typography";
import { formatCurrency } from "@/lib/dashboard/format";
import type { EstimateSummary } from "@/lib/estimates/queries";

/**
 * Final visual polish pass: the five PRIMARY overview metrics get their own
 * bordered StatCard (lib/ui/stat-card.tsx) instead of the old special-cased
 * "Pipeline value" headline plus a `dl.flex.flex-wrap` row - on a wide
 * desktop viewport that old layout left every number clustered in one
 * left-aligned cluster instead of using the available width. Pipeline value
 * (every open, not-yet-decided estimate's amount - mirrors LeadsSummary's
 * own openValue derivation) and Accepted value both get the success-tone
 * icon chip since they're the two genuinely positive money signals here;
 * total/drafts/awaiting response stay neutral so the accent doesn't spread
 * across every card. Never "Revenue" - this is quoted, not collected, money.
 */
export function EstimatesSummary({ summary }: { summary: EstimateSummary }) {
  return (
    <div>
      <p className={sectionLabelClass}>Overview</p>
      <StatGrid columns={5} className="mt-3">
        <StatCard label="Pipeline value" value={formatCurrency(summary.openValue)} tone="success" icon={Wallet} />
        <StatCard label="Total estimates" value={summary.total} />
        <StatCard label="Drafts" value={summary.draftCount} />
        <StatCard label="Awaiting response" value={summary.sentCount} />
        <StatCard label="Accepted value" value={formatCurrency(summary.acceptedValue)} tone="success" icon={CheckCircle2} />
      </StatGrid>
    </div>
  );
}

import { Flame, Wallet } from "lucide-react";
import { StatGrid, StatCard } from "@/lib/ui/stat-card";
import { sectionLabelClass } from "@/lib/ui/typography";
import { formatCurrency } from "@/lib/dashboard/format";
import type { LeadSummary } from "@/lib/leads/queries";

/**
 * Final visual polish pass: the four PRIMARY overview metrics get their own
 * bordered StatCard (lib/ui/stat-card.tsx) instead of the old inline
 * label/value strip, so pipeline value and lead counts use the available
 * desktop width instead of clustering in one left-aligned row. Hot leads
 * and open opportunity value get a success-tone icon chip - both are
 * genuinely positive signals worth calling out; total/new stay neutral so
 * the accent doesn't spread across every card.
 */
export function LeadsSummary({ summary }: { summary: LeadSummary }) {
  return (
    <div>
      <p className={sectionLabelClass}>Overview</p>
      <StatGrid columns={4} className="mt-3">
        <StatCard label="Total leads" value={summary.total} />
        <StatCard label="New leads" value={summary.newCount} />
        <StatCard label="Hot leads" value={summary.hotCount} tone="success" icon={Flame} />
        <StatCard label="Open opportunity value" value={formatCurrency(summary.openValue)} tone="success" icon={Wallet} />
      </StatGrid>
    </div>
  );
}

import { Flame, Wallet } from "lucide-react";
import { sectionLabelClass } from "@/lib/ui/typography";
import { HeroStatRow } from "@/lib/ui/hero-stat-row";
import { formatCurrency } from "@/lib/dashboard/format";
import type { LeadSummary } from "@/lib/leads/queries";

/**
 * Hot leads are the one number on this page that means "act now," so they
 * lead via lib/ui/hero-stat-row.tsx rather than competing at equal visual
 * weight with total/new/open-value in a uniform grid.
 */
export function LeadsSummary({ summary }: { summary: LeadSummary }) {
  return (
    <div>
      <p className={sectionLabelClass}>Overview</p>
      <div className="mt-3">
        <HeroStatRow
          hero={{ label: "Hot leads", value: summary.hotCount, icon: Flame, tone: "danger" }}
          secondary={[
            { label: "Total leads", value: summary.total },
            { label: "New", value: summary.newCount },
            { label: "Open value", value: formatCurrency(summary.openValue), icon: Wallet },
          ]}
        />
      </div>
    </div>
  );
}

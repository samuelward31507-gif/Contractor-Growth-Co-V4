import { Wallet, CheckCircle2, FileText, Clock } from "lucide-react";
import { HeroStatRow, type HeroStatTone } from "@/lib/ui/hero-stat-row";
import { sectionLabelClass } from "@/lib/ui/typography";
import { formatCurrency } from "@/lib/dashboard/format";
import type { EstimateSummary } from "@/lib/estimates/queries";

/**
 * "Awaiting response" is the one number on this page that means "follow up" -
 * a sent estimate sitting with no customer decision yet - so it leads via
 * lib/ui/hero-stat-row.tsx. Pipeline value stays close behind in the
 * secondary strip rather than also competing for the hero slot: it's a
 * magnitude to track, not an action to take today.
 */
export function EstimatesSummary({ summary }: { summary: EstimateSummary }) {
  const heroTone: HeroStatTone = summary.sentCount > 0 ? "warning" : "neutral";

  return (
    <div>
      <p className={sectionLabelClass}>Overview</p>
      <div className="mt-3">
        <HeroStatRow
          hero={{ label: "Awaiting response", value: summary.sentCount, icon: Clock, tone: heroTone }}
          secondary={[
            { label: "Pipeline value", value: formatCurrency(summary.openValue), icon: Wallet },
            { label: "Total estimates", value: summary.total, icon: FileText },
            { label: "Drafts", value: summary.draftCount },
            { label: "Accepted value", value: formatCurrency(summary.acceptedValue), icon: CheckCircle2 },
          ]}
        />
      </div>
    </div>
  );
}

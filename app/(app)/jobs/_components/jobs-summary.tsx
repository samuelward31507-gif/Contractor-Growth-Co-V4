import { Wallet, CalendarClock, Hammer } from "lucide-react";
import { HeroStatRow, type HeroStatTone } from "@/lib/ui/hero-stat-row";
import { sectionLabelClass } from "@/lib/ui/typography";
import { formatCurrency } from "@/lib/dashboard/format";
import type { JobSummary } from "@/lib/jobs/queries";

/**
 * "In progress" is the operationally relevant number here - work actively
 * happening right now - so it leads via lib/ui/hero-stat-row.tsx. It's an
 * "info" tone, not "success": active work is a fact, not yet a positive
 * outcome - completed value keeps that money-positive tone in the secondary
 * strip instead.
 */
export function JobsSummary({ summary }: { summary: JobSummary }) {
  const heroTone: HeroStatTone = summary.inProgressCount > 0 ? "info" : "neutral";

  return (
    <div>
      <p className={sectionLabelClass}>Overview</p>
      <div className="mt-3">
        <HeroStatRow
          hero={{ label: "In progress", value: summary.inProgressCount, icon: Hammer, tone: heroTone }}
          secondary={[
            { label: "Total jobs", value: summary.total },
            { label: "Scheduled", value: summary.scheduledCount, icon: CalendarClock },
            { label: "Completed value", value: formatCurrency(summary.completedValue), icon: Wallet },
          ]}
        />
      </div>
    </div>
  );
}

import { Wallet } from "lucide-react";
import { StatGrid, StatCard } from "@/lib/ui/stat-card";
import { sectionLabelClass } from "@/lib/ui/typography";
import { formatCurrency } from "@/lib/dashboard/format";
import type { JobSummary } from "@/lib/jobs/queries";

/**
 * Final visual polish pass: StatGrid/StatCard (lib/ui/stat-card.tsx) instead
 * of the old inline label/value strip - matches EstimatesSummary/
 * LeadsSummary so the app's overview rows read as one consistent system.
 * Completed value is the one genuinely positive money signal here, so it's
 * the only card with a success-tone icon chip; total/scheduled/in-progress
 * stay neutral.
 */
export function JobsSummary({ summary }: { summary: JobSummary }) {
  return (
    <div>
      <p className={sectionLabelClass}>Overview</p>
      <StatGrid columns={4} className="mt-3">
        <StatCard label="Total jobs" value={summary.total} />
        <StatCard label="Scheduled" value={summary.scheduledCount} />
        <StatCard label="In progress" value={summary.inProgressCount} />
        <StatCard label="Completed value" value={formatCurrency(summary.completedValue)} tone="success" icon={Wallet} />
      </StatGrid>
    </div>
  );
}

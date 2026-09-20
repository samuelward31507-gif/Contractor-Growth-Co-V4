import { sectionLabelClass } from "@/lib/ui/typography";
import { StatGrid, StatCard } from "@/lib/ui/stat-card";
import type { OverviewMetrics } from "@/lib/dashboard/queries";

const STATS: { key: keyof OverviewMetrics; label: string }[] = [
  { key: "newLeads", label: "New leads" },
  { key: "upcomingAppointments", label: "Upcoming appointments" },
  { key: "pendingEstimates", label: "Estimates pending" },
  { key: "openOpportunities", label: "Open opportunities" },
];

/**
 * Real counts, given room via StatGrid/StatCard (final polish pass) instead
 * of the old inline flex-wrap row - four primary metrics fill a single row
 * of boxed cards at desktop width rather than clustering left.
 */
export function OverviewStrip({ overview }: { overview: OverviewMetrics }) {
  return (
    <div className="border-t border-slate-200 pt-8">
      <p className={sectionLabelClass}>Business activity</p>
      <div className="mt-3">
        <StatGrid columns={4}>
          {STATS.map(({ key, label }) => (
            <StatCard key={key} label={label} value={overview[key]} />
          ))}
        </StatGrid>
      </div>
    </div>
  );
}

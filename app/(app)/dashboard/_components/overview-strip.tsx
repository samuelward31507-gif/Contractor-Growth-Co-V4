import { sectionLabelClass } from "@/lib/ui/typography";
import type { OverviewMetrics } from "@/lib/dashboard/queries";

const STATS: { key: keyof OverviewMetrics; label: string }[] = [
  { key: "newLeads", label: "New leads" },
  { key: "upcomingAppointments", label: "Upcoming appointments" },
  { key: "pendingEstimates", label: "Estimates pending" },
  { key: "openOpportunities", label: "Open opportunities" },
];

/**
 * Real counts, read as one integrated row directly on the page canvas - not
 * four boxed metric cards. The section label recedes (see sectionLabelClass)
 * so the numbers themselves carry the weight.
 */
export function OverviewStrip({ overview }: { overview: OverviewMetrics }) {
  return (
    <div>
      <p className={sectionLabelClass}>Business activity</p>
      <dl className="mt-3 flex flex-wrap gap-x-10 gap-y-4">
        {STATS.map(({ key, label }) => (
          <div key={key}>
            <dt className="text-xs text-slate-500">{label}</dt>
            <dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-slate-900">
              {overview[key]}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

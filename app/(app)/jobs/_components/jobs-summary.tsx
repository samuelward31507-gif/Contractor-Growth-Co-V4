import { sectionLabelClass, statLabelClass, statValueClass } from "@/lib/ui/typography";
import { formatCurrency } from "@/lib/dashboard/format";
import type { JobSummary } from "@/lib/jobs/queries";

const STATS: { key: keyof JobSummary; label: string; currency?: boolean }[] = [
  { key: "total", label: "Total jobs" },
  { key: "scheduledCount", label: "Scheduled" },
  { key: "inProgressCount", label: "In progress" },
  { key: "completedValue", label: "Completed value", currency: true },
];

/** One integrated row instead of boxed metric cards - matches EstimatesSummary/LeadsSummary. */
export function JobsSummary({ summary }: { summary: JobSummary }) {
  return (
    <div>
      <p className={sectionLabelClass}>Overview</p>
      <dl className="mt-3 flex flex-wrap gap-x-10 gap-y-4">
        {STATS.map(({ key, label, currency }) => (
          <div key={key}>
            <dt className={statLabelClass}>{label}</dt>
            <dd className={statValueClass}>{currency ? formatCurrency(summary[key]) : summary[key]}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

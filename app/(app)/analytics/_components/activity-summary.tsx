import { sectionLabelClass, statLabelClass, statValueClass } from "@/lib/ui/typography";
import type { ActivitySummary } from "@/lib/activity/queries";

const STATS: { key: keyof ActivitySummary; label: string }[] = [
  { key: "total", label: "Total activity" },
  { key: "today", label: "Today" },
  { key: "thisWeek", label: "This week" },
  { key: "userCount", label: "By your team" },
];

export function ActivitySummaryCards({ summary }: { summary: ActivitySummary }) {
  return (
    <div>
      <p className={sectionLabelClass}>Overview</p>
      <dl className="mt-3 flex flex-wrap gap-x-10 gap-y-4">
        {STATS.map(({ key, label }) => (
          <div key={key}>
            <dt className={statLabelClass}>{label}</dt>
            <dd className={statValueClass}>{summary[key]}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

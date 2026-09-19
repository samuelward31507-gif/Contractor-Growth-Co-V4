import { sectionLabelClass, statLabelClass, statValueClass } from "@/lib/ui/typography";
import type { AppointmentSummary } from "@/lib/appointments/queries";

const STATS: { key: keyof AppointmentSummary; label: string }[] = [
  { key: "upcoming", label: "Upcoming" },
  { key: "today", label: "Today" },
  { key: "completed", label: "Completed" },
  { key: "noShows", label: "No-shows" },
];

export function AppointmentsSummary({ summary }: { summary: AppointmentSummary }) {
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

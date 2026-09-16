import { cardClass } from "@/lib/ui/card";
import type { AppointmentSummary } from "@/lib/appointments/queries";

const CARDS: { key: keyof AppointmentSummary; label: string }[] = [
  { key: "upcoming", label: "Upcoming" },
  { key: "today", label: "Today" },
  { key: "completed", label: "Completed" },
  { key: "noShows", label: "No-Shows" },
];

export function AppointmentsSummary({ summary }: { summary: AppointmentSummary }) {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {CARDS.map(({ key, label }) => (
        <div key={key} className={`${cardClass} p-5`}>
          <p className="text-sm text-slate-500">{label}</p>
          <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">{summary[key]}</p>
        </div>
      ))}
    </div>
  );
}

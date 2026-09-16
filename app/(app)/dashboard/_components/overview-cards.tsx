import { cardClass } from "@/lib/ui/card";
import type { OverviewMetrics } from "@/lib/dashboard/queries";

const CARDS: { key: keyof OverviewMetrics; label: string }[] = [
  { key: "newLeads", label: "New Leads" },
  { key: "upcomingAppointments", label: "Upcoming Appointments" },
  { key: "pendingEstimates", label: "Estimates Pending" },
  { key: "openOpportunities", label: "Open Opportunities" },
];

export function OverviewCards({ overview }: { overview: OverviewMetrics }) {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {CARDS.map(({ key, label }) => (
        <div key={key} className={`${cardClass} p-5`}>
          <p className="text-sm text-slate-500">{label}</p>
          <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">{overview[key]}</p>
        </div>
      ))}
    </div>
  );
}

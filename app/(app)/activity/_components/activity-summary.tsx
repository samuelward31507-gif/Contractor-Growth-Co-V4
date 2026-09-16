import { cardClass } from "@/lib/ui/card";
import type { ActivitySummary } from "@/lib/activity/queries";

const CARDS: { key: keyof ActivitySummary; label: string }[] = [
  { key: "total", label: "Total Activity" },
  { key: "today", label: "Today" },
  { key: "thisWeek", label: "This Week" },
  { key: "userCount", label: "By Your Team" },
];

export function ActivitySummaryCards({ summary }: { summary: ActivitySummary }) {
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

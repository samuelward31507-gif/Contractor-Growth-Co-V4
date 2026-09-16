import { cardClass } from "@/lib/ui/card";
import { formatCurrency } from "@/lib/dashboard/format";
import type { LeadSummary } from "@/lib/leads/queries";

const CARDS: { key: keyof LeadSummary; label: string; currency?: boolean }[] = [
  { key: "total", label: "Total Leads" },
  { key: "newCount", label: "New Leads" },
  { key: "hotCount", label: "Hot Leads" },
  { key: "openValue", label: "Open Opportunity Value", currency: true },
];

export function LeadsSummary({ summary }: { summary: LeadSummary }) {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {CARDS.map(({ key, label, currency }) => (
        <div key={key} className={`${cardClass} p-5`}>
          <p className="text-sm text-slate-500">{label}</p>
          <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
            {currency ? formatCurrency(summary[key]) : summary[key]}
          </p>
        </div>
      ))}
    </div>
  );
}

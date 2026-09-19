import { sectionLabelClass, statLabelClass, statValueClass } from "@/lib/ui/typography";
import { formatCurrency } from "@/lib/dashboard/format";
import type { LeadSummary } from "@/lib/leads/queries";

const STATS: { key: keyof LeadSummary; label: string; currency?: boolean }[] = [
  { key: "total", label: "Total leads" },
  { key: "newCount", label: "New leads" },
  { key: "hotCount", label: "Hot leads" },
  { key: "openValue", label: "Open opportunity value", currency: true },
];

/**
 * One integrated row instead of four boxed metric cards - matches the
 * dashboard's overview strip.
 */
export function LeadsSummary({ summary }: { summary: LeadSummary }) {
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

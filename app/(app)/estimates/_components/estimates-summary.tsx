import { sectionLabelClass, statLabelClass, statValueClass } from "@/lib/ui/typography";
import { formatCurrency } from "@/lib/dashboard/format";
import type { EstimateSummary } from "@/lib/estimates/queries";

const STATS: { key: keyof EstimateSummary; label: string; currency?: boolean }[] = [
  { key: "total", label: "Total estimates" },
  { key: "draftCount", label: "Drafts" },
  { key: "sentCount", label: "Awaiting response" },
  { key: "acceptedValue", label: "Accepted value", currency: true },
];

/** One integrated row instead of boxed metric cards - matches LeadsSummary. */
export function EstimatesSummary({ summary }: { summary: EstimateSummary }) {
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

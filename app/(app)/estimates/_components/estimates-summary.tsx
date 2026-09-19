import { sectionLabelClass, statLabelClass, statValueClass } from "@/lib/ui/typography";
import { formatCurrency } from "@/lib/dashboard/format";
import type { EstimateSummary } from "@/lib/estimates/queries";

const STATS: { key: keyof EstimateSummary; label: string; currency?: boolean }[] = [
  { key: "total", label: "Total estimates" },
  { key: "draftCount", label: "Drafts" },
  { key: "sentCount", label: "Awaiting response" },
  { key: "acceptedValue", label: "Accepted value", currency: true },
];

/**
 * One integrated row instead of boxed metric cards - matches LeadsSummary.
 * Pipeline value (the sum of every open, not-yet-decided estimate's amount -
 * mirrors LeadsSummary's own openValue derivation) gets the same "strongest
 * number on the page" treatment the Leads/Estimates/Jobs detail pages give
 * their own headline amount, since it's the one figure here a contractor
 * most wants to see at a glance: how much is currently out for decision.
 * Never "Revenue" - this is quoted, not collected, money.
 */
export function EstimatesSummary({ summary }: { summary: EstimateSummary }) {
  return (
    <div>
      <p className={sectionLabelClass}>Overview</p>
      <div className="mt-3 flex flex-wrap items-start gap-x-10 gap-y-4">
        <div>
          <p className={statLabelClass}>Pipeline value</p>
          <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums text-slate-900">
            {formatCurrency(summary.openValue)}
          </p>
        </div>
        <dl className="flex flex-wrap gap-x-10 gap-y-4">
          {STATS.map(({ key, label, currency }) => (
            <div key={key}>
              <dt className={statLabelClass}>{label}</dt>
              <dd className={statValueClass}>{currency ? formatCurrency(summary[key]) : summary[key]}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

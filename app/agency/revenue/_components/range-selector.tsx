import Link from "next/link";

export type RevenueRangeKey = "today" | "month" | "lastMonth" | "lifetime";

const RANGE_OPTIONS: { key: RevenueRangeKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "month", label: "This month" },
  { key: "lastMonth", label: "Last month" },
  { key: "lifetime", label: "Lifetime" },
];

/**
 * Trackpr Phase 5D-1 - a plain preset switcher, matching this codebase's
 * "minimal, one surface" instruction for this phase rather than a full
 * date-picker. lib/agency/revenue.ts's getAgencyRevenue() itself already
 * accepts an arbitrary custom {from, to} range programmatically - only the
 * page's own UI is limited to these four presets for now.
 */
export function RangeSelector({ active }: { active: RevenueRangeKey }) {
  return (
    <div className="mt-4 flex flex-wrap gap-1.5">
      {RANGE_OPTIONS.map((option) => (
        <Link
          key={option.key}
          href={option.key === "lifetime" ? "/agency/revenue" : `/agency/revenue?range=${option.key}`}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            active === option.key ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
          }`}
        >
          {option.label}
        </Link>
      ))}
    </div>
  );
}

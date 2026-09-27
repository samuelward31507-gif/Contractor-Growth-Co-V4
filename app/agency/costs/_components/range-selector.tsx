import Link from "next/link";

export type CostRangeKey = "today" | "month" | "lastMonth" | "lifetime";

const RANGE_OPTIONS: { key: CostRangeKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "month", label: "This month" },
  { key: "lastMonth", label: "Last month" },
  { key: "lifetime", label: "Lifetime" },
];

/**
 * Trackpr Phase 5D-2 - own local copy of app/agency/revenue/_components/
 * range-selector.tsx's exact pattern, pointed at /agency/costs instead -
 * kept separate rather than shared so this phase never has to modify
 * anything under app/agency/revenue.
 */
export function RangeSelector({ active }: { active: CostRangeKey }) {
  return (
    <div className="mt-4 flex flex-wrap gap-1.5">
      {RANGE_OPTIONS.map((option) => (
        <Link
          key={option.key}
          href={option.key === "lifetime" ? "/agency/costs" : `/agency/costs?range=${option.key}`}
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

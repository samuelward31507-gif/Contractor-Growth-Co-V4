import Link from "next/link";
import { filterChipClass } from "@/lib/ui/filter-chip";

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
          aria-current={active === option.key ? "true" : undefined}
          className={filterChipClass(active === option.key)}
        >
          {option.label}
        </Link>
      ))}
    </div>
  );
}

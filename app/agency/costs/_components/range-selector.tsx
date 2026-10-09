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
 *
 * Agency redesign: one chip row that scrolls sideways inside its own
 * container on a phone, never the page. Same links, same hrefs.
 */
export function RangeSelector({ active }: { active: CostRangeKey }) {
  return (
    <nav aria-label="Cost period" className="-mx-4 flex w-[calc(100%+2rem)] flex-nowrap gap-1.5 overflow-x-auto px-4 sm:mx-0 sm:w-auto sm:px-0">
      {RANGE_OPTIONS.map((option) => (
        <Link
          key={option.key}
          href={option.key === "lifetime" ? "/agency/costs" : `/agency/costs?range=${option.key}`}
          aria-current={active === option.key ? "true" : undefined}
          className={`${filterChipClass(active === option.key)} shrink-0 whitespace-nowrap`}
        >
          {option.label}
        </Link>
      ))}
    </nav>
  );
}

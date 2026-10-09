import Link from "next/link";
import { filterChipClass } from "@/lib/ui/filter-chip";

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
 *
 * Agency redesign: the shared filter-chip row (lib/ui/filter-chip.ts), laid
 * out like Analytics' range tabs - one row that scrolls sideways inside its
 * own container on a phone, never the page. Same links, same hrefs.
 */
export function RangeSelector({ active }: { active: RevenueRangeKey }) {
  return (
    <nav aria-label="Revenue period" className="-mx-4 flex w-[calc(100%+2rem)] flex-nowrap gap-1.5 overflow-x-auto px-4 sm:mx-0 sm:w-auto sm:px-0">
      {RANGE_OPTIONS.map((option) => (
        <Link
          key={option.key}
          href={option.key === "lifetime" ? "/agency/revenue" : `/agency/revenue?range=${option.key}`}
          aria-current={active === option.key ? "true" : undefined}
          className={`${filterChipClass(active === option.key)} shrink-0 whitespace-nowrap`}
        >
          {option.label}
        </Link>
      ))}
    </nav>
  );
}

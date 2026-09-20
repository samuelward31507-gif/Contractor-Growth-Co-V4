import Link from "next/link";
import type { DateRangePreset } from "@/lib/bi/types";

const RANGE_OPTIONS: { value: DateRangePreset; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "last7Days", label: "Last 7 days" },
  { value: "last30Days", label: "Last 30 days" },
  { value: "currentMonth", label: "This month" },
  { value: "previousMonth", label: "Last month" },
  { value: "allTime", label: "All time" },
];

/**
 * Plain server-rendered links, not a client component - switching the
 * business-performance period is a navigation (new searchParams), not local
 * UI state, so no "use client"/JS is needed for it to work. buildHref
 * preserves every other current query param (the activity timeline's own
 * q/entityType/from/to/limit filters) so picking a period never resets the
 * timeline filters below it.
 */
export function RangeTabs({ current, buildHref }: { current: DateRangePreset; buildHref: (range: DateRangePreset) => string }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Business performance period">
      {RANGE_OPTIONS.map((option) => {
        const isActive = option.value === current;
        return (
          <Link
            key={option.value}
            href={buildHref(option.value)}
            role="tab"
            aria-selected={isActive}
            className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              isActive ? "bg-accent text-accent-foreground" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {option.label}
          </Link>
        );
      })}
    </div>
  );
}

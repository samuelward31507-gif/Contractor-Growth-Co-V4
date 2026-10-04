import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";
import { cardClass } from "@/lib/ui/surface";

const ROWS = Array.from({ length: 6 });

/**
 * Reserves the same header + overview-row + table rhythm as the real page
 * so nothing jumps when the real content swaps in - same convention as
 * app/(app)/estimates/loading.tsx.
 */
export default function LeadsLoading() {
  return (
    <div className={`${PAGE_CONTAINER_CLASS} gap-8 ${PAGE_MAX_WIDTH_CLASS}`}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="h-7 w-24 animate-pulse rounded bg-inset" />
          <div className="mt-2 h-4 w-64 max-w-full animate-pulse rounded bg-inset" />
        </div>
        <div className="h-10 w-32 animate-pulse rounded-lg bg-inset" />
      </div>

      {/* Mirrors lib/ui/hero-stat-row.tsx's shape - an emphasized callout
          beside a divided strip - not the old 4-item flex-wrap row. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,220px)_1fr]">
        <div className="h-[84px] animate-pulse rounded-lg bg-inset" />
        <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-line bg-inset">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="bg-surface px-5 py-4">
              <div className="h-2.5 w-16 animate-pulse rounded bg-inset" />
              <div className="mt-2 h-6 w-12 animate-pulse rounded bg-inset" />
            </div>
          ))}
        </div>
      </div>

      <div className={`${cardClass} p-4 sm:p-5`}>
        <div className="h-10 w-full max-w-sm animate-pulse rounded-lg bg-inset" />
        <div className="mt-5 divide-y divide-line">
          {ROWS.map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-2 py-3.5">
              <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-inset" />
              <div className="min-w-0 flex-1">
                <div className="h-3.5 w-48 animate-pulse rounded bg-inset" />
                <div className="mt-2 h-3 w-32 animate-pulse rounded bg-inset" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

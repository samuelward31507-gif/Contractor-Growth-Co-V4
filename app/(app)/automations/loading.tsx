import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";
import { cardClass } from "@/lib/ui/surface";

const SUMMARY_CARDS = Array.from({ length: 4 });
const ROWS = Array.from({ length: 6 });

/**
 * Reserves the same header + summary-strip + list rhythm as the real page
 * so nothing jumps when the real content swaps in.
 */
export default function AutomationsLoading() {
  return (
    <div className={`${PAGE_CONTAINER_CLASS} gap-6 ${PAGE_MAX_WIDTH_CLASS}`}>
      <div>
        <div className="h-6 w-40 animate-pulse rounded bg-inset" />
        <div className="mt-2 h-4 w-96 max-w-full animate-pulse rounded bg-inset" />
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {SUMMARY_CARDS.map((_, i) => (
          <div key={i} className={`${cardClass} px-3.5 py-2.5`}>
            <div className="h-2.5 w-20 animate-pulse rounded bg-inset" />
            <div className="mt-2 h-6 w-10 animate-pulse rounded bg-inset" />
          </div>
        ))}
      </div>

      <div className={`overflow-hidden ${cardClass}`}>
        <div className="divide-y divide-line">
          {ROWS.map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3.5">
              <div className="h-8 w-8 shrink-0 animate-pulse rounded-md bg-inset" />
              <div className="min-w-0 flex-1">
                <div className="h-3.5 w-48 animate-pulse rounded bg-inset" />
                <div className="mt-2 h-3 w-64 max-w-full animate-pulse rounded bg-inset" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const SUMMARY_CARDS = Array.from({ length: 4 });
const ROWS = Array.from({ length: 6 });

/**
 * Reserves the same header + summary-strip + list rhythm as the real page
 * so nothing jumps when the real content swaps in.
 */
export default function AutomationsLoading() {
  return (
    <div className="flex flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <div>
        <div className="h-6 w-40 animate-pulse rounded bg-slate-100" />
        <div className="mt-2 h-4 w-96 max-w-full animate-pulse rounded bg-slate-100" />
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {SUMMARY_CARDS.map((_, i) => (
          <div key={i} className="rounded-lg border border-slate-200 bg-white px-3.5 py-2.5">
            <div className="h-2.5 w-20 animate-pulse rounded bg-slate-100" />
            <div className="mt-2 h-6 w-10 animate-pulse rounded bg-slate-100" />
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="divide-y divide-slate-100">
          {ROWS.map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3.5">
              <div className="h-8 w-8 shrink-0 animate-pulse rounded-md bg-slate-100" />
              <div className="min-w-0 flex-1">
                <div className="h-3.5 w-48 animate-pulse rounded bg-slate-100" />
                <div className="mt-2 h-3 w-64 max-w-full animate-pulse rounded bg-slate-100" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

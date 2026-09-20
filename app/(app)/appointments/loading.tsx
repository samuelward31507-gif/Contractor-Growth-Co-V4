const ROWS = Array.from({ length: 6 });

/**
 * Reserves the same header + overview-row + toolbar + list rhythm as the
 * real page so nothing jumps when the real content swaps in - same
 * convention as app/(app)/estimates/loading.tsx and app/(app)/jobs/loading.tsx.
 */
export default function AppointmentsLoading() {
  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="h-7 w-40 animate-pulse rounded bg-slate-100" />
          <div className="mt-2 h-4 w-72 max-w-full animate-pulse rounded bg-slate-100" />
        </div>
        <div className="h-10 w-40 animate-pulse rounded-lg bg-slate-100" />
      </div>

      {/* Mirrors lib/ui/hero-stat-row.tsx's shape - an emphasized callout
          beside a divided strip - not a 4-up StatCard grid. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,220px)_1fr]">
        <div className="h-[84px] animate-pulse rounded-2xl bg-slate-100" />
        <div className="grid grid-cols-3 gap-px overflow-hidden rounded-2xl border border-slate-200 bg-slate-100">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="bg-white px-5 py-4">
              <div className="h-2.5 w-16 animate-pulse rounded bg-slate-100" />
              <div className="mt-2 h-6 w-12 animate-pulse rounded bg-slate-100" />
            </div>
          ))}
        </div>
      </div>

      <div className="border-t border-slate-200 pt-8">
        <div className="h-9 w-64 max-w-full animate-pulse rounded-lg bg-slate-100" />
        <div className="mt-3 h-10 w-full max-w-sm animate-pulse rounded-lg bg-slate-100" />
        <div className="mt-5 divide-y divide-slate-100">
          {ROWS.map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-2 py-3.5">
              <div className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-slate-100" />
              <div className="min-w-0 flex-1">
                <div className="h-3.5 w-48 animate-pulse rounded bg-slate-100" />
                <div className="mt-2 h-3 w-32 animate-pulse rounded bg-slate-100" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

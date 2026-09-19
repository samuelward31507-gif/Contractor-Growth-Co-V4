const SKELETON_CARDS = Array.from({ length: 8 });

/**
 * Reserves the same header + card rhythm as the real page (icon badge,
 * title block, then a bordered overview card) so nothing jumps when the
 * real content swaps in.
 */
export default function AgencyLoading() {
  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 py-5 sm:px-6 sm:py-6 lg:px-10">
      <div className="flex items-center gap-3">
        <div className="h-9 w-9 animate-pulse rounded-lg bg-slate-100" />
        <div>
          <div className="h-5 w-56 animate-pulse rounded bg-slate-100" />
          <div className="mt-2 h-3 w-40 animate-pulse rounded bg-slate-100" />
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-3.5">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
          <div className="h-3.5 w-32 animate-pulse rounded bg-slate-100" />
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {SKELETON_CARDS.map((_, i) => (
              <div key={i} className="rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2">
                <div className="h-2.5 w-16 animate-pulse rounded bg-slate-200" />
                <div className="mt-2 h-5 w-12 animate-pulse rounded bg-slate-200" />
              </div>
            ))}
          </div>
        </div>
        <div className="h-40 animate-pulse rounded-xl border border-slate-200 bg-white shadow-sm" />
        <div className="h-20 animate-pulse rounded-xl border border-slate-200 bg-white shadow-sm" />
      </div>
    </div>
  );
}

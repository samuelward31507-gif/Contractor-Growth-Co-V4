const SKELETON_CARDS = Array.from({ length: 8 });

/**
 * Reserves the exact same vertical rhythm as the real page (title block,
 * then an 8-card grid) so nothing jumps when the real content swaps in.
 */
export default function AgencyLoading() {
  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <div>
        <div className="h-7 w-64 animate-pulse rounded bg-slate-100" />
        <div className="mt-2 h-4 w-48 animate-pulse rounded bg-slate-100" />
      </div>
      <div className="border-t border-slate-200 pt-8">
        <div className="h-3 w-32 animate-pulse rounded bg-slate-100" />
        <div className="mt-4 grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-4">
          {SKELETON_CARDS.map((_, i) => (
            <div key={i}>
              <div className="h-3 w-20 animate-pulse rounded bg-slate-100" />
              <div className="mt-2 h-7 w-16 animate-pulse rounded bg-slate-100" />
            </div>
          ))}
        </div>
      </div>
      <div className="border-t border-slate-200 pt-8">
        <div className="h-3 w-28 animate-pulse rounded bg-slate-100" />
        <div className="mt-4 h-40 animate-pulse rounded-lg bg-slate-100" />
      </div>
    </div>
  );
}

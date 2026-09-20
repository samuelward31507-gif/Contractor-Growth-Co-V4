/**
 * Reserves the same header + divider rhythm as the real page so nothing
 * jumps when the real content swaps in. The sidebar shell itself
 * (app/agency/layout.tsx) is not re-rendered during navigation, so this only
 * needs to skeleton the page content.
 */
export default function AgencyLoading() {
  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
      <div className="h-8 w-64 animate-pulse rounded bg-slate-100" />
      <div className="mt-2.5 h-4 w-48 animate-pulse rounded bg-slate-100" />

      <div className="mt-6 flex flex-wrap gap-x-8 gap-y-3 border-y border-slate-200 py-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="space-y-1.5">
            <div className="h-3 w-16 animate-pulse rounded bg-slate-100" />
            <div className="h-4 w-10 animate-pulse rounded bg-slate-100" />
          </div>
        ))}
      </div>

      <div className="mt-8 space-y-2">
        <div className="h-4 w-40 animate-pulse rounded bg-slate-100" />
        <div className="h-24 animate-pulse rounded-lg bg-slate-50" />
      </div>

      <div className="mt-8 border-t border-slate-200 pt-8 space-y-2">
        <div className="h-4 w-24 animate-pulse rounded bg-slate-100" />
        <div className="h-40 animate-pulse rounded-lg bg-slate-50" />
      </div>
    </div>
  );
}

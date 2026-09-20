/**
 * Reserves the same header + divider rhythm as the real client detail page
 * so nothing jumps when the real content swaps in - this page runs several
 * parallel queries per client, so without a skeleton a slow one would leave
 * a blank white page rather than a preserved layout.
 */
export default function AgencyOrganizationLoading() {
  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
      <div className="h-4 w-40 animate-pulse rounded bg-slate-100" />

      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="h-8 w-72 animate-pulse rounded bg-slate-100" />
        <div className="h-6 w-32 animate-pulse rounded-full bg-slate-100" />
      </div>

      <div className="mt-8 grid grid-cols-1 gap-8 border-t border-slate-200 pt-8 sm:grid-cols-[auto_1fr]">
        <div className="flex gap-8">
          <div className="space-y-1.5">
            <div className="h-3 w-20 animate-pulse rounded bg-slate-100" />
            <div className="h-8 w-12 animate-pulse rounded bg-slate-100" />
          </div>
          <div className="space-y-1.5">
            <div className="h-3 w-28 animate-pulse rounded bg-slate-100" />
            <div className="h-8 w-12 animate-pulse rounded bg-slate-100" />
          </div>
        </div>
        <div className="space-y-2 sm:border-l sm:border-slate-200 sm:pl-8">
          <div className="h-3 w-24 animate-pulse rounded bg-slate-100" />
          <div className="h-20 animate-pulse rounded-lg bg-slate-50" />
        </div>
      </div>

      <div className="mt-8 grid grid-cols-1 gap-8 border-t border-slate-200 pt-8 sm:grid-cols-2">
        <div className="space-y-2">
          <div className="h-3 w-24 animate-pulse rounded bg-slate-100" />
          <div className="h-32 animate-pulse rounded-lg bg-slate-50" />
        </div>
        <div className="space-y-2">
          <div className="h-3 w-32 animate-pulse rounded bg-slate-100" />
          <div className="h-32 animate-pulse rounded-lg bg-slate-50" />
        </div>
      </div>

      <div className="mt-8 border-t border-slate-200 pt-8 space-y-2">
        <div className="h-3 w-24 animate-pulse rounded bg-slate-100" />
        <div className="h-40 animate-pulse rounded-lg bg-slate-50" />
      </div>
    </div>
  );
}

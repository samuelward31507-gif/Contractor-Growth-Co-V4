/**
 * Reserves the same header + trigger/how-it-works + recent-executions
 * rhythm as the real detail page so nothing jumps when the real content
 * swaps in.
 */
export default function AutomationDetailLoading() {
  return (
    <div className="flex flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <div>
        <div className="h-3 w-24 animate-pulse rounded bg-slate-100" />
        <div className="mt-2 flex items-center gap-3">
          <div className="h-9 w-9 animate-pulse rounded-lg bg-slate-100" />
          <div className="h-6 w-56 animate-pulse rounded bg-slate-100" />
        </div>
        <div className="mt-2 h-4 w-96 max-w-full animate-pulse rounded bg-slate-100" />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 lg:col-span-1">
          <div className="h-3 w-16 animate-pulse rounded bg-slate-100" />
          <div className="mt-3 h-4 w-full animate-pulse rounded bg-slate-100" />
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 lg:col-span-2">
          <div className="h-3 w-24 animate-pulse rounded bg-slate-100" />
          <div className="mt-3 h-32 animate-pulse rounded bg-slate-100" />
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="h-3 w-32 animate-pulse rounded bg-slate-100" />
        <div className="mt-3 h-40 animate-pulse rounded-lg bg-slate-100" />
      </div>
    </div>
  );
}

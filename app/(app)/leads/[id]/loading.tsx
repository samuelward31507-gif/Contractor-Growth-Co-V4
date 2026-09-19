/** Mirrors the real detail page's identity + two-column rhythm so nothing jumps when it loads. */
export default function LeadDetailLoading() {
  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <div className="h-4 w-28 animate-pulse rounded bg-slate-100" />

      <div className="flex items-center gap-4">
        <div className="h-12 w-12 shrink-0 animate-pulse rounded-full bg-slate-100" />
        <div>
          <div className="h-5 w-40 animate-pulse rounded bg-slate-100" />
          <div className="mt-2 h-3.5 w-28 animate-pulse rounded bg-slate-100" />
        </div>
      </div>

      <div className="border-t border-slate-200 pt-8">
        <div className="h-3 w-24 animate-pulse rounded bg-slate-100" />
        <div className="mt-2 h-8 w-32 animate-pulse rounded bg-slate-100" />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:gap-8">
        <div className="flex flex-col gap-6 lg:col-span-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-32 animate-pulse rounded-xl bg-slate-100" />
          ))}
        </div>
        <div className="flex flex-col gap-6">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="h-32 animate-pulse rounded-xl bg-slate-100" />
          ))}
        </div>
      </div>
    </div>
  );
}

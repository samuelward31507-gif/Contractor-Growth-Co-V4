const ROWS = Array.from({ length: 6 });

/** Same skeleton convention as app/(app)/leads/loading.tsx. */
export default function ContactsLoading() {
  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="h-7 w-32 animate-pulse rounded bg-slate-100" />
          <div className="mt-2 h-4 w-72 max-w-full animate-pulse rounded bg-slate-100" />
        </div>
        <div className="h-10 w-36 animate-pulse rounded-lg bg-slate-100" />
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="h-10 w-full max-w-sm animate-pulse rounded-lg bg-slate-100" />
        <div className="mt-5 divide-y divide-slate-100">
          {ROWS.map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-2 py-3.5">
              <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-slate-100" />
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

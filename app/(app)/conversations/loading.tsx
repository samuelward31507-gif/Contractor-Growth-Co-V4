const ROWS = Array.from({ length: 8 });

/**
 * Mirrors the layout's real header + overview-stats + list rhythm (see
 * conversations/layout.tsx) so nothing jumps when the real content swaps
 * in - same convention as app/(app)/jobs/loading.tsx. The list-only skeleton
 * also matches what a first paint would actually show on mobile, where the
 * workspace collapses to list-only until a conversation is selected.
 */
export default function ConversationsLoading() {
  return (
    <div className="flex flex-1 flex-col overflow-hidden px-4 pt-6 sm:px-6 sm:pt-8 lg:px-10 lg:pt-10">
      <div>
        <div className="h-7 w-40 animate-pulse rounded bg-slate-100" />
        <div className="mt-2 h-4 w-80 max-w-full animate-pulse rounded bg-slate-100" />
      </div>

      <div className="mt-6 flex flex-wrap gap-x-10 gap-y-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i}>
            <div className="h-2.5 w-24 animate-pulse rounded bg-slate-100" />
            <div className="mt-2 h-6 w-10 animate-pulse rounded bg-slate-100" />
          </div>
        ))}
      </div>

      <div className="mt-6 flex min-h-0 flex-1 border-t border-slate-200">
        <div className="flex min-h-0 w-full flex-col lg:w-[340px] lg:shrink-0 lg:border-r lg:border-slate-200">
          <div className="shrink-0 space-y-2 px-3 py-4">
            <div className="h-10 w-full animate-pulse rounded-lg bg-slate-100" />
            <div className="h-10 w-full animate-pulse rounded-lg bg-slate-100" />
          </div>
          <div className="min-h-0 flex-1 divide-y divide-slate-100 overflow-hidden">
            {ROWS.map((_, i) => (
              <div key={i} className="flex items-start gap-3 px-4 py-3">
                <div className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-slate-100" />
                <div className="min-w-0 flex-1">
                  <div className="h-3.5 w-32 animate-pulse rounded bg-slate-100" />
                  <div className="mt-2 h-3 w-48 max-w-full animate-pulse rounded bg-slate-100" />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="hidden flex-1 lg:block" />
      </div>
    </div>
  );
}

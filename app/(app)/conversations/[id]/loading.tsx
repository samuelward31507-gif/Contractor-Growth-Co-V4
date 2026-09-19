/**
 * Fills just the thread pane while a specific conversation's messages,
 * appointments, and opt-out state load - the list pane (owned by the parent
 * layout) stays mounted and interactive the whole time, matching a real
 * inbox where switching threads never blanks the list.
 */
export default function ConversationLoading() {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-slate-200 px-4 py-3 sm:px-6">
        <div className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-slate-100" />
        <div className="min-w-0 flex-1">
          <div className="h-3.5 w-36 animate-pulse rounded bg-slate-100" />
          <div className="mt-2 h-3 w-24 animate-pulse rounded bg-slate-100" />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-4 py-5 sm:px-6">
        <div className="h-14 w-2/3 animate-pulse rounded-2xl bg-slate-100" />
        <div className="ml-auto h-10 w-1/2 animate-pulse rounded-2xl bg-slate-100" />
        <div className="h-16 w-3/4 animate-pulse rounded-2xl bg-slate-100" />
        <div className="ml-auto h-10 w-2/5 animate-pulse rounded-2xl bg-slate-100" />
      </div>

      <div className="shrink-0 border-t border-slate-200 bg-slate-50 px-4 py-4 sm:px-6">
        <div className="h-16 w-full animate-pulse rounded-lg bg-slate-100" />
      </div>
    </div>
  );
}

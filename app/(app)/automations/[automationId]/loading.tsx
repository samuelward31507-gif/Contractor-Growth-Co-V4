import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";

/**
 * Reserves the same header + trigger/how-it-works + recent-executions
 * rhythm as the real detail page so nothing jumps when the real content
 * swaps in.
 */
export default function AutomationDetailLoading() {
  return (
    <div className={`${PAGE_CONTAINER_CLASS} gap-6 ${PAGE_MAX_WIDTH_CLASS}`}>
      <div>
        <div className="h-3 w-24 animate-pulse rounded bg-inset" />
        <div className="mt-2 flex items-center gap-3">
          <div className="h-9 w-9 animate-pulse rounded-lg bg-inset" />
          <div className="h-6 w-56 animate-pulse rounded bg-inset" />
        </div>
        <div className="mt-2 h-4 w-96 max-w-full animate-pulse rounded bg-inset" />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="rounded-lg border border-line bg-surface p-4 sm:p-5 lg:col-span-1">
          <div className="h-3 w-16 animate-pulse rounded bg-inset" />
          <div className="mt-3 h-4 w-full animate-pulse rounded bg-inset" />
        </div>
        <div className="rounded-lg border border-line bg-surface p-4 sm:p-5 lg:col-span-2">
          <div className="h-3 w-24 animate-pulse rounded bg-inset" />
          <div className="mt-3 h-32 animate-pulse rounded bg-inset" />
        </div>
      </div>

      <div className="rounded-lg border border-line bg-surface p-4 sm:p-5">
        <div className="h-3 w-32 animate-pulse rounded bg-inset" />
        <div className="mt-3 h-40 animate-pulse rounded-lg bg-inset" />
      </div>
    </div>
  );
}

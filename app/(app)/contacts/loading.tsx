import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";

const ROWS = Array.from({ length: 6 });

/** Same skeleton convention as app/(app)/leads/loading.tsx. */
export default function ContactsLoading() {
  return (
    <div className={`${PAGE_CONTAINER_CLASS} gap-8 ${PAGE_MAX_WIDTH_CLASS}`}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="h-7 w-32 animate-pulse rounded bg-inset" />
          <div className="mt-2 h-4 w-72 max-w-full animate-pulse rounded bg-inset" />
        </div>
        <div className="h-10 w-36 animate-pulse rounded-lg bg-inset" />
      </div>

      <div className="rounded-lg border border-line bg-surface p-4 sm:p-5">
        <div className="h-10 w-full max-w-sm animate-pulse rounded-lg bg-inset" />
        <div className="mt-5 divide-y divide-line">
          {ROWS.map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-2 py-3.5">
              <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-inset" />
              <div className="min-w-0 flex-1">
                <div className="h-3.5 w-48 animate-pulse rounded bg-inset" />
                <div className="mt-2 h-3 w-32 animate-pulse rounded bg-inset" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

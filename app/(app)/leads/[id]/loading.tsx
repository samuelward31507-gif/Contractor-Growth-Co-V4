import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";

/** Mirrors the real detail page's identity + two-column rhythm so nothing jumps when it loads. */
export default function LeadDetailLoading() {
  return (
    <div className={`${PAGE_CONTAINER_CLASS} gap-8 ${PAGE_MAX_WIDTH_CLASS}`}>
      <div className="h-4 w-28 animate-pulse rounded bg-inset" />

      <div className="flex items-center gap-4">
        <div className="h-12 w-12 shrink-0 animate-pulse rounded-full bg-inset" />
        <div>
          <div className="h-5 w-40 animate-pulse rounded bg-inset" />
          <div className="mt-2 h-3.5 w-28 animate-pulse rounded bg-inset" />
        </div>
      </div>

      <div className="border-t border-line pt-8">
        <div className="h-3 w-24 animate-pulse rounded bg-inset" />
        <div className="mt-2 h-8 w-32 animate-pulse rounded bg-inset" />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:gap-8">
        <div className="flex flex-col gap-6 lg:col-span-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-32 animate-pulse rounded-lg bg-inset" />
          ))}
        </div>
        <div className="flex flex-col gap-6">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="h-32 animate-pulse rounded-lg bg-inset" />
          ))}
        </div>
      </div>
    </div>
  );
}

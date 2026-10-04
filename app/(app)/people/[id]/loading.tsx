import { Bone, SkeletonRows } from "@/lib/ui/skeleton";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";
import { cardClass } from "@/lib/ui/surface";

/**
 * Performance Pass A: a person's loading state. Without it, opening a
 * person would fall back to app/(app)/people/loading.tsx (the list
 * skeleton), which is the wrong shape. Mirrors lib/ui/detail-header.tsx
 * (back link, avatar + eyebrow/title, the four-figure meta row) and the
 * page's two-thirds / one-third body. No data, no text.
 */
export default function PersonLoading() {
  return (
    <div className="flex flex-1 flex-col" role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <div className="border-b border-line bg-surface px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
        <Bone className="h-4 w-24" />
        <div className="mt-4 flex items-start gap-4">
          <Bone className="h-12 w-12 shrink-0 rounded-full" />
          <div className="min-w-0">
            <Bone className="h-3 w-16" />
            <Bone className="mt-2 h-7 w-48 max-w-full" />
            <Bone className="mt-2.5 h-4 w-36" />
          </div>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i}>
              <Bone className="h-3 w-20" />
              <Bone className="mt-2 h-6 w-24" />
            </div>
          ))}
        </div>
      </div>
      <div className={`${PAGE_CONTAINER_CLASS} gap-6 ${PAGE_MAX_WIDTH_CLASS}`}>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:gap-8">
          <div className="flex flex-col gap-6 lg:col-span-2">
            <SkeletonRows count={3} />
            <SkeletonRows count={4} />
          </div>
          <div className="flex flex-col gap-6">
            <div className={`${cardClass} p-5`}>
              <Bone className="h-4 w-24" />
              <div className="mt-4 space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Bone key={i} className="h-3.5 w-full" />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

import { Bone, SkeletonPage } from "@/lib/ui/skeleton";
import { cardClass } from "@/lib/ui/surface";

/**
 * Performance Pass A: the Dashboard's loading state, shown the instant a
 * navigation to /today starts. Trackpr 2.0 (step 2E): mirrors Dashboard
 * 2.0 at the same content width - greeting, the attention list, then the
 * revenue panel beside the briefing, then the two lower rows. No data, no
 * text.
 */
export default function TodayLoading() {
  return (
    <SkeletonPage width="content">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <Bone className="h-6 w-48 max-w-full" />
          <Bone className="mt-2.5 h-4 w-64 max-w-full" />
        </div>
        <Bone className="h-9 w-28 rounded-md" />
      </div>

      <div>
        <div className="mb-3 flex items-center justify-between">
          <Bone className="h-4 w-40" />
          <Bone className="h-7 w-36 rounded-md" />
        </div>
        <div className={`divide-y divide-line overflow-hidden ${cardClass}`}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-6 px-5 py-4">
              <div className="min-w-0 flex-1">
                <Bone className="h-3.5 w-44 max-w-full" />
                <Bone className="mt-2 h-3 w-28" />
                <Bone className="mt-2 h-3 w-72 max-w-full" />
              </div>
              <Bone className="hidden h-8 w-24 rounded-md sm:block" />
            </div>
          ))}
        </div>
      </div>

      <div>
        <Bone className="mb-3 h-4 w-16" />
        <div className={`overflow-hidden ${cardClass}`}>
          <div className="grid grid-cols-1 gap-px bg-line sm:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="bg-surface px-5 py-4">
                <Bone className="h-3 w-20" />
                <Bone className="mt-2 h-6 w-12" />
                <Bone className="mt-2 h-3 w-24" />
              </div>
            ))}
          </div>
          <div className="border-t border-line px-5 py-3">
            <Bone className="h-3.5 w-64 max-w-full" />
          </div>
        </div>
      </div>

      <div>
        <Bone className="mb-3 h-4 w-36" />
        <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-surface px-4 py-3.5">
              <Bone className="h-3 w-16" />
              <Bone className="mt-2 h-5 w-20" />
              <Bone className="mt-2 h-3 w-14" />
            </div>
          ))}
        </div>
      </div>
    </SkeletonPage>
  );
}

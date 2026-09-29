import { Bone, SkeletonPage, SkeletonRows, SkeletonStatCard } from "@/lib/ui/skeleton";

/**
 * Performance Pass A: Dashboard's loading state - shown the instant a
 * navigation to /today starts, while the (slow, BI-heavy) server render is
 * still running. Mirrors the real page: the header with the pipeline value
 * on the right, the "Money at a glance" grid (two rows of four stat cards),
 * the priority-queue tabs and the queue itself. No data, no text.
 */
export default function DashboardLoading() {
  return (
    <SkeletonPage>
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <Bone className="mb-2.5 h-3 w-20" />
          <Bone className="h-7 w-56 max-w-full" />
          <Bone className="mt-2.5 h-4 w-72 max-w-full" />
        </div>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <div className="flex flex-col sm:items-end">
            <Bone className="h-3 w-24" />
            <Bone className="mt-2 h-9 w-28" />
            <Bone className="mt-2 h-3.5 w-32" />
          </div>
          <Bone className="h-9 w-28 rounded-lg" />
        </div>
      </div>

      <div className="border-t border-slate-200 pt-8">
        <Bone className="h-3.5 w-28" />
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonStatCard key={i} />
          ))}
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonStatCard key={i} />
          ))}
        </div>
        <div className="mt-8 flex gap-2">
          <Bone className="h-8 w-28 rounded-lg" />
          <Bone className="h-8 w-20 rounded-lg" />
        </div>
        <div className="mt-5">
          <SkeletonRows count={4} leading={false} />
        </div>
      </div>
    </SkeletonPage>
  );
}

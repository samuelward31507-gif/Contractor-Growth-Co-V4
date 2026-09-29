import { Bone, SkeletonPage, SkeletonPageHeader, SkeletonStatCard } from "@/lib/ui/skeleton";

/**
 * Performance Pass A: Insights' loading state - shown the instant a
 * navigation to /insights starts, while the business-metrics snapshot is
 * still being computed on the server. Mirrors the real page: the header,
 * the range row (label + range tabs), then the first metric section (label,
 * description, a grid of stat cards) and the chart below it. No data, no
 * text.
 */
export default function InsightsLoading() {
  return (
    <SkeletonPage width="content">
      <SkeletonPageHeader />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Bone className="h-3.5 w-44" />
        <div className="flex flex-wrap gap-1.5">
          {Array.from({ length: 6 }).map((_, i) => (
            <Bone key={i} className="h-7 w-20 rounded-full" />
          ))}
        </div>
      </div>
      <div>
        <Bone className="h-4 w-40" />
        <Bone className="mt-2 h-3 w-96 max-w-full" />
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonStatCard key={i} />
          ))}
        </div>
      </div>
      <div className="rounded-lg border border-line bg-surface p-5">
        <Bone className="h-3.5 w-32" />
        <Bone className="mt-4 h-48 w-full rounded-lg" />
      </div>
    </SkeletonPage>
  );
}

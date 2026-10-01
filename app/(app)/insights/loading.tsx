import { Bone, SkeletonPage, SkeletonPageHeader } from "@/lib/ui/skeleton";

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
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <SkeletonPageHeader />
        <div className="flex gap-1.5 overflow-hidden">
          {Array.from({ length: 6 }).map((_, i) => (
            <Bone key={i} className="h-8 w-20 shrink-0 rounded-md" />
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-6">
        {Array.from({ length: 3 }).map((_, panel) => (
          <div key={panel} className="overflow-hidden rounded-lg border border-line bg-surface">
            <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
              <Bone className="h-4 w-36" />
              <Bone className="h-3 w-20" />
            </div>
            <div className="grid grid-cols-2 gap-px bg-line md:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="bg-surface px-5 py-4">
                  <Bone className="h-3 w-20" />
                  <Bone className="mt-2 h-7 w-24" />
                  <Bone className="mt-2 h-3 w-28 max-w-full" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </SkeletonPage>
  );
}

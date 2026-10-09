import { Bone, SkeletonPage, SkeletonPageHeader, SkeletonRows, SkeletonStatCard } from "@/lib/ui/skeleton";

/**
 * Agency redesign: Costs' loading state - shown the instant a navigation to
 * /agency/costs starts, while the AI and SMS cost reads run on the server.
 * Mirrors the real page: header with the period chips, the five headline
 * cards, then the AI and SMS per-client tables. No data, no text.
 */
export default function AgencyCostsLoading() {
  return (
    <SkeletonPage width="content">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <SkeletonPageHeader />
        <div className="flex gap-1.5 overflow-hidden">
          {Array.from({ length: 4 }).map((_, i) => (
            <Bone key={i} className="h-8 w-20 shrink-0 rounded-full" />
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-5 [&>*:last-child:nth-child(odd)]:col-span-2 lg:[&>*:last-child:nth-child(odd)]:col-span-1">
        {Array.from({ length: 5 }).map((_, i) => (
          <SkeletonStatCard key={i} />
        ))}
      </div>
      <div className="flex flex-col gap-6">
        <SkeletonRows count={4} leading={false} />
        <SkeletonRows count={4} leading={false} />
      </div>
    </SkeletonPage>
  );
}

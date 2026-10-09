import { Bone, SkeletonPage, SkeletonPageHeader, SkeletonRows, SkeletonStatCard } from "@/lib/ui/skeleton";

/**
 * Agency redesign: Revenue's loading state - shown the instant a navigation
 * to /agency/revenue starts, while the Stripe revenue read runs on the
 * server. Mirrors the real page: header with the period chips, the four
 * headline cards, then the client and event lists. No data, no text.
 */
export default function AgencyRevenueLoading() {
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
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonStatCard key={i} />
        ))}
      </div>
      <div className="flex flex-col gap-6">
        <SkeletonRows count={3} leading={false} />
        <SkeletonRows count={5} leading={false} />
      </div>
    </SkeletonPage>
  );
}

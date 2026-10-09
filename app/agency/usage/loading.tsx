import { SkeletonPage, SkeletonPageHeader, SkeletonRows, SkeletonStatCard } from "@/lib/ui/skeleton";

/**
 * Agency redesign: Usage's loading state, on the shared skeleton primitives
 * (lib/ui/skeleton.tsx) inside the same page container the real page uses,
 * so nothing shifts when content swaps in. Mirrors the real page: header,
 * the five headline cards, the client activity list and cost readiness.
 * No data, no text.
 */
export default function AgencyUsageLoading() {
  return (
    <SkeletonPage width="content">
      <SkeletonPageHeader />
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-5 [&>*:last-child:nth-child(odd)]:col-span-2 lg:[&>*:last-child:nth-child(odd)]:col-span-1">
        {Array.from({ length: 5 }).map((_, i) => (
          <SkeletonStatCard key={i} />
        ))}
      </div>
      <div className="flex flex-col gap-6">
        <SkeletonRows count={5} leading={false} />
        <SkeletonRows count={3} leading={false} />
      </div>
    </SkeletonPage>
  );
}

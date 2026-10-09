import { SkeletonPage, SkeletonPageHeader, SkeletonRows, SkeletonStatCard } from "@/lib/ui/skeleton";

/** Client delivery's loading state: header, the five stage counts, then the lists. No data, no text. */
export default function AgencyDeliveryLoading() {
  return (
    <SkeletonPage width="content" gap="gap-6">
      <SkeletonPageHeader />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <SkeletonStatCard key={i} />
        ))}
      </div>
      <SkeletonRows count={4} leading={false} />
      <SkeletonRows count={5} leading={false} />
    </SkeletonPage>
  );
}

import { Bone, SkeletonPage, SkeletonPageHeader, SkeletonStatCard } from "@/lib/ui/skeleton";

/**
 * Trackpr 2.0 (step 2C): Money is a navigation destination again (Work
 * group), and every nav destination answers a click with its own loading
 * state before the server render finishes. Mirrors the real page: header,
 * the browse tabs, and the four-card overview grid.
 */
export default function MoneyLoading() {
  return (
    <SkeletonPage width="content">
      <SkeletonPageHeader />
      <Bone className="h-9 w-72 max-w-full rounded-md" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonStatCard key={i} />
        ))}
      </div>
    </SkeletonPage>
  );
}

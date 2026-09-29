import { Bone, SkeletonPage, SkeletonPageHeader, SkeletonRows } from "@/lib/ui/skeleton";

/**
 * Performance Pass A: Reviews & Referrals' loading state - shown the
 * instant a navigation to /growth starts. Mirrors the real page: the header,
 * then the Reviews and Referrals sections, each a label over a card. No
 * data, no text.
 */
export default function GrowthLoading() {
  return (
    <SkeletonPage>
      <SkeletonPageHeader />
      {[0, 1].map((section) => (
        <div key={section}>
          <Bone className="h-3.5 w-20" />
          <div className="mt-3">
            <SkeletonRows count={3} />
          </div>
        </div>
      ))}
    </SkeletonPage>
  );
}

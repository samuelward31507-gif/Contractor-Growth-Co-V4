import { Bone, SkeletonPage, SkeletonPageHeader } from "@/lib/ui/skeleton";
import { cardClass } from "@/lib/ui/surface";

/** Batch 2: Trackpr's loading state - the header, the status panel and the "what Trackpr handles" grid. No data, no text. */
export default function TrackprLoading() {
  return (
    <SkeletonPage width="content">
      <SkeletonPageHeader />
      <div className={`px-5 py-5 ${cardClass}`}>
        <Bone className="h-4 w-48" />
        <Bone className="mt-2 h-3 w-72 max-w-full" />
      </div>
      <div className={`grid gap-px overflow-hidden bg-line sm:grid-cols-2 lg:grid-cols-3 ${cardClass}`}>
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="bg-surface px-5 py-4">
            <Bone className="h-3 w-40 max-w-full" />
          </div>
        ))}
      </div>
    </SkeletonPage>
  );
}

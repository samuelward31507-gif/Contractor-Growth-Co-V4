import { Bone, SkeletonPage, SkeletonPageHeader, SkeletonRows } from "@/lib/ui/skeleton";

/** Mirrors the founder home: header, quick actions, the one-line summary, then priorities/today beside attention/coming up. */
export default function FounderLoading() {
  return (
    <SkeletonPage width="content" gap="gap-6">
      <SkeletonPageHeader />
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 5 }, (_, i) => (
          <Bone key={i} className="h-9 w-24 rounded-lg" />
        ))}
      </div>
      <Bone className="h-10 w-full" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-6">
          <SkeletonRows count={3} />
          <SkeletonRows count={4} />
        </div>
        <div className="flex flex-col gap-6">
          <SkeletonRows count={3} />
          <SkeletonRows count={3} />
        </div>
      </div>
    </SkeletonPage>
  );
}

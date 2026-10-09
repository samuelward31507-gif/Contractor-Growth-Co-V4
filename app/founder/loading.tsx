import { Bone, SkeletonPage, SkeletonPageHeader, SkeletonRows, SkeletonStatCard } from "@/lib/ui/skeleton";

export default function FounderLoading() {
  return (
    <SkeletonPage width="content">
      <SkeletonPageHeader action />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SkeletonStatCard />
        <SkeletonStatCard />
        <SkeletonStatCard />
        <SkeletonStatCard />
      </div>
      <Bone className="h-5 w-40" />
      <SkeletonRows count={5} />
    </SkeletonPage>
  );
}

import { SkeletonPage, SkeletonPageHeader, SkeletonRows } from "@/lib/ui/skeleton";

/** One delivery client's loading state: header, then the two columns. No data, no text (not even the client's name). */
export default function AgencyDeliveryClientLoading() {
  return (
    <SkeletonPage width="content" gap="gap-6">
      <SkeletonPageHeader />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:gap-8">
        <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
          <SkeletonRows count={2} leading={false} />
          <SkeletonRows count={8} leading={false} />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <SkeletonRows count={4} leading={false} />
          <SkeletonRows count={3} leading={false} />
        </div>
      </div>
    </SkeletonPage>
  );
}

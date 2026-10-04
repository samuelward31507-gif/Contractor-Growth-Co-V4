import { Bone, SkeletonPage, SkeletonPageHeader, SkeletonRows } from "@/lib/ui/skeleton";
import { cardClass } from "@/lib/ui/surface";

/**
 * Performance Pass A: People's loading state - shown the instant a
 * navigation to /people starts. Mirrors the real page: the header with its
 * actions, then one panel holding the search/sort row, the column headings
 * and the people rows. No data, no text.
 */
export default function PeopleLoading() {
  return (
    <SkeletonPage width="content">
      <SkeletonPageHeader action />
      <div className={`${cardClass} p-4 sm:p-5`}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Bone className="h-9 w-full rounded-lg sm:max-w-sm" />
          <Bone className="h-9 w-full rounded-lg sm:w-40" />
        </div>
        <div className="mt-5 hidden gap-6 px-2 sm:flex">
          {["w-16", "w-14", "w-10", "w-12", "w-10", "w-16"].map((width, i) => (
            <Bone key={i} className={`h-2.5 ${width}`} />
          ))}
        </div>
        <div className="mt-3">
          <SkeletonRows count={7} />
        </div>
      </div>
    </SkeletonPage>
  );
}

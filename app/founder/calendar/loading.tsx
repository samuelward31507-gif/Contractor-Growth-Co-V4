import { Bone, SkeletonPage, SkeletonPageHeader } from "@/lib/ui/skeleton";

/** Mirrors the calendar: header, navigation row, a month grid and the unscheduled panel. */
export default function FounderCalendarLoading() {
  return (
    <SkeletonPage width="content" gap="gap-6">
      <SkeletonPageHeader action />
      <div className="flex items-center justify-between gap-3">
        <Bone className="h-9 w-56" />
        <Bone className="hidden h-9 w-40 sm:block" />
      </div>
      <div className="flex flex-col gap-6 lg:flex-row">
        <div className="grid flex-1 grid-cols-7 gap-px overflow-hidden rounded-xl border border-line">
          {Array.from({ length: 35 }, (_, i) => (
            <Bone key={i} className="h-16 rounded-none sm:h-28" />
          ))}
        </div>
        <Bone className="h-40 w-full rounded-xl lg:w-72" />
      </div>
    </SkeletonPage>
  );
}

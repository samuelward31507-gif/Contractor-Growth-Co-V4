import { Bone, SkeletonPage, SkeletonPageHeader } from "@/lib/ui/skeleton";

/**
 * Performance Pass A: Schedule's loading state - shown the instant a
 * navigation to /schedule starts. /schedule renders either the calendar
 * (default) or the appointment list (?view=list), and a loading.tsx can't
 * see the query string, so this mirrors the shape both share: the header,
 * the date/view controls row, and one large bordered panel. No data, no
 * text.
 */
export default function ScheduleLoading() {
  return (
    <SkeletonPage gap="gap-6">
      <SkeletonPageHeader />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Bone className="h-8 w-16 rounded-lg" />
          <Bone className="h-6 w-40" />
          <Bone className="h-8 w-16 rounded-lg" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Bone className="h-9 w-56 rounded-lg" />
          <Bone className="h-9 w-28 rounded-lg" />
          <Bone className="h-9 w-36 rounded-lg" />
        </div>
      </div>
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="grid grid-cols-7 gap-px border-b border-slate-100 px-4 py-3">
          {Array.from({ length: 7 }).map((_, i) => (
            <Bone key={i} className="mx-auto h-3 w-12" />
          ))}
        </div>
        <div className="divide-y divide-slate-100">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex h-16 items-start gap-4 px-4 py-2">
              <Bone className="h-2.5 w-10" />
            </div>
          ))}
        </div>
      </div>
    </SkeletonPage>
  );
}

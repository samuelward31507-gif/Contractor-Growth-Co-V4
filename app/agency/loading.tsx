import { Bone, SkeletonPage, SkeletonPageHeader, SkeletonRows, SkeletonStatCard } from "@/lib/ui/skeleton";
import { cardClass } from "@/lib/ui/surface";

/** A card section's header (title + one line), the shape of app/agency/_components/section.tsx's AgencySection. */
function SkeletonSectionHeader() {
  return (
    <div className="px-4 pb-3 pt-4 sm:px-5 sm:pt-5">
      <Bone className="h-4 w-40" />
      <Bone className="mt-2 h-3 w-64 max-w-full" />
    </div>
  );
}

function SkeletonListCard({ rows }: { rows: number }) {
  return (
    <div className={`overflow-hidden ${cardClass}`}>
      <SkeletonSectionHeader />
      <div className="divide-y divide-line border-t border-line">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center justify-between gap-4 px-4 py-3 sm:px-5">
            <Bone className="h-3.5 w-56 max-w-full" />
            <Bone className="h-3 w-12 shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The Agency overview's loading state, shown the instant a navigation to
 * /agency starts (the agency shell stays put). Mirrors the real page inside
 * the same container and width - header, the five-card StatGrid, Needs your
 * attention, the Clients card with its toolbar, Deeper intelligence, the
 * onboarding / system health pair, then recent activity - so nothing jumps
 * when content swaps in. No data and no text, per lib/ui/skeleton.tsx.
 */
export default function AgencyLoading() {
  return (
    <SkeletonPage width="content">
      <SkeletonPageHeader />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-5 [&>*:last-child:nth-child(odd)]:col-span-2 lg:[&>*:last-child:nth-child(odd)]:col-span-1">
        {Array.from({ length: 5 }).map((_, i) => (
          <SkeletonStatCard key={i} />
        ))}
      </div>

      <SkeletonListCard rows={3} />

      <div className={`overflow-hidden ${cardClass}`}>
        <SkeletonSectionHeader />
        <div className="flex flex-col gap-3 px-4 pb-4 sm:flex-row sm:px-5">
          <Bone className="h-9 w-full rounded-lg sm:max-w-sm" />
          <Bone className="h-9 w-full rounded-lg sm:w-44" />
        </div>
        <div className="border-t border-line [&>div]:rounded-none [&>div]:border-0 [&>div]:shadow-none">
          <SkeletonRows count={5} leading={false} />
        </div>
      </div>

      <SkeletonListCard rows={4} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
        <SkeletonListCard rows={3} />
        <SkeletonListCard rows={4} />
      </div>

      <SkeletonListCard rows={5} />
    </SkeletonPage>
  );
}

import { Bone, SkeletonStatCard } from "@/lib/ui/skeleton";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";
import { StatGrid } from "@/lib/ui/stat-card";
import { cardClass } from "@/lib/ui/surface";

/** A SectionCard-shaped placeholder: icon + title/description, then `rows` label/value lines. */
function SkeletonSectionCard({ rows }: { rows: number }) {
  return (
    <div className={`${cardClass} p-4 sm:p-5`}>
      <div className="flex items-center gap-2">
        <Bone className="h-6 w-6 shrink-0 rounded-md" />
        <div className="min-w-0">
          <Bone className="h-3.5 w-28" />
          <Bone className="mt-1.5 h-3 w-44 max-w-full" />
        </div>
      </div>
      <div className="mt-4 divide-y divide-line">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center justify-between gap-4 py-2.5">
            <Bone className="h-3.5 w-28" />
            <Bone className="h-3.5 w-12" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The client detail page's loading state. Mirrors the real layout - the
 * DetailHeader band (back link, eyebrow, title, two badges, the pause
 * control on the right), the four-card StatGrid, and the two-thirds /
 * one-third SectionCard columns - inside the same page container, so
 * nothing shifts when content swaps in. This page runs several parallel
 * agency reads, so without it a slow one would leave a blank page. Renders
 * no data and no text (not even the client's name).
 */
export default function AgencyOrganizationLoading() {
  return (
    <div className="flex flex-1 flex-col" role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading client…</span>

      <div className="border-b border-line bg-surface">
        <div className={`${PAGE_MAX_WIDTH_CLASS} px-4 py-6 sm:px-6 sm:py-8 lg:px-10`}>
          <Bone className="h-4 w-56 max-w-full" />
          <div className="mt-4 flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <Bone className="h-3 w-16" />
              <Bone className="mt-2 h-8 w-64 max-w-full" />
              <div className="mt-3 flex gap-2">
                <Bone className="h-5 w-20 rounded-full" />
                <Bone className="h-5 w-24 rounded-full" />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Bone className="h-5 w-28 rounded-full" />
              <Bone className="h-8 w-20 rounded-lg" />
            </div>
          </div>
        </div>
      </div>

      <div className={`${PAGE_CONTAINER_CLASS} gap-6 ${PAGE_MAX_WIDTH_CLASS}`}>
        <StatGrid columns={4}>
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonStatCard key={i} />
          ))}
        </StatGrid>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:gap-8">
          <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
            <SkeletonSectionCard rows={5} />
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <SkeletonSectionCard rows={6} />
              <SkeletonSectionCard rows={7} />
            </div>
            <SkeletonSectionCard rows={4} />
          </div>
          <div className="flex min-w-0 flex-col gap-6">
            <SkeletonSectionCard rows={3} />
            <SkeletonSectionCard rows={8} />
            <SkeletonSectionCard rows={3} />
          </div>
        </div>
      </div>
    </div>
  );
}

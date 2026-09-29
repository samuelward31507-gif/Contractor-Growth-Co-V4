import { Bone, SkeletonPage, SkeletonPageHeader } from "@/lib/ui/skeleton";

/**
 * Performance Pass A: Settings' loading state - shown the instant a
 * navigation to /settings starts. Mirrors the real page: the header, the
 * same two-column grid (the section jump-nav on large screens, hidden on
 * mobile exactly like the real one) and the first form section's labelled
 * fields. No data, no text.
 */
export default function SettingsLoading() {
  return (
    <SkeletonPage>
      <SkeletonPageHeader />
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[180px_minmax(0,1fr)]">
        <div className="hidden lg:block">
          <Bone className="h-3 w-16" />
          <div className="mt-3 space-y-3 border-l border-slate-200 pl-3">
            {["w-36", "w-24", "w-32", "w-28", "w-10", "w-24"].map((width, i) => (
              <Bone key={i} className={`h-3.5 ${width}`} />
            ))}
          </div>
        </div>
        <div className="min-w-0">
          <Bone className="h-3 w-40" />
          <Bone className="mt-5 h-4 w-32" />
          <Bone className="mt-2 h-3 w-72 max-w-full" />
          <div className="mt-5 space-y-5">
            <div>
              <Bone className="h-3 w-28" />
              <Bone className="mt-2 h-10 w-full rounded-lg" />
            </div>
            {[0, 1].map((row) => (
              <div key={row} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {[0, 1].map((col) => (
                  <div key={col}>
                    <Bone className="h-3 w-28" />
                    <Bone className="mt-2 h-10 w-full rounded-lg" />
                  </div>
                ))}
              </div>
            ))}
            <div>
              <Bone className="h-3 w-20" />
              <Bone className="mt-2 h-10 w-full rounded-lg" />
            </div>
          </div>
        </div>
      </div>
    </SkeletonPage>
  );
}

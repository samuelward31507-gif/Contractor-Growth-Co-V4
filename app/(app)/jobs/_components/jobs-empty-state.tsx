import Link from "next/link";

// lib/ui/surface.ts's surfaceClass ("rounded-lg bg-slate-50") is a
// Trackpr 2.0 redesign file that's intentionally never committed this
// phase (see the 65 pre-existing dirty files) - inlined here instead of
// imported so this component doesn't depend on an untracked file.
const surfaceClass = "rounded-lg bg-slate-50";

/**
 * Unlike Leads/Estimates, there is no "Add Job" action here - jobs are only
 * ever created by accepting an estimate (lib/automation/jobs.ts's
 * emitJobCreatedFromEstimate, the sole job-creation path per explicit
 * decision). The empty state explains that workflow instead of offering a
 * button to a feature that doesn't exist.
 */
export function JobsEmptyState() {
  return (
    <div className={`${surfaceClass} flex flex-1 items-center justify-center px-6 py-20`}>
      <div className="max-w-sm text-center">
        <h2 className="text-base font-medium text-slate-900">No jobs yet.</h2>
        <p className="mt-1.5 text-sm text-slate-500">
          Jobs are created automatically when a customer accepts an estimate. Once that happens, it&apos;ll show up
          here ready to schedule.
        </p>
        <div className="mt-6 flex justify-center">
          <Link
            href="/estimates"
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-800"
          >
            Go to Estimates
          </Link>
        </div>
      </div>
    </div>
  );
}

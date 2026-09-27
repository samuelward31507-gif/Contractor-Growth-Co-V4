import Link from "next/link";
import { sectionLabelClass, metaClass, numericDisplayClass } from "@/lib/ui/typography";
import { PIPELINE_STAGES, type PipelineCounts } from "@/lib/dashboard/queries";

/**
 * Trackpr 2.0 full redesign: the pipeline used to render as a bordered,
 * horizontal "node rail" (icon circles connected by a line, requiring
 * horizontal scroll below ~560px). The approved concept replaced it with a
 * flush, divider-separated list - a colored dot instead of an icon chip, a
 * label, and a tabular-numeral count - matching the rest of the app's
 * "Level 1/2" containment (no card) and reading naturally at any width with
 * no horizontal scroll needed. A stage lights up only when it actually
 * holds at least one real lead right now; every count is read straight from
 * PipelineCounts (lib/dashboard/queries.ts), nothing here is estimated or
 * invented.
 */
export function PipelineRail({ pipeline, hasNeverHadLeads }: { pipeline: PipelineCounts; hasNeverHadLeads?: boolean }) {
  const total = PIPELINE_STAGES.reduce((sum, { stage }) => sum + pipeline[stage], 0);

  return (
    <div>
      <h2 className={sectionLabelClass}>Pipeline</h2>
      {total > 0 ? <p className={`mt-1 ${metaClass}`}>Current stage counts for the pipeline value shown above.</p> : null}
      {total === 0 ? (
        hasNeverHadLeads ? (
          <p className="mt-3 text-sm text-slate-500">
            Your system is ready.{" "}
            <Link href="/onboarding" className="font-medium text-slate-900 hover:underline">
              Send a test lead
            </Link>{" "}
            to see it in action.
          </p>
        ) : (
          <p className="mt-3 text-sm text-slate-500">Your pipeline will appear here once leads start coming in.</p>
        )
      ) : (
        <div className="mt-5 flex flex-col">
          {PIPELINE_STAGES.map(({ stage, label }, index) => {
            const count = pipeline[stage];
            const isPopulated = count > 0;
            return (
              <div
                key={stage}
                className={`flex items-center gap-3.5 py-2.5 border-t border-slate-200 ${index === PIPELINE_STAGES.length - 1 ? "border-b" : ""}`}
              >
                <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${isPopulated ? "bg-accent" : "bg-slate-200"}`} aria-hidden />
                <span className={`flex-1 text-sm ${isPopulated ? "font-medium text-slate-900" : "text-slate-500"}`}>{label}</span>
                <span className={`text-[15px] font-semibold ${numericDisplayClass} ${isPopulated ? "text-slate-900" : "text-slate-300"}`}>{count}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

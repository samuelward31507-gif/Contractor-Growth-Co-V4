import { sectionLabelClass } from "@/lib/ui/typography";
import { PIPELINE_STAGES, type PipelineCounts } from "@/lib/dashboard/queries";

/**
 * A stage-by-stage list with a proportional bar per row - each bar's width
 * is that stage's real share of the total pipeline count (never a fabricated
 * or estimated value), so "what's happening in the pipeline" is readable at
 * a glance instead of requiring the reader to compare numbers column by
 * column. The bar is a quiet slate fill, not accent-colored - accent is
 * reserved for genuinely positive/active signals, and "5 leads sitting at
 * Contacted" is neutral information, not a success state.
 */
export function PipelineSnapshot({ pipeline }: { pipeline: PipelineCounts }) {
  const total = PIPELINE_STAGES.reduce((sum, { stage }) => sum + pipeline[stage], 0);
  const max = Math.max(1, ...PIPELINE_STAGES.map(({ stage }) => pipeline[stage]));

  return (
    <div>
      <p className={sectionLabelClass}>Current work</p>
      {total === 0 ? (
        <p className="mt-3 text-sm text-slate-500">Your pipeline will appear here once leads start coming in.</p>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          {PIPELINE_STAGES.map(({ stage, label }) => {
            const count = pipeline[stage];
            const widthPct = count === 0 ? 0 : Math.max(4, (count / max) * 100);
            return (
              <div key={stage} className="flex items-center gap-3">
                <span className="w-28 shrink-0 truncate text-sm text-slate-600">{label}</span>
                <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-100">
                  <span
                    className="block h-full rounded-full bg-slate-400 transition-[width]"
                    style={{ width: `${widthPct}%` }}
                    aria-hidden
                  />
                </span>
                <span className="w-6 shrink-0 text-right text-sm font-medium tabular-nums text-slate-900">{count}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

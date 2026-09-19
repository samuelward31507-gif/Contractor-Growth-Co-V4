import { sectionLabelClass } from "@/lib/ui/typography";
import { PIPELINE_STAGES, type PipelineCounts } from "@/lib/dashboard/queries";

/**
 * A compact stage-by-stage row list, flush on the page canvas - the list's
 * own order already communicates sequence, so no card, box, or decorative
 * index badge is needed.
 */
export function PipelineSnapshot({ pipeline }: { pipeline: PipelineCounts }) {
  const total = PIPELINE_STAGES.reduce((sum, { stage }) => sum + pipeline[stage], 0);

  return (
    <div>
      <p className={sectionLabelClass}>Current work</p>
      {total === 0 ? (
        <p className="mt-3 text-sm text-slate-500">Your pipeline will appear here once leads start coming in.</p>
      ) : (
        <div className="mt-3 divide-y divide-slate-100">
          {PIPELINE_STAGES.map(({ stage, label }) => (
            <div key={stage} className="flex items-center justify-between py-2.5">
              <span className="text-sm text-slate-600">{label}</span>
              <span className="text-sm font-medium tabular-nums text-slate-900">{pipeline[stage]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

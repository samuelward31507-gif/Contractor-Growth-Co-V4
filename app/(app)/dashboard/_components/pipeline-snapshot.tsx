import { cardClass, cardHeaderClass, cardTitleClass } from "@/lib/ui/card";
import { PIPELINE_STAGES, type PipelineCounts } from "@/lib/dashboard/queries";

export function PipelineSnapshot({ pipeline }: { pipeline: PipelineCounts }) {
  const total = PIPELINE_STAGES.reduce((sum, { stage }) => sum + pipeline[stage], 0);

  return (
    <div className={cardClass}>
      <div className={cardHeaderClass}>
        <h2 className={cardTitleClass}>Pipeline Snapshot</h2>
      </div>
      {total === 0 ? (
        <div className="px-5 py-10 text-center">
          <p className="text-sm font-medium text-slate-900">No leads yet.</p>
          <p className="mt-1 text-xs text-slate-500">Your pipeline will appear here once leads start coming in.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 px-5 py-5 sm:grid-cols-3 lg:grid-cols-6">
          {PIPELINE_STAGES.map(({ stage, label }, index) => (
            <div key={stage} className="relative">
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">
                  {index + 1}
                </span>
                <span className="text-xs font-medium text-slate-500">{label}</span>
              </div>
              <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">{pipeline[stage]}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

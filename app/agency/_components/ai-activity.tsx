import { Bot, Info } from "lucide-react";
import { SectionCard } from "@/lib/ui/section-card";
import { formatCount } from "./format";
import type { AgencyBusinessSummary } from "@/lib/agency/queries";

/**
 * Interaction counts only. The backend has confirmed tokens_used is never
 * populated by any write path in this codebase - this component shows that
 * honestly (dataQuality.aiTokenUsageUnavailable) rather than displaying a
 * fabricated "0 tokens" or an estimated cost figure.
 */
export function AiActivity({
  summary,
  aiTokenUsageUnavailable,
}: {
  summary: AgencyBusinessSummary;
  aiTokenUsageUnavailable: boolean;
}) {
  const typeEntries = Object.entries(summary.aiInteractionsByType).sort(([, a], [, b]) => b - a);

  return (
    <SectionCard title="AI activity" icon={Bot}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2">
          <p className="text-[10.5px] font-medium uppercase tracking-wide text-slate-500">AI interactions</p>
          <p className="mt-0.5 text-xl font-semibold tracking-tight tabular-nums text-slate-900">{formatCount(summary.aiInteractions)}</p>
        </div>

        {typeEntries.length > 0 ? (
          <dl className="flex flex-1 flex-wrap gap-x-5 gap-y-1.5">
            {typeEntries.map(([type, count]) => (
              <div key={type} className="min-w-[8rem]">
                <dt className="text-xs text-slate-500">{type}</dt>
                <dd className="mt-0.5 text-sm font-semibold tabular-nums text-slate-900">{formatCount(count)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>

      {aiTokenUsageUnavailable ? (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          <Info className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
          AI token usage unavailable - not tracked by any automation path yet.
        </div>
      ) : null}
    </SectionCard>
  );
}

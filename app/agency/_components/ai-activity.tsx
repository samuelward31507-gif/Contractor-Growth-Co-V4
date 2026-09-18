import { sectionLabelClass, metaClass } from "@/lib/ui/typography";
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
    <div className="border-t border-slate-200 pt-8">
      <p className={sectionLabelClass}>AI activity</p>
      <div className="mt-3">
        <p className="text-xs text-slate-500">AI interactions</p>
        <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-slate-900">{formatCount(summary.aiInteractions)}</p>
      </div>

      {typeEntries.length > 0 ? (
        <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3">
          {typeEntries.map(([type, count]) => (
            <div key={type}>
              <dt className="text-xs text-slate-500">{type}</dt>
              <dd className="mt-0.5 text-sm font-medium tabular-nums text-slate-900">{formatCount(count)}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <p className={`mt-4 ${metaClass}`}>{aiTokenUsageUnavailable ? "AI token usage unavailable - not tracked by any automation path yet." : "Token usage data not shown."}</p>
    </div>
  );
}

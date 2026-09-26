import { sectionLabelClass, metaClass } from "@/lib/ui/typography";
import { formatRelativeTime } from "@/lib/dashboard/format";
import type { CachedBusinessInsights } from "@/lib/dashboard/business-metrics";
import { GenerateInsightsButton } from "./generate-insights-button";
import { Badge } from "@/lib/ui/badge";

/**
 * Phase 5.4 - renders ONLY the already-persisted Phase 5.3 output (read via
 * lib/dashboard/business-metrics.ts's getCachedBusinessInsights). This
 * component never calls Claude itself and never recomputes an insight - see
 * generate-insights-button.tsx for the one deliberate, user-triggered path
 * that does. A missing, stale, or malformed cached insight all render a
 * plain, honest state here - never a fabricated one.
 */
export function AiInsightsPanel({ cached }: { cached: CachedBusinessInsights | null }) {
  const buttonLabel = cached ? "Regenerate" : "Generate insights";

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className={sectionLabelClass}>AI business insights</h3>
          {cached ? (
            <p className={`mt-1 ${metaClass}`}>
              Generated {formatRelativeTime(cached.generatedAt)}
              {!cached.isFresh ? " · may be out of date" : ""}
            </p>
          ) : null}
        </div>
        <GenerateInsightsButton label={buttonLabel} />
      </div>

      {!cached ? (
        <p className="mt-4 text-sm text-slate-500">Insights haven&apos;t been generated yet for this period.</p>
      ) : cached.report.insights.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">
          {cached.report.summary || "Not enough business activity yet to generate meaningful insights."}
        </p>
      ) : (
        <>
          <p className="mt-4 text-sm text-slate-600">{cached.report.summary}</p>
          <ul className="mt-4 divide-y divide-slate-100">
            {cached.report.insights.map((insight, index) => (
              <li key={`${insight.type}-${index}`} className="py-3">
                <div className="flex items-baseline gap-2">
                  <p className="text-sm font-medium text-slate-900">{insight.title}</p>
                  {insight.severity === "attention" ? <Badge tone="warning">Attention</Badge> : null}
                </div>
                <p className="mt-0.5 text-sm text-slate-600">{insight.description}</p>
              </li>
            ))}
          </ul>
          {cached.report.dataLimitations.length > 0 ? (
            <p className={`mt-3 ${metaClass}`}>{cached.report.dataLimitations.join(" ")}</p>
          ) : null}
        </>
      )}
    </div>
  );
}

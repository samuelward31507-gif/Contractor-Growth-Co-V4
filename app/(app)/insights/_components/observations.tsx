import { formatRelativeTime } from "@/lib/dashboard/format";
import type { CachedBusinessInsights } from "@/lib/dashboard/business-metrics";
import type { InsightType } from "@/lib/bi/insights";
import { StatusDot } from "@/lib/ui/status-dot";
import { GenerateInsightsButton } from "../../dashboard/_components/generate-insights-button";
import { Panel } from "./metric-panel";

const INSIGHT_KIND: Record<InsightType, string> = {
  lead_volume: "Leads",
  pipeline: "Pipeline",
  estimates: "Estimates",
  appointments: "Appointments",
  jobs: "Jobs",
  communication: "Communication",
  follow_up: "Follow-up",
  automation: "Automation",
  data_quality: "Data",
};

/**
 * The cached business observations (moved here from Today - they are a
 * historical read, not a "right now" one). Each report is generated from
 * the fixed last-30-days snapshot (DASHBOARD_DEFAULT_RANGE), so the scope
 * says so and never follows this page's range selector. Renders only what
 * was already generated and persisted; the one deliberate generate/refresh
 * path is the existing button. Plain business observations - no AI branding.
 */
export function ObservationsPanel({ cached }: { cached: CachedBusinessInsights | null }) {
  const scope = cached ? `Last 30 days · updated ${formatRelativeTime(cached.generatedAt)}${cached.isFresh ? "" : " · may be out of date"}` : "Last 30 days";

  return (
    <Panel id="observations" title="Observations" scope={scope}>
      {!cached ? (
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-5">
          <p className="text-[13px] text-ink-3">No observations yet. They summarize the last 30 days, whatever range is selected above.</p>
          <GenerateInsightsButton label="Generate observations" />
        </div>
      ) : (
        <>
          {cached.report.insights.length === 0 ? (
            <p className="px-4 py-4 text-[13px] text-ink-3 sm:px-5">{cached.report.summary || "Not enough business activity yet for a meaningful observation."}</p>
          ) : (
            <ul className="divide-y divide-line">
              {cached.report.insights.map((insight, index) => (
                <li key={`${insight.type}-${index}`} className="px-4 py-3 sm:px-5">
                  <p className="flex items-center gap-1.5 text-xs font-medium text-ink-3">
                    {insight.severity === "attention" ? <StatusDot tone="attention" /> : null}
                    {insight.severity === "attention" ? "Attention" : (INSIGHT_KIND[insight.type] ?? "Observation")}
                  </p>
                  <p className="mt-0.5 text-[13px] font-medium text-ink">{insight.title}</p>
                  <p className="mt-0.5 text-[13px] leading-5 text-ink-2">{insight.description}</p>
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-end border-t border-line px-4 py-2.5 sm:px-5">
            <GenerateInsightsButton label="Refresh" />
          </div>
        </>
      )}
    </Panel>
  );
}

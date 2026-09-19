import { Workflow } from "lucide-react";
import { primarySectionTitleClass } from "@/lib/ui/typography";
import { Panel } from "@/lib/ui/section-card";
import { Badge } from "@/lib/ui/badge";
import { EmptyState } from "@/lib/ui/empty-state";
import { HEALTH_STATUS_BADGE } from "./health-summary-cards";
import type { AutomationHealthSummary } from "@/lib/automation-health/types";

function formatRate(rate: number | null): string {
  if (rate === null) return "—";
  return `${Math.round(rate)}%`;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

/**
 * Per-automation health - reuses lib/automation-health/health.ts's own
 * getAutomationHealthSummaries, which itself reuses the Automation Control
 * Center's existing getWorkflowNameStats rather than recomputing execution
 * statistics a second time.
 */
export function AutomationHealthTable({ summaries }: { summaries: AutomationHealthSummary[] }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className={primarySectionTitleClass}>Automation health</h2>
      {summaries.length === 0 ? (
        <EmptyState icon={Workflow} title="No automations yet" description="Per-automation health will show up here once your automations start running." />
      ) : (
        <Panel className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-[10.5px] font-medium uppercase tracking-wide text-slate-400">
                  <th className="py-2 pl-4 pr-4 font-medium">Automation</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium">Active incidents</th>
                  <th className="py-2 pr-4 font-medium">Recent failures</th>
                  <th className="py-2 pr-4 font-medium">Failure rate</th>
                  <th className="py-2 pr-4 font-medium">Last execution</th>
                  <th className="py-2 pr-4 font-medium">Last failure</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {summaries.map((summary) => {
                  const statusBadge = HEALTH_STATUS_BADGE[summary.status];
                  return (
                    <tr key={summary.automationId}>
                      <td className="py-2 pl-4 pr-4 font-medium text-slate-900">{summary.automationName}</td>
                      <td className="py-2 pr-4">
                        <Badge tone={statusBadge.tone} icon={statusBadge.icon}>
                          {statusBadge.label}
                        </Badge>
                      </td>
                      <td className="py-2 pr-4 tabular-nums text-slate-700">{summary.activeIncidentCount}</td>
                      <td className={`py-2 pr-4 tabular-nums ${summary.recentFailures > 0 ? "font-medium text-red-600" : "text-slate-700"}`}>{summary.recentFailures}</td>
                      <td className="py-2 pr-4 tabular-nums text-slate-700">{formatRate(summary.failureRate)}</td>
                      <td className="py-2 pr-4 whitespace-nowrap text-slate-600">{formatWhen(summary.lastExecutionAt)}</td>
                      <td className="py-2 pr-4 whitespace-nowrap text-slate-600">{formatWhen(summary.lastFailureAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </section>
  );
}

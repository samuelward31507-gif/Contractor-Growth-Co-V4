import { primarySectionTitleClass } from "@/lib/ui/typography";
import type { AutomationHealthSummary } from "@/lib/automation-health/types";

const STATUS_CLASS: Record<AutomationHealthSummary["status"], string> = {
  healthy: "bg-emerald-50 text-emerald-700",
  degraded: "bg-amber-50 text-amber-700",
  unhealthy: "bg-red-50 text-red-700",
};

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
      <div className="-mx-4 overflow-x-auto sm:-mx-6 lg:-mx-10">
        <div className="min-w-[900px] px-4 sm:px-6 lg:px-10">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-[10.5px] font-medium uppercase tracking-wide text-slate-400">
                <th className="py-1.5 pr-4 font-medium">Automation</th>
                <th className="py-1.5 pr-4 font-medium">Status</th>
                <th className="py-1.5 pr-4 font-medium">Active incidents</th>
                <th className="py-1.5 pr-4 font-medium">Recent failures</th>
                <th className="py-1.5 pr-4 font-medium">Failure rate</th>
                <th className="py-1.5 pr-4 font-medium">Last execution</th>
                <th className="py-1.5 font-medium">Last failure</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {summaries.map((summary) => (
                <tr key={summary.automationId}>
                  <td className="py-2 pr-4 font-medium text-slate-900">{summary.automationName}</td>
                  <td className="py-2 pr-4">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[summary.status]}`}>{summary.status}</span>
                  </td>
                  <td className="py-2 pr-4 tabular-nums text-slate-700">{summary.activeIncidentCount}</td>
                  <td className={`py-2 pr-4 tabular-nums ${summary.recentFailures > 0 ? "font-medium text-red-600" : "text-slate-700"}`}>{summary.recentFailures}</td>
                  <td className="py-2 pr-4 tabular-nums text-slate-700">{formatRate(summary.failureRate)}</td>
                  <td className="py-2 pr-4 whitespace-nowrap text-slate-600">{formatWhen(summary.lastExecutionAt)}</td>
                  <td className="py-2 whitespace-nowrap text-slate-600">{formatWhen(summary.lastFailureAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

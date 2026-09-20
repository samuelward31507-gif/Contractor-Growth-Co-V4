import { Badge, type BadgeTone } from "@/lib/ui/badge";
import { formatRelativeTime } from "@/lib/dashboard/format";
import { formatCount } from "./format";
import type { AutomationHealthSummary, AutomationHealthStatus } from "@/lib/automation-health/types";

const STATUS_TONE: Record<AutomationHealthStatus, BadgeTone> = {
  healthy: "success",
  degraded: "warning",
  unhealthy: "danger",
};

const STATUS_LABEL: Record<AutomationHealthStatus, string> = {
  healthy: "Healthy",
  degraded: "Attention",
  unhealthy: "Critical",
};

/**
 * Client detail 2.0, Section 6.E - real per-automation operational state,
 * sourced from lib/agency/automations.ts (a thin authorization wrapper over
 * lib/automation-health/health.ts's own getAutomationHealthSummaries).
 * Excludes safety-layer automations already (that filtering happens in
 * getAutomationHealthSummaries itself) - every row here is a real,
 * independently-triggerable automation from AUTOMATION_CATALOG, never an
 * invented one.
 */
export function AutomationsPanel({ automations }: { automations: AutomationHealthSummary[] }) {
  if (automations.length === 0) {
    return <p className="mt-3 text-sm text-slate-500">No automations are configured for this client yet.</p>;
  }

  return (
    <ul className="mt-3 divide-y divide-slate-100">
      {automations.map((automation) => (
        <li key={automation.automationId} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-900">{automation.automationName}</p>
            <p className="mt-0.5 text-xs text-slate-500">
              {automation.status === "healthy"
                ? automation.lastExecutionAt
                  ? `Last execution: ${formatRelativeTime(automation.lastExecutionAt)}`
                  : "No executions yet"
                : automation.lastFailureAt
                  ? `Last failure: ${formatRelativeTime(automation.lastFailureAt)}`
                  : `${formatCount(automation.recentFailures)} recent failure${automation.recentFailures === 1 ? "" : "s"}`}
            </p>
          </div>
          <Badge tone={STATUS_TONE[automation.status]}>{STATUS_LABEL[automation.status]}</Badge>
        </li>
      ))}
    </ul>
  );
}

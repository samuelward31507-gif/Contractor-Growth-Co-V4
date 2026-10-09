import { Badge, type BadgeTone } from "@/lib/ui/badge";
import { Table, TableHeadCell, TableBody, TableCell } from "@/lib/ui/table";
import { formatRelativeTime } from "@/lib/dashboard/format";
import type { AutomationHealthSummary, AutomationHealthStatus } from "@/lib/automation-health/types";
import { formatCount } from "../../../_components/format";
import { SectionEmpty } from "./section-empty";

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

const RAIL: Record<AutomationHealthStatus, string> = {
  healthy: "border-l-transparent",
  degraded: "border-l-warning",
  unhealthy: "border-l-danger",
};

const COLUMNS = "grid-cols-[minmax(0,1fr)_120px_minmax(0,220px)]";

/**
 * The same last-activity sentence app/agency/_components/automations-panel.tsx
 * shows - a healthy automation reports its last execution, an unhealthy one
 * its last failure (or its recent failure count when no failure time exists).
 */
function lastActivity(automation: AutomationHealthSummary): string {
  if (automation.status === "healthy") {
    return automation.lastExecutionAt ? `Last execution: ${formatRelativeTime(automation.lastExecutionAt)}` : "No executions yet";
  }
  return automation.lastFailureAt
    ? `Last failure: ${formatRelativeTime(automation.lastFailureAt)}`
    : `${formatCount(automation.recentFailures)} recent failure${automation.recentFailures === 1 ? "" : "s"}`;
}

/**
 * Real per-automation operational state from lib/agency/automations.ts
 * (safety-layer automations are already filtered out upstream). Rows are
 * not links - there is no per-automation agency route - so they render as
 * static rows on the shared Table header/body shell, with a stacked list
 * below `lg` (the shared table is desktop-only by design).
 */
export function AutomationsTable({ automations }: { automations: AutomationHealthSummary[] }) {
  if (automations.length === 0) {
    return <SectionEmpty title="No automations are configured for this client yet." description="Automations appear here once they are set up for this client." />;
  }

  return (
    <>
      <div className="lg:-mx-3.5">
        <Table columns={COLUMNS}>
          <TableHeadCell>Automation</TableHeadCell>
          <TableHeadCell>Status</TableHeadCell>
          <TableHeadCell>Last activity</TableHeadCell>
        </Table>
        <TableBody>
          {automations.map((automation) => (
            <div key={automation.automationId} className={`grid min-h-12 ${COLUMNS} items-center gap-6 border-l-2 py-2.5 pl-3 pr-4 ${RAIL[automation.status]}`}>
              <TableCell className="font-medium">{automation.automationName}</TableCell>
              <span>
                <Badge tone={STATUS_TONE[automation.status]}>{STATUS_LABEL[automation.status]}</Badge>
              </span>
              <TableCell muted>{lastActivity(automation)}</TableCell>
            </div>
          ))}
        </TableBody>
      </div>

      <ul className="divide-y divide-line lg:hidden">
        {automations.map((automation) => (
          <li key={automation.automationId} className="flex items-start justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">{automation.automationName}</p>
              <p className="mt-0.5 text-xs text-ink-3">{lastActivity(automation)}</p>
            </div>
            <Badge tone={STATUS_TONE[automation.status]}>{STATUS_LABEL[automation.status]}</Badge>
          </li>
        ))}
      </ul>
    </>
  );
}

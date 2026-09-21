import Link from "next/link";
import { sectionLabelClass } from "@/lib/ui/typography";
import { formatRelativeTime } from "@/lib/dashboard/format";
import type { OrganizationHealthStatus } from "@/lib/automation-health/types";

const STATUS_DOT: Record<OrganizationHealthStatus, string> = {
  healthy: "bg-emerald-500",
  degraded: "bg-amber-500",
  unhealthy: "bg-red-500",
};

const STATUS_LABEL: Record<OrganizationHealthStatus, string> = {
  healthy: "Running normally",
  degraded: "Needs attention",
  unhealthy: "Issues detected",
};

/**
 * Client #1 polish pass - the plain, owner-facing answer to "is my system
 * working," reusing lib/automation-health/health.ts's own
 * getOrganizationHealth() exactly as-is (the same deterministic
 * healthy/degraded/unhealthy status and real incident count the deeper
 * /automation-health page and the Agency Command Center already show) -
 * no new health model, no invented score. Every value here either comes
 * from that read or is explicitly omitted when there's nothing true to
 * say (no leads yet, no automation activity yet) - never a fabricated
 * timestamp or count. "Automation activity" is deliberately not called
 * "workflow executions" or "automation events" here - the contractor never
 * needs to know n8n or workflow_executions exist; that vocabulary stays on
 * the linked /automation-health page for whoever actually needs it.
 */
export function SystemStatus({
  status,
  lastLeadCapturedAt,
  automationActivityToday,
  issuesRequiringAttention,
}: {
  status: OrganizationHealthStatus;
  lastLeadCapturedAt: string | null;
  automationActivityToday: number;
  issuesRequiringAttention: number;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <p className={sectionLabelClass}>System status</p>
        <Link href="/automation-health" className="text-xs font-medium text-slate-500 hover:text-slate-900">
          View details
        </Link>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[status]}`} aria-hidden />
        <p className="text-sm font-semibold text-slate-900">{STATUS_LABEL[status]}</p>
      </div>

      <div className="mt-3 divide-y divide-slate-100">
        {lastLeadCapturedAt ? (
          <div className="flex items-baseline justify-between gap-3 py-1.5">
            <span className="text-sm text-slate-600">Last lead captured</span>
            <span className="text-sm font-medium tabular-nums text-slate-900">{formatRelativeTime(lastLeadCapturedAt)}</span>
          </div>
        ) : null}
        <div className="flex items-baseline justify-between gap-3 py-1.5">
          <span className="text-sm text-slate-600">Automation activity</span>
          <span className="text-sm font-medium tabular-nums text-slate-900">{automationActivityToday} today</span>
        </div>
        <div className="flex items-baseline justify-between gap-3 py-1.5">
          <span className="text-sm text-slate-600">Issues requiring attention</span>
          <span className={`text-sm font-medium tabular-nums ${issuesRequiringAttention > 0 ? "text-red-600" : "text-slate-900"}`}>
            {issuesRequiringAttention}
          </span>
        </div>
      </div>
    </div>
  );
}

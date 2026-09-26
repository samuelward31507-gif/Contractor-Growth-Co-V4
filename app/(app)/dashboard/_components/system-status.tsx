import Link from "next/link";
import { sectionLabelClass } from "@/lib/ui/typography";
import { formatRelativeTime } from "@/lib/dashboard/format";
import type { OrganizationHealthStatus } from "@/lib/automation-health/types";

/**
 * Trackpr 2.0, Phase 2A: no longer rendered on the dashboard - per the
 * locked Phase 2 decision, system health is not a standalone dashboard
 * section; app/(app)/_components/top-bar.tsx already shows the same
 * getOrganizationHealth-derived status globally, on every authenticated
 * page, not just this one. Left unused rather than deleted (per this
 * pass's own instruction not to perform unrelated cleanup) - the
 * underlying getOrganizationHealth read, /automation-health page, and every
 * health/payment/pause state it models are all completely untouched.
 */

/**
 * Pass 5A: "paused" and "payment_blocked" joined the original 3 states so
 * this line can never say "Running normally" while automation is actually
 * blocked or intentionally paused - see lib/automation-health/health.ts's
 * own organizationStatus() for the precedence rule these labels mirror.
 */
const STATUS_DOT: Record<OrganizationHealthStatus, string> = {
  healthy: "bg-emerald-500",
  degraded: "bg-amber-500",
  unhealthy: "bg-red-500",
  paused: "bg-slate-400",
  payment_blocked: "bg-red-500",
};

const STATUS_LABEL: Record<OrganizationHealthStatus, string> = {
  healthy: "Running normally",
  degraded: "Needs attention",
  unhealthy: "Issues detected",
  paused: "Automation paused",
  payment_blocked: "Payment action needed",
};

/**
 * Client #1 polish pass - the plain, owner-facing answer to "is my system
 * working," reusing lib/automation-health/health.ts's own
 * getOrganizationHealth() exactly as-is (the same deterministic status and
 * real incident count the deeper /automation-health page and the Agency
 * Command Center already show) -
 * no new health model, no invented score. Every value here either comes
 * from that read or is explicitly omitted when there's nothing true to
 * say (no leads yet, no automation activity yet) - never a fabricated
 * timestamp or count. "Automation activity" is deliberately not called
 * "workflow executions" or "automation events" here - the contractor never
 * needs to know n8n or workflow_executions exist; that vocabulary stays on
 * the linked /automation-health page for whoever actually needs it.
 */
/**
 * Pass 5A: one short, honest sentence explaining WHY, only shown for the two
 * states where "the badge label alone" could otherwise leave an owner
 * guessing - never invents a cause, never names who paused it (Step 7: "do
 * not fabricate who paused it"), and never offers a self-service toggle a
 * contractor isn't authorized to use.
 */
function statusDetail(status: OrganizationHealthStatus, staleScheduledAutomationCount: number): string | null {
  if (status === "payment_blocked") return "Automated messages are paused until payment is resolved.";
  if (status === "paused") return "Automation has been paused for this account. Contact Contractor Growth Co. to resume it.";
  if (staleScheduledAutomationCount > 0) {
    return `${staleScheduledAutomationCount} scheduled automation${staleScheduledAutomationCount === 1 ? "" : "s"} may not have run recently.`;
  }
  return null;
}

export function SystemStatus({
  status,
  lastLeadCapturedAt,
  automationActivityToday,
  issuesRequiringAttention,
  staleScheduledAutomationCount,
}: {
  status: OrganizationHealthStatus;
  lastLeadCapturedAt: string | null;
  automationActivityToday: number;
  issuesRequiringAttention: number;
  staleScheduledAutomationCount: number;
}) {
  const detail = statusDetail(status, staleScheduledAutomationCount);

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <p className={sectionLabelClass}>System status</p>
        <Link href={status === "payment_blocked" ? "/onboarding" : "/automation-health"} className="text-xs font-medium text-slate-500 hover:text-slate-900">
          {status === "payment_blocked" ? "Resolve payment" : "View details"}
        </Link>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[status]}`} aria-hidden />
        <p className="text-sm font-semibold text-slate-900">{STATUS_LABEL[status]}</p>
      </div>

      {detail ? <p className="mt-1 text-xs text-slate-500">{detail}</p> : null}

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

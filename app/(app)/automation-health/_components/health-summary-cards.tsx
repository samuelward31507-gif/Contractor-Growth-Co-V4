import { CheckCircle2, AlertTriangle, AlertOctagon, type LucideIcon } from "lucide-react";
import type { OrganizationHealthSummary } from "@/lib/automation-health/types";
import type { BadgeTone } from "@/lib/ui/badge";
import { metaClass, statLabelClass } from "@/lib/ui/typography";

/**
 * Single source of truth for how an organization/automation health status
 * maps onto the shared Badge primitive - reused by the page header (the
 * "is my system working?" headline answer) and by AutomationHealthTable's
 * per-automation rows.
 */
export const HEALTH_STATUS_BADGE: Record<OrganizationHealthSummary["status"], { label: string; tone: BadgeTone; icon: LucideIcon }> = {
  healthy: { label: "Healthy", tone: "success", icon: CheckCircle2 },
  degraded: { label: "Degraded", tone: "warning", icon: AlertTriangle },
  unhealthy: { label: "Unhealthy", tone: "danger", icon: AlertOctagon },
};

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatRate(rate: number | null): string {
  if (rate === null) return "Not enough data yet";
  return `${Math.round(rate)}%`;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString();
}

/**
 * Supporting detail behind the page header's headline health status -
 * deterministic, read directly from lib/automation-health/health.ts's own
 * getOrganizationHealth. The overall status itself already leads the page
 * (see the page header's badge, built from HEALTH_STATUS_BADGE above); this
 * strip is the "why" behind that answer, not a second headline.
 *
 * Deliberately the same restrained "integrated row" convention as
 * Leads/Estimates/Jobs' own overview strips (label recedes, number carries
 * the weight - see lib/ui/typography.ts's statLabelClass/statValueClass),
 * not a grid of bordered monitoring-tool metric tiles: when every number
 * here is zero, six boxed cards read like a DevOps dashboard even though
 * nothing is wrong, which fights the "calm when healthy" brief. Six plain
 * numbers in a row, with color reserved for the ones that are actually
 * nonzero, reads calm at rest and still gets your eye to whatever number
 * needs it.
 */
export function HealthSummaryCards({ health }: { health: OrganizationHealthSummary }) {
  const stats = [
    { key: "active", label: "Active incidents", value: formatCount(health.activeIncidentCount), tone: health.activeIncidentCount > 0 ? "text-amber-600" : "text-slate-900" },
    { key: "critical", label: "Critical", value: formatCount(health.criticalIncidentCount), tone: health.criticalIncidentCount > 0 ? "text-red-600" : "text-slate-900" },
    { key: "warning", label: "Warning", value: formatCount(health.warningIncidentCount), tone: health.warningIncidentCount > 0 ? "text-amber-600" : "text-slate-900" },
    { key: "stuck", label: "Stuck executions", value: formatCount(health.stuckExecutionCount), tone: health.stuckExecutionCount > 0 ? "text-amber-600" : "text-slate-900" },
    { key: "delivery", label: "SMS delivery failures", value: formatCount(health.smsDeliveryFailureCount), tone: health.smsDeliveryFailureCount > 0 ? "text-amber-600" : "text-slate-900" },
    { key: "success-rate", label: "Success rate (30d)", value: formatRate(health.automationSuccessRate), tone: "text-slate-900" },
  ];

  return (
    <div className="flex flex-col gap-3">
      <dl className="flex flex-wrap gap-x-10 gap-y-4">
        {stats.map((stat) => (
          <div key={stat.key}>
            <dt className={statLabelClass}>{stat.label}</dt>
            <dd className={`mt-1 text-2xl font-semibold tracking-tight tabular-nums ${stat.tone}`}>{stat.value}</dd>
          </div>
        ))}
      </dl>
      <p className={metaClass}>
        Last success: {formatRelative(health.lastSuccessfulActivityAt)} · Last failure: {formatRelative(health.lastFailureAt)}
      </p>
    </div>
  );
}

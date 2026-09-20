import { CheckCircle2, AlertTriangle, AlertOctagon, type LucideIcon } from "lucide-react";
import type { OrganizationHealthSummary } from "@/lib/automation-health/types";
import type { BadgeTone } from "@/lib/ui/badge";
import { metaClass } from "@/lib/ui/typography";
import { StatGrid, StatCard } from "@/lib/ui/stat-card";

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
 * grid is the "why" behind that answer, not a second headline.
 *
 * Final visual polish pass: converted from the prior pass's de-boxed
 * "integrated row" back to the app-wide StatCard primitive (every other
 * page's primary metrics now use it, and an unboxed strip here reads
 * inconsistent rather than calm). The calm-when-healthy intent survives
 * through color discipline alone, not through avoiding the card treatment:
 * every stat defaults to `tone="neutral"` and only flips to `warning`/
 * `danger` when the underlying count is actually nonzero - the exact same
 * rule the prior pass's plain-text row used (color reserved for numbers
 * that need attention). Six zero counts in six neutral cards still reads
 * calm; a real incident still turns exactly its own card amber/red, no
 * more colorful than the previous plain-text version was. 3+3 (columns=3,
 * wrapping to two rows) instead of a cramped 6-wide row.
 */
export function HealthSummaryCards({ health }: { health: OrganizationHealthSummary }) {
  const stats: { key: string; label: string; value: string; tone: BadgeTone; icon: LucideIcon }[] = [
    { key: "active", label: "Active incidents", value: formatCount(health.activeIncidentCount), tone: health.activeIncidentCount > 0 ? "warning" : "neutral", icon: AlertTriangle },
    { key: "critical", label: "Critical", value: formatCount(health.criticalIncidentCount), tone: health.criticalIncidentCount > 0 ? "danger" : "neutral", icon: AlertOctagon },
    { key: "warning", label: "Warning", value: formatCount(health.warningIncidentCount), tone: health.warningIncidentCount > 0 ? "warning" : "neutral", icon: AlertTriangle },
    { key: "stuck", label: "Stuck executions", value: formatCount(health.stuckExecutionCount), tone: health.stuckExecutionCount > 0 ? "warning" : "neutral", icon: AlertTriangle },
    { key: "delivery", label: "SMS delivery failures", value: formatCount(health.smsDeliveryFailureCount), tone: health.smsDeliveryFailureCount > 0 ? "warning" : "neutral", icon: AlertTriangle },
    { key: "success-rate", label: "Success rate (30d)", value: formatRate(health.automationSuccessRate), tone: "neutral", icon: CheckCircle2 },
  ];

  return (
    <div className="flex flex-col gap-3">
      <StatGrid columns={3}>
        {stats.map((stat) => (
          <StatCard key={stat.key} label={stat.label} value={stat.value} tone={stat.tone} icon={stat.icon} />
        ))}
      </StatGrid>
      <p className={metaClass}>
        Last success: {formatRelative(health.lastSuccessfulActivityAt)} · Last failure: {formatRelative(health.lastFailureAt)}
      </p>
    </div>
  );
}

import { CheckCircle2, AlertTriangle, AlertOctagon, PauseCircle, CreditCard, type LucideIcon } from "lucide-react";
import type { OrganizationHealthSummary } from "@/lib/automation-health/types";
import type { BadgeTone } from "@/lib/ui/badge";

/**
 * Single source of truth for how an organization/automation health status
 * maps onto the shared Badge primitive - reused by the page header (the
 * "is my system working?" headline answer) and by AutomationHealthTable's
 * per-automation rows.
 *
 * Pass 5A: "paused" and "payment_blocked" joined the original 3 states
 * (see lib/automation-health/types.ts) so an intentionally paused or
 * payment-blocked organization is never labeled with the same "Healthy"
 * badge this page previously had no way to distinguish it from.
 */
export const HEALTH_STATUS_BADGE: Record<OrganizationHealthSummary["status"], { label: string; tone: BadgeTone; icon: LucideIcon }> = {
  healthy: { label: "Healthy", tone: "success", icon: CheckCircle2 },
  degraded: { label: "Degraded", tone: "warning", icon: AlertTriangle },
  unhealthy: { label: "Unhealthy", tone: "danger", icon: AlertOctagon },
  paused: { label: "Automation paused", tone: "neutral", icon: PauseCircle },
  payment_blocked: { label: "Payment action needed", tone: "danger", icon: CreditCard },
};

const STATUS_STYLE: Record<OrganizationHealthSummary["status"], { ring: string; iconBg: string; iconText: string }> = {
  healthy: { ring: "border-accent-border", iconBg: "bg-accent-muted", iconText: "text-accent" },
  degraded: { ring: "border-warning-border", iconBg: "bg-warning-muted", iconText: "text-warning" },
  unhealthy: { ring: "border-danger-border", iconBg: "bg-danger-muted", iconText: "text-danger" },
  paused: { ring: "border-line", iconBg: "bg-inset", iconText: "text-ink-2" },
  payment_blocked: { ring: "border-danger-border", iconBg: "bg-danger-muted", iconText: "text-danger" },
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
 * The control-center hero: one large, unmissable status read (the icon,
 * label, and 30-day success rate at real size, inside a ring that tints with
 * the current status) instead of the overall status having to be inferred
 * from six equal-weight boxes. The six incident/failure counts still exist,
 * but as a quiet supporting list beside it - detail you check after the hero
 * has already answered "is my system working."
 *
 * Trackpr 2.0 Phase 4: `activeAutomationCount` folds in the one stat the
 * retired standalone SummaryCards (the old /automations overview) showed
 * that this hero did not - everything else it showed (automation activity,
 * needs-attention count, success rate) either duplicated a number already
 * here or was a cruder version of the real incident-based counts below.
 */
export function HealthSummaryCards({ health, activeAutomationCount }: { health: OrganizationHealthSummary; activeAutomationCount: number }) {
  const statusBadge = HEALTH_STATUS_BADGE[health.status];
  const style = STATUS_STYLE[health.status];
  const StatusIcon = statusBadge.icon;

  const detail: { key: string; label: string; value: string; alert: boolean }[] = [
    { key: "automations", label: "Active automations", value: formatCount(activeAutomationCount), alert: false },
    { key: "active", label: "Open issues", value: formatCount(health.activeIncidentCount), alert: health.activeIncidentCount > 0 },
    { key: "critical", label: "Critical", value: formatCount(health.criticalIncidentCount), alert: health.criticalIncidentCount > 0 },
    { key: "warning", label: "Warning", value: formatCount(health.warningIncidentCount), alert: health.warningIncidentCount > 0 },
    { key: "stuck", label: "Running late", value: formatCount(health.stuckExecutionCount), alert: health.stuckExecutionCount > 0 },
    { key: "delivery", label: "Undelivered messages", value: formatCount(health.smsDeliveryFailureCount), alert: health.smsDeliveryFailureCount > 0 },
  ];

  return (
    <div className={`grid grid-cols-1 gap-4 rounded-lg border bg-surface p-5 sm:p-6 lg:grid-cols-[auto_1fr] lg:items-center lg:gap-8 ${style.ring}`}>
      <div className="flex items-center gap-4">
        <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${style.iconBg} ${style.iconText}`}>
          <StatusIcon className="h-5 w-5" aria-hidden />
        </span>
        <div>
          <p className="text-[22px] font-semibold leading-tight tracking-[-0.02em] text-ink">{statusBadge.label}</p>
          <p className="mt-0.5 text-sm text-ink-3">
            Success rate (30d): <span className="font-medium text-ink-2">{formatRate(health.automationSuccessRate)}</span>
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-3 border-t border-line pt-4 sm:grid-cols-3 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
        {detail.map((item) => (
          <div key={item.key}>
            <p className="text-xs text-ink-3">{item.label}</p>
            <p className={`mt-0.5 text-lg font-semibold tabular-nums ${item.alert ? "text-danger" : "text-ink"}`}>{item.value}</p>
          </div>
        ))}
        <div>
          <p className="text-xs text-ink-3">Last success</p>
          <p className="mt-0.5 truncate text-sm font-medium text-ink-2">{formatRelative(health.lastSuccessfulActivityAt)}</p>
        </div>
      </div>
    </div>
  );
}

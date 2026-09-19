import type { OrganizationHealthSummary } from "@/lib/automation-health/types";

const STATUS_CONFIG: Record<OrganizationHealthSummary["status"], { label: string; className: string }> = {
  healthy: { label: "Healthy", className: "bg-emerald-50 text-emerald-700" },
  degraded: { label: "Degraded", className: "bg-amber-50 text-amber-700" },
  unhealthy: { label: "Unhealthy", className: "bg-red-50 text-red-700" },
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
 * Overall organization health - deterministic, read directly from
 * lib/automation-health/health.ts's own getOrganizationHealth. unhealthy
 * (any active critical incident) takes precedence over degraded (any other
 * active incident) over healthy (none) - see that module's own
 * organizationStatus() for the single source of truth this display mirrors.
 */
export function HealthSummaryCards({ health }: { health: OrganizationHealthSummary }) {
  const status = STATUS_CONFIG[health.status];

  const stats = [
    { key: "active", label: "Active incidents", value: formatCount(health.activeIncidentCount), tone: health.activeIncidentCount > 0 ? "text-amber-600" : "text-slate-900" },
    { key: "critical", label: "Critical", value: formatCount(health.criticalIncidentCount), tone: health.criticalIncidentCount > 0 ? "text-red-600" : "text-slate-900" },
    { key: "warning", label: "Warning", value: formatCount(health.warningIncidentCount), tone: health.warningIncidentCount > 0 ? "text-amber-600" : "text-slate-900" },
    { key: "stuck", label: "Stuck executions", value: formatCount(health.stuckExecutionCount), tone: health.stuckExecutionCount > 0 ? "text-amber-600" : "text-slate-900" },
    { key: "delivery", label: "SMS delivery failures", value: formatCount(health.smsDeliveryFailureCount), tone: health.smsDeliveryFailureCount > 0 ? "text-amber-600" : "text-slate-900" },
    { key: "success-rate", label: "Success rate (30d)", value: formatRate(health.automationSuccessRate) },
  ];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-sm font-semibold ${status.className}`}>{status.label}</span>
        <span className="text-xs text-slate-500">
          Last success: {formatRelative(health.lastSuccessfulActivityAt)} · Last failure: {formatRelative(health.lastFailureAt)}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {stats.map((stat) => (
          <div key={stat.key} className="rounded-lg border border-slate-200 bg-white px-3.5 py-2.5">
            <p className="text-[10.5px] font-medium uppercase tracking-wide text-slate-500">{stat.label}</p>
            <p className={`mt-1 text-xl font-semibold tracking-tight tabular-nums ${stat.tone ?? "text-slate-900"}`}>{stat.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

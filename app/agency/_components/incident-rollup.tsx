import { AlertOctagon, CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { formatCount } from "./format";
import { StatGrid, type Stat } from "./stat-grid";
import { SectionCard } from "./section-card";
import type { AgencyIncidentRollup } from "@/lib/agency/health";

/**
 * Automation Health + Alerting V1 rollup for the Agency Command Center - a
 * pure addition, not a redesign of the existing Command Center layout.
 * Every number here comes directly from lib/agency/health.ts's own
 * getAgencyHealth (which itself reuses lib/automation-health/health.ts's
 * getOrganizationHealth per already-authorized organization) - nothing is
 * recomputed here.
 */
export function IncidentRollup({ rollup }: { rollup: AgencyIncidentRollup }) {
  const stats: Stat[] = [
    { key: "healthy", label: "Organizations healthy", value: formatCount(rollup.organizationsHealthy), icon: CheckCircle2 },
    {
      key: "degraded",
      label: "Organizations degraded",
      value: formatCount(rollup.organizationsDegraded),
      icon: AlertTriangle,
      tone: rollup.organizationsDegraded > 0 ? "warning" : "default",
    },
    {
      key: "unhealthy",
      label: "Organizations unhealthy",
      value: formatCount(rollup.organizationsUnhealthy),
      icon: XCircle,
      tone: rollup.organizationsUnhealthy > 0 ? "danger" : "default",
    },
    {
      key: "critical",
      label: "Critical incidents",
      value: formatCount(rollup.criticalIncidents),
      icon: AlertOctagon,
      tone: rollup.criticalIncidents > 0 ? "danger" : "default",
    },
    {
      key: "warning",
      label: "Warning incidents",
      value: formatCount(rollup.warningIncidents),
      icon: AlertTriangle,
      tone: rollup.warningIncidents > 0 ? "warning" : "default",
    },
  ];

  return (
    <SectionCard title="Automation incidents" description="Operational health across client organizations" icon={AlertOctagon}>
      <StatGrid stats={stats} columns="sm:grid-cols-3 lg:grid-cols-5" />
    </SectionCard>
  );
}

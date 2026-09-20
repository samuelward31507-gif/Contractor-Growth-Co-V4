import { sectionLabelClass } from "@/lib/ui/typography";
import { Row } from "./row";
import { formatCount } from "./format";
import type { AgencyIncidentRollup, SchedulerHeartbeat } from "@/lib/agency/health";

/**
 * Agency Command Center UI review: replaces incident-rollup.tsx's six-card
 * StatGrid wall with the same label/value row list every other redesigned
 * section on this page uses. Every number is unchanged, read straight from
 * lib/agency/health.ts's own getAgencyHealth - nothing recomputed here.
 */
export function SystemHealth({
  rollup,
  schedulerHeartbeat,
  smsFailureCount,
  aiEscalationCount,
}: {
  rollup: AgencyIncidentRollup;
  schedulerHeartbeat: SchedulerHeartbeat;
  smsFailureCount: number;
  aiEscalationCount: number;
}) {
  const heartbeatValue =
    schedulerHeartbeat.lastCheckedAt === null
      ? "Never run"
      : schedulerHeartbeat.minutesSinceLastCheck !== null && schedulerHeartbeat.minutesSinceLastCheck < 60
        ? `${schedulerHeartbeat.minutesSinceLastCheck}m ago`
        : `${Math.round((schedulerHeartbeat.minutesSinceLastCheck ?? 0) / 60)}h ago`;

  const hasIssues =
    rollup.organizationsDegraded > 0 ||
    rollup.organizationsUnhealthy > 0 ||
    rollup.criticalIncidents > 0 ||
    rollup.warningIncidents > 0 ||
    smsFailureCount > 0 ||
    aiEscalationCount > 0;

  return (
    <div>
      <p className={sectionLabelClass}>System health</p>

      {/* Issue counts collapse to a single calm line when there is nothing
          to report, rather than nine rows that all read "0" - a real
          problem should stand out immediately, not compete with five other
          zeroes for the same visual weight. */}
      {hasIssues ? (
        <div className="mt-1.5 divide-y divide-slate-100">
          <Row label="Organizations degraded" value={formatCount(rollup.organizationsDegraded)} tone={rollup.organizationsDegraded > 0 ? "warning" : "default"} />
          <Row label="Organizations unhealthy" value={formatCount(rollup.organizationsUnhealthy)} tone={rollup.organizationsUnhealthy > 0 ? "danger" : "default"} />
          <Row label="Critical incidents" value={formatCount(rollup.criticalIncidents)} tone={rollup.criticalIncidents > 0 ? "danger" : "default"} />
          <Row label="Warning incidents" value={formatCount(rollup.warningIncidents)} tone={rollup.warningIncidents > 0 ? "warning" : "default"} />
          <Row label="SMS delivery failures" value={formatCount(smsFailureCount)} tone={smsFailureCount > 0 ? "warning" : "default"} />
          <Row label="AI escalations waiting" value={formatCount(aiEscalationCount)} tone={aiEscalationCount > 0 ? "warning" : "default"} />
        </div>
      ) : (
        <p className="mt-2 text-sm text-slate-500">
          All {formatCount(rollup.organizationsHealthy)} organization{rollup.organizationsHealthy === 1 ? "" : "s"} healthy. No incidents, delivery failures, or AI escalations open.
        </p>
      )}

      <div className="mt-4 divide-y divide-slate-100 border-t border-slate-100 pt-1">
        <Row label="Scheduler last ran" value={heartbeatValue} tone={schedulerHeartbeat.stale ? "danger" : "default"} description={schedulerHeartbeat.stale ? "Stale - scheduled follow-ups may be delayed." : undefined} />
        <Row label="n8n" value="External" description="Not independently monitored" />
      </div>
    </div>
  );
}

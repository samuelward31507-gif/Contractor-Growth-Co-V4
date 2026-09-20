import { sectionLabelClass, metaClass } from "@/lib/ui/typography";
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

  return (
    <div>
      <p className={sectionLabelClass}>System health</p>
      <div className="mt-1.5 divide-y divide-slate-100">
        <Row label="Organizations healthy" value={formatCount(rollup.organizationsHealthy)} />
        <Row label="Organizations degraded" value={formatCount(rollup.organizationsDegraded)} tone={rollup.organizationsDegraded > 0 ? "warning" : "default"} />
        <Row label="Organizations unhealthy" value={formatCount(rollup.organizationsUnhealthy)} tone={rollup.organizationsUnhealthy > 0 ? "danger" : "default"} />
        <Row label="Critical incidents" value={formatCount(rollup.criticalIncidents)} tone={rollup.criticalIncidents > 0 ? "danger" : "default"} />
        <Row label="Warning incidents" value={formatCount(rollup.warningIncidents)} tone={rollup.warningIncidents > 0 ? "warning" : "default"} />
        <Row label="SMS delivery failures" value={formatCount(smsFailureCount)} tone={smsFailureCount > 0 ? "warning" : "default"} />
        <Row label="AI escalations waiting" value={formatCount(aiEscalationCount)} tone={aiEscalationCount > 0 ? "warning" : "default"} />
        <Row label="Scheduler last ran" value={heartbeatValue} tone={schedulerHeartbeat.stale ? "danger" : "default"} />
        <Row label="n8n" value="Not independently monitored" />
      </div>
      {schedulerHeartbeat.stale ? (
        <p className={`mt-2 ${metaClass}`}>
          The automation scheduler hasn&apos;t checked in recently - scheduled follow-ups may be delayed.
        </p>
      ) : null}
      <p className={`mt-2 ${metaClass}`}>
        n8n&apos;s own execution state can&apos;t be independently verified from this application - the scheduler and
        incident signals above are the closest honest proxy for it.
      </p>
    </div>
  );
}

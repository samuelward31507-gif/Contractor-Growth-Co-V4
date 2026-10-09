import { StatusLabel } from "@/lib/ui/status-dot";
import { Row } from "./row";
import { formatCount } from "./format";
import { AgencySection } from "./section";
import type { AgencyIncidentRollup, SchedulerHeartbeat } from "@/lib/agency/health";

/**
 * Agency Command Center UI review: the label/value row list for system
 * health. Every number is unchanged, read straight from lib/agency/health.ts's
 * own getAgencyHealth - nothing recomputed here.
 *
 * Agency overview redesign: a card section (AgencySection) whose header
 * states the overall status in words (StatusLabel - a dot plus a word, never
 * colour alone).
 */
export function SystemHealth({
  rollup,
  schedulerHeartbeat,
  smsFailureCount,
  aiEscalationCount,
  paymentIssueCount,
  automationPausedCount,
}: {
  rollup: AgencyIncidentRollup;
  schedulerHeartbeat: SchedulerHeartbeat;
  smsFailureCount: number;
  /** Phase 3E: null when the escalation read failed - shown as Unavailable, never as 0. */
  aiEscalationCount: number | null;
  /** Organizations whose payment_status is "suspended" or "cancelled" - never "payment_required", a normal transient onboarding state, not itself a regression. */
  paymentIssueCount: number;
  automationPausedCount: number;
}) {
  // Phase 3E: a failed heartbeat read is Unavailable - never "Never run".
  const heartbeatValue = schedulerHeartbeat.unavailable
    ? "Unavailable"
    : schedulerHeartbeat.lastCheckedAt === null
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
    aiEscalationCount === null ||
    aiEscalationCount > 0 ||
    paymentIssueCount > 0 ||
    automationPausedCount > 0;

  const critical = rollup.organizationsUnhealthy > 0 || rollup.criticalIncidents > 0 || paymentIssueCount > 0 || schedulerHeartbeat.stale;
  const attention = hasIssues || schedulerHeartbeat.unavailable;

  return (
    <AgencySection
      id="system-health"
      title="System health"
      action={
        critical ? (
          <StatusLabel tone="critical">Problems open</StatusLabel>
        ) : attention ? (
          <StatusLabel tone="attention">Needs a look</StatusLabel>
        ) : (
          <StatusLabel tone="healthy">Operating normally</StatusLabel>
        )
      }
    >
      <div className="border-t border-line px-4 pb-3 pt-1.5 sm:px-5">
        {/* Issue counts collapse to a single calm line when there is nothing
            to report, rather than nine rows that all read "0" - a real
            problem should stand out immediately, not compete with five other
            zeroes for the same visual weight. */}
        {hasIssues ? (
          <div className="divide-y divide-line">
            <Row label="Organizations degraded" value={formatCount(rollup.organizationsDegraded)} tone={rollup.organizationsDegraded > 0 ? "warning" : "default"} />
            <Row label="Organizations unhealthy" value={formatCount(rollup.organizationsUnhealthy)} tone={rollup.organizationsUnhealthy > 0 ? "danger" : "default"} />
            <Row label="Critical incidents" value={formatCount(rollup.criticalIncidents)} tone={rollup.criticalIncidents > 0 ? "danger" : "default"} />
            <Row label="Warning incidents" value={formatCount(rollup.warningIncidents)} tone={rollup.warningIncidents > 0 ? "warning" : "default"} />
            <Row label="SMS delivery failures" value={formatCount(smsFailureCount)} tone={smsFailureCount > 0 ? "warning" : "default"} />
            {aiEscalationCount === null ? (
              <Row label="AI escalations waiting" value="Unavailable" tone="warning" />
            ) : (
              <Row label="AI escalations waiting" value={formatCount(aiEscalationCount)} tone={aiEscalationCount > 0 ? "warning" : "default"} />
            )}
            <Row label="Payment suspended or cancelled" value={formatCount(paymentIssueCount)} tone={paymentIssueCount > 0 ? "danger" : "default"} />
            <Row label="Automation paused" value={formatCount(automationPausedCount)} tone={automationPausedCount > 0 ? "warning" : "default"} />
          </div>
        ) : (
          <p className="py-2 text-sm text-ink-3">
            All {formatCount(rollup.organizationsHealthy)} organization{rollup.organizationsHealthy === 1 ? "" : "s"} healthy. No incidents, delivery failures, payment issues, or AI escalations open.
          </p>
        )}

        <div className="mt-2 divide-y divide-line border-t border-line">
          <Row
            label="Scheduler last ran"
            value={heartbeatValue}
            tone={schedulerHeartbeat.unavailable ? "warning" : schedulerHeartbeat.stale ? "danger" : "default"}
            description={schedulerHeartbeat.unavailable ? "The scheduler heartbeat could not be read." : schedulerHeartbeat.stale ? "Stale - scheduled follow-ups may be delayed." : undefined}
          />
          <Row label="n8n" value="External" description="Not independently monitored" />
        </div>
      </div>
    </AgencySection>
  );
}

import type { SupabaseClient } from "@supabase/supabase-js";
import { isHealthCheckStale } from "./health";
import { getScheduledAutomationLiveness, type ScheduledAutomationLiveness } from "./scheduled-automation-liveness";
import { evaluateScheduledAutomationDegradedAlert, type ScheduledAutomationAlertResult } from "./scheduled-automation-alert";

/**
 * Phase 3D: the once-daily, independent check on the Supabase pg_cron
 * scheduler (app/api/automation/scheduler-watchdog, the only Vercel Cron
 * entry). It exists for the one failure the scheduler can't report itself:
 * if every pg_cron job stops, /api/automation/health stops too, and the
 * stale-automation alert it would raise never runs.
 *
 * Read-only apart from the existing alert path: it reads the global
 * heartbeat (automation_health_check_runs, stale after
 * HEALTH_CHECK_STALE_THRESHOLD_MS - "never ran" counts as stale) and every
 * scheduled route's liveness, then hands the combined fact to
 * evaluateScheduledAutomationDegradedAlert - the same incident + owner
 * notification path /health uses, deduplicated by fingerprint, so repeated
 * runs never notify twice and a recovered scheduler resolves it. It never
 * calls a business automation route, never runs opportunity sync and never
 * sends a customer-facing message.
 *
 * A failed heartbeat read is reported, not treated as an outage: no alert
 * is raised or resolved on a read error, so a transient database hiccup
 * can't notify owners that their automations stopped.
 */

export type SchedulerWatchdogResult = {
  heartbeatReadFailed: boolean;
  lastHeartbeatAt: string | null;
  heartbeatStale: boolean;
  staleAutomations: string[];
  degraded: boolean;
  alert: ScheduledAutomationAlertResult | null;
};

export type SchedulerWatchdogDeps = {
  getLiveness?: (supabase: SupabaseClient, now: Date) => Promise<ScheduledAutomationLiveness[]>;
  evaluateAlert?: (supabase: SupabaseClient, isCurrentlyStale: boolean) => Promise<ScheduledAutomationAlertResult>;
};

export async function runSchedulerWatchdog(service: SupabaseClient, now: Date = new Date(), deps: SchedulerWatchdogDeps = {}): Promise<SchedulerWatchdogResult> {
  const getLiveness = deps.getLiveness ?? getScheduledAutomationLiveness;
  const evaluateAlert = deps.evaluateAlert ?? evaluateScheduledAutomationDegradedAlert;

  const { data, error } = await service.from("automation_health_check_runs").select("checked_at").order("checked_at", { ascending: false }).limit(1).maybeSingle();
  if (error) {
    return { heartbeatReadFailed: true, lastHeartbeatAt: null, heartbeatStale: false, staleAutomations: [], degraded: false, alert: null };
  }

  const lastHeartbeatAt = (data as { checked_at: string } | null)?.checked_at ?? null;
  const heartbeatStale = isHealthCheckStale(lastHeartbeatAt, now.getTime());
  const staleAutomations = (await getLiveness(service, now)).filter((liveness) => liveness.state === "stale").map((liveness) => liveness.automationId);
  const degraded = heartbeatStale || staleAutomations.length > 0;
  const alert = await evaluateAlert(service, degraded);

  return { heartbeatReadFailed: false, lastHeartbeatAt, heartbeatStale, staleAutomations, degraded, alert };
}

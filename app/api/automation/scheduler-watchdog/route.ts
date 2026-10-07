import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { isAuthorizedCronRequest } from "@/lib/automation/cron-auth";
import { runSchedulerWatchdog } from "@/lib/automation-health/scheduler-watchdog";
import { reportSchedulerWatchdogOutcome } from "@/lib/automation-health/watchdog-alert";

/**
 * Phase 3D: the once-daily Vercel Cron watchdog (vercel.json's only cron
 * entry). Not a scheduler: it checks that the Supabase pg_cron jobs are
 * still running and raises the existing degraded-automation alert if not -
 * see lib/automation-health/scheduler-watchdog.ts. Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET`, which the shared fail-closed check
 * verifies.
 *
 * Final Batch 4: the watchdog can no longer fail silently. A degraded
 * scheduler, an unreadable heartbeat or the watchdog itself throwing is
 * reported to the Trackpr operator (structured ops alert, emailed to
 * OPS_ALERT_EMAIL when configured - once a day at most, by construction).
 */
export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  let result;
  try {
    result = await runSchedulerWatchdog(createServiceRoleClient());
  } catch (error) {
    await reportSchedulerWatchdogOutcome({ kind: "threw", errorType: error instanceof Error ? error.name : typeof error });
    return NextResponse.json({ ok: false, error: "Scheduler watchdog failed." }, { status: 500 });
  }
  await reportSchedulerWatchdogOutcome({ kind: "ran", result });

  return NextResponse.json({
    ok: !result.heartbeatReadFailed,
    degraded: result.degraded,
    heartbeatStale: result.heartbeatStale,
    lastHeartbeatAt: result.lastHeartbeatAt,
    staleAutomations: result.staleAutomations,
    notified: result.alert?.notified ?? 0,
    resolved: result.alert?.resolved ?? 0,
  });
}

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { isAuthorizedCronRequest } from "@/lib/automation/cron-auth";
import { runSchedulerWatchdog } from "@/lib/automation-health/scheduler-watchdog";

/**
 * Phase 3D: the once-daily Vercel Cron watchdog (vercel.json's only cron
 * entry). Not a scheduler: it checks that the Supabase pg_cron jobs are
 * still running and raises the existing degraded-automation alert if not -
 * see lib/automation-health/scheduler-watchdog.ts. Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET`, which the shared fail-closed check
 * verifies.
 */
export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const result = await runSchedulerWatchdog(createServiceRoleClient());
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

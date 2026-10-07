import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { runScheduledOpportunitySync } from "@/lib/opportunities/scheduled-sync";
import { isAuthorizedCronRequest } from "@/lib/automation/cron-auth";
import { recordScheduledAutomationRun } from "@/lib/automation-health/scheduled-automation-liveness";
import { withOpsFailureReporting } from "@/lib/ops/route-failure";

/**
 * Phase 3D: scheduled opportunity detection, invoked by the Supabase pg_cron
 * job trackpr_opportunity_sync (7,22,37,52 * * * *) through
 * public.invoke_trackpr_scheduled - same CRON_SECRET fail-closed pattern as
 * every other scheduled route (lib/automation/cron-auth.ts). Detection only:
 * it writes opportunities and never sends a message. Safe to overlap or
 * repeat - see lib/opportunities/scheduled-sync.ts.
 */
async function handle(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const service = createServiceRoleClient();
  const result = await runScheduledOpportunitySync(service);
  // Records that this route actually ran, independent of how many
  // organizations were eligible - see scheduled-automation-liveness.ts.
  await recordScheduledAutomationRun(service, "opportunity-sync", result.candidates);

  return NextResponse.json({
    ok: !result.scanFailed,
    candidates: result.candidates,
    synced: result.synced,
    throttled: result.throttled,
    failed: result.failed,
  });
}

// GET is what pg_net's net.http_get sends; POST remains available for
// manual/test invocation - the same authorized, idempotent logic.
async function handleGET(request: NextRequest) {
  return handle(request);
}

async function handlePOST(request: NextRequest) {
  return handle(request);
}

// Batch 4 (operations hardening): a 5xx or a throw leaves one structured operator line (lib/ops/route-failure.ts); the response is unchanged.
export const GET = withOpsFailureReporting("automation.cron.opportunity_sync", handleGET);
export const POST = withOpsFailureReporting("automation.cron.opportunity_sync", handlePOST);

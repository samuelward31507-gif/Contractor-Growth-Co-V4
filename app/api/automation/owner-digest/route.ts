import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { runOwnerDigest } from "@/lib/notifications/owner-digest";
import { isAuthorizedCronRequest } from "@/lib/automation/cron-auth";
import { recordScheduledAutomationRun } from "@/lib/automation-health/scheduled-automation-liveness";
import { withOpsFailureReporting } from "@/lib/ops/route-failure";

/**
 * Phase 3G-1: the weekly owner digest, invoked by the Supabase pg_cron job
 * trackpr_owner_digest (8,23,38,53 * * * *) through
 * public.invoke_trackpr_scheduled - the same CRON_SECRET fail-closed pattern
 * as every other scheduled route (lib/automation/cron-auth.ts). Each tick
 * only sends to organizations whose local time is Monday from 7:00 to noon,
 * once per organization per week - see lib/notifications/owner-digest.ts.
 * Owner-facing SMS only; never a customer message.
 */
async function handle(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const service = createServiceRoleClient();
  const result = await runOwnerDigest(service);
  // Records that this route actually ran, independent of how many
  // organizations were due - see scheduled-automation-liveness.ts.
  await recordScheduledAutomationRun(service, "owner-digest", result.candidates);

  // A failed scan or any failed delivery is not reported as success.
  return NextResponse.json({
    ok: !result.scanFailed && result.failed === 0,
    candidates: result.candidates,
    sent: result.sent,
    quiet: result.quiet,
    skipped: result.skipped,
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
export const GET = withOpsFailureReporting("automation.cron.owner_digest", handleGET);
export const POST = withOpsFailureReporting("automation.cron.owner_digest", handlePOST);

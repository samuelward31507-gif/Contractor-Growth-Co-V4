import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { processCustomerReactivation } from "@/lib/automation/customer-reactivation";
import { isAuthorizedCronRequest } from "@/lib/automation/cron-auth";
import { recordScheduledAutomationRun } from "@/lib/automation-health/scheduled-automation-liveness";
import { withOpsFailureReporting } from "@/lib/ops/route-failure";

/**
 * Scheduled-automation target invoked by an n8n Schedule Trigger - same
 * CRON_SECRET fail-closed pattern as every other automation cron route, see
 * lib/automation/cron-auth.ts. No public access: an unset CRON_SECRET means
 * every request is rejected, never accepted.
 */
async function handle(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const service = createServiceRoleClient();
  const result = await processCustomerReactivation(service);
  // Pass 5A: records that this route actually ran, independent of candidate
  // count - see scheduled-automation-liveness.ts's own header comment.
  await recordScheduledAutomationRun(service, "customer-reactivation", result.candidates);

  return NextResponse.json({ ok: true, candidates: result.candidates, outcomes: result.outcomes });
}

// Both GET and POST point at the exact same authorized, idempotent logic -
// GET is what the n8n Schedule Trigger's HTTP Request node uses; POST
// remains available for manual/test invocation.
async function handleGET(request: NextRequest) {
  return handle(request);
}

async function handlePOST(request: NextRequest) {
  return handle(request);
}

// Batch 4 (operations hardening): a 5xx or a throw leaves one structured operator line (lib/ops/route-failure.ts); the response is unchanged.
export const GET = withOpsFailureReporting("automation.cron.customer_reactivation", handleGET);
export const POST = withOpsFailureReporting("automation.cron.customer_reactivation", handlePOST);

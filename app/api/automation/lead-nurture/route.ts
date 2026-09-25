import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { processLeadNurture } from "@/lib/automation/lead-nurture";
import { isAuthorizedCronRequest } from "@/lib/automation/cron-auth";
import { recordScheduledAutomationRun } from "@/lib/automation-health/scheduled-automation-liveness";

/**
 * Scheduled-automation target invoked by an n8n Schedule Trigger - same
 * CRON_SECRET fail-closed pattern as every other automation cron route,
 * see lib/automation/cron-auth.ts. No public access: an unset CRON_SECRET
 * means every request is rejected, never accepted.
 */
async function handle(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const service = createServiceRoleClient();
  const result = await processLeadNurture(service);
  // Pass 5A: records that this route actually ran, independent of candidate
  // count - see scheduled-automation-liveness.ts's own header comment. Uses
  // the "lost-lead-nurture" catalog id (this route's own automation name).
  await recordScheduledAutomationRun(service, "lost-lead-nurture", result.candidates);

  return NextResponse.json({ ok: true, candidates: result.candidates, outcomes: result.outcomes });
}

// Both GET and POST point at the exact same authorized, idempotent logic -
// GET is what the n8n Schedule Trigger's HTTP Request node uses; POST
// remains available for manual/test invocation.
export async function POST(request: NextRequest) {
  return handle(request);
}

export async function GET(request: NextRequest) {
  return handle(request);
}

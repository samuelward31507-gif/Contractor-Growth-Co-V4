import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { processNoShowDetection } from "@/lib/automation/no-show-detection";
import { isAuthorizedCronRequest } from "@/lib/automation/cron-auth";
import { recordScheduledAutomationRun } from "@/lib/automation-health/scheduled-automation-liveness";

/**
 * Pass 5B: scheduled-automation target invoked by an n8n Schedule Trigger -
 * same CRON_SECRET fail-closed pattern as every other automation cron
 * route, see lib/automation/cron-auth.ts. Does not modify n8n itself: this
 * is a new Trackpr-side HTTP endpoint of the exact same kind the 5 existing
 * scheduled routes already are, awaiting the same kind of external Schedule
 * Trigger wiring those already required - an operational/deployment step
 * outside this repository's control, not a change to any n8n workflow.
 */
async function handle(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const service = createServiceRoleClient();
  const result = await processNoShowDetection(service);
  // Pass 5A: records that this route actually ran, independent of candidate
  // count - see scheduled-automation-liveness.ts's own header comment.
  await recordScheduledAutomationRun(service, "no-show-detection", result.candidates);

  return NextResponse.json({ ok: true, candidates: result.candidates, outcomes: result.outcomes });
}

// Both GET and POST point at the exact same authorized, idempotent logic -
// GET is what the n8n Schedule Trigger's HTTP Request node uses; POST
// remains available for manual/test invocation.
export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { processEstimateFollowups } from "@/lib/automation/estimate-followups";
import { isAuthorizedCronRequest } from "@/lib/automation/cron-auth";

/**
 * Scheduled-automation target invoked by an n8n Schedule Trigger - same
 * CRON_SECRET fail-closed pattern as every other automation cron route,
 * see lib/automation/cron-auth.ts.
 */
export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const service = createServiceRoleClient();
  const result = await processEstimateFollowups(service);

  return NextResponse.json({ ok: true, candidates: result.candidates, outcomes: result.outcomes });
}

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { processEstimateFollowups } from "@/lib/automation/estimate-followups";

/**
 * Vercel Cron target (see vercel.json) - same CRON_SECRET fail-closed
 * pattern as app/api/automation/appointment-reminders/route.ts.
 */
function isAuthorized(request: NextRequest): boolean {
  const configuredSecret = process.env.CRON_SECRET;
  if (!configuredSecret) return false;

  const authHeader = request.headers.get("authorization");
  return authHeader === `Bearer ${configuredSecret}`;
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const service = createServiceRoleClient();
  const result = await processEstimateFollowups(service);

  return NextResponse.json({ ok: true, candidates: result.candidates, outcomes: result.outcomes });
}

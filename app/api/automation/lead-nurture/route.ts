import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { processLeadNurture } from "@/lib/automation/lead-nurture";

/**
 * Vercel Cron target (see vercel.json) - same CRON_SECRET fail-closed
 * pattern as app/api/automation/appointment-reminders/route.ts and
 * app/api/automation/estimate-followups/route.ts. No public access: an
 * unset CRON_SECRET means every request is rejected, never accepted.
 */
function isAuthorized(request: NextRequest): boolean {
  const configuredSecret = process.env.CRON_SECRET;
  if (!configuredSecret) return false;

  const authHeader = request.headers.get("authorization");
  return authHeader === `Bearer ${configuredSecret}`;
}

async function handle(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const service = createServiceRoleClient();
  const result = await processLeadNurture(service);

  return NextResponse.json({ ok: true, candidates: result.candidates, outcomes: result.outcomes });
}

// Exported as POST per this phase's explicit requirement. Also exported as
// GET because Vercel's Cron scheduler always invokes the configured path
// with a GET request - a POST-only handler would return 405 to Vercel's
// own trigger and the schedule would never actually fire. Both point at
// the exact same authorized, idempotent logic.
export async function POST(request: NextRequest) {
  return handle(request);
}

export async function GET(request: NextRequest) {
  return handle(request);
}

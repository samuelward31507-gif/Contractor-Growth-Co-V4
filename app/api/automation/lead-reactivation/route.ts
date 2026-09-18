import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { processLeadReactivation } from "@/lib/automation/lead-reactivation";

/**
 * Vercel Cron target (see vercel.json) - same CRON_SECRET fail-closed
 * pattern as every other automation cron route. No public access: an unset
 * CRON_SECRET means every request is rejected, never accepted.
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
  const result = await processLeadReactivation(service);

  return NextResponse.json({ ok: true, candidates: result.candidates, outcomes: result.outcomes });
}

// Vercel Cron always invokes the configured path with GET - exported as the
// primary handler for that reason. Also exported as POST for manual/test
// invocation, following the same established pattern as
// app/api/automation/lead-nurture/route.ts.
export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}

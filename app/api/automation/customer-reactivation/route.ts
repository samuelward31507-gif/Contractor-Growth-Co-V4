import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { processCustomerReactivation } from "@/lib/automation/customer-reactivation";
import { isAuthorizedCronRequest } from "@/lib/automation/cron-auth";

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

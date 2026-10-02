import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { processInvoiceReminders } from "@/lib/automation/invoice-reminders";
import { isAuthorizedCronRequest } from "@/lib/automation/cron-auth";
import { recordScheduledAutomationRun } from "@/lib/automation-health/scheduled-automation-liveness";

/**
 * Phase 3G-2b: automated invoice reminders, invoked by the Supabase pg_cron
 * job trackpr_invoice_reminders (9,24,39,54 * * * *) through
 * public.invoke_trackpr_scheduled - the same CRON_SECRET fail-closed pattern
 * as every other scheduled route (lib/automation/cron-auth.ts). Off by
 * default: only organizations that turned Invoice Reminders on are
 * considered - see lib/automation/invoice-reminders.ts.
 */
async function handle(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const service = createServiceRoleClient();
  const result = await processInvoiceReminders(service);
  // Records that this route actually ran, independent of how many invoices
  // were candidates - see scheduled-automation-liveness.ts.
  await recordScheduledAutomationRun(service, "invoice-reminders", result.candidates);

  // A failed scan or any failed stage is not reported as success.
  return NextResponse.json({ ok: !result.scanFailed && result.failed === 0, candidates: result.candidates, sent: result.sent, failed: result.failed });
}

// GET is what pg_net's net.http_get sends; POST remains available for
// manual/test invocation - the same authorized, idempotent logic.
export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}

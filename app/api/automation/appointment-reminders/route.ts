import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { processAppointmentReminders } from "@/lib/automation/appointment-reminders";
import { isAuthorizedCronRequest } from "@/lib/automation/cron-auth";
import { recordScheduledAutomationRun } from "@/lib/automation-health/scheduled-automation-liveness";

/**
 * Scheduled-automation target invoked by an n8n Schedule Trigger (see
 * lib/automation/cron-auth.ts) - no user session, and n8n's Schedule
 * Trigger here is acting purely as an external clock calling an
 * authenticated Trackpr endpoint, not dispatching through the AI-drafting
 * webhook architecture the rest of n8n's involvement uses.
 */
export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const service = createServiceRoleClient();
  const result = await processAppointmentReminders(service);
  // Pass 5A: records that this route actually ran, independent of candidate
  // count - see scheduled-automation-liveness.ts's own header comment.
  await recordScheduledAutomationRun(service, "appointment-reminders", result.candidates);

  return NextResponse.json({ ok: true, candidates: result.candidates, outcomes: result.outcomes });
}

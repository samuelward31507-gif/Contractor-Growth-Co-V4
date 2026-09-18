import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { processAppointmentReminders } from "@/lib/automation/appointment-reminders";

/**
 * Vercel Cron target (see vercel.json) - no user session, no n8n involved.
 * Vercel sends `Authorization: Bearer <CRON_SECRET>` on scheduled
 * invocations when CRON_SECRET is set in the project's environment
 * variables; this fails closed exactly like the n8n callback route's own
 * webhook-secret check when it's unset, rather than ever accepting an
 * unauthenticated trigger. Constant-time comparison, matching the same
 * pattern already used by the n8n callback route and the Twilio inbound
 * webhook's signature check.
 */
function isAuthorized(request: NextRequest): boolean {
  const configuredSecret = process.env.CRON_SECRET;
  if (!configuredSecret) return false;

  const authHeader = request.headers.get("authorization");
  if (!authHeader) return false;

  const expected = Buffer.from(`Bearer ${configuredSecret}`);
  const actual = Buffer.from(authHeader);
  if (expected.length !== actual.length) return false;

  return timingSafeEqual(expected, actual);
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const service = createServiceRoleClient();
  const result = await processAppointmentReminders(service);

  return NextResponse.json({ ok: true, candidates: result.candidates, outcomes: result.outcomes });
}

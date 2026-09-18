import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getAgencyBusinessMetrics } from "@/lib/agency/queries";
import { getAgencyHealth } from "@/lib/agency/health";

/**
 * Server entry point for the future Agency Command Center. Session-based,
 * like every other page/action in this app - not a shared-secret route like
 * the cron/n8n-callback/Twilio endpoints, since the caller here is a real
 * logged-in person, not an automated system. The session client is used
 * only to establish "who is calling and are they an agency admin"
 * (lib/agency/queries.ts's resolveAgencyOrganizations, itself gated by the
 * is_agency_admin() RLS function); the service-role client is created here
 * and passed in only after that authorization step, mirroring the same
 * "authenticate first, service-role second" shape already used by
 * app/api/automation/n8n-callback/route.ts. The service-role key itself
 * never leaves this server-only module.
 *
 * No UI reads this yet - this is the backend foundation only.
 */
export async function GET() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const service = createServiceRoleClient();

  const [metrics, health] = await Promise.all([
    getAgencyBusinessMetrics(supabase, service),
    getAgencyHealth(supabase, service),
  ]);

  // Both calls independently re-verify agency-admin status; they will agree
  // on authorization outcome since both resolve it from the same session.
  // Checking one is sufficient to decide the response shape.
  if (!metrics.ok) {
    const status = metrics.reason === "unauthenticated" ? 401 : 403;
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status });
  }
  if (!health.ok) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 403 });
  }

  return NextResponse.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    organizations: metrics.organizations.map((org) => ({
      organizationId: org.organizationId,
      organizationName: org.organizationName,
      metrics: org.metrics,
    })),
    summary: metrics.summary,
    dataQuality: metrics.dataQuality,
    health: {
      stuckThresholdMinutes: health.stuckThresholdMinutes,
      stuck: health.stuck,
      organizations: health.organizations,
    },
  });
}

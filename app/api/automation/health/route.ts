import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";

/**
 * Read-only operational check for workflow_executions rows stuck in
 * status='running' - the dispatch model assumes every started execution is
 * eventually completed or failed by the n8n callback route, so a row still
 * 'running' past a generous threshold means that callback never arrived
 * (n8n misconfiguration, a dead callback URL, a stuck n8n workflow, etc.),
 * not a normal in-flight state. Same CRON_SECRET bearer pattern as the
 * other automation routes; not wired into vercel.json's cron schedule here
 * - that's a separate decision for whoever operates this.
 *
 * Deliberately returns only id/organization_id/workflow_name/attempt/
 * started_at - never error_message or metadata, since those may echo
 * upstream provider error text this route has no way to guarantee is free
 * of sensitive detail.
 */
const STUCK_THRESHOLD_MINUTES = 30;
const MAX_ROWS = 100;

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
  const thresholdIso = new Date(Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000).toISOString();

  const { data, error } = await service
    .from("workflow_executions")
    .select("id, organization_id, workflow_name, attempt, started_at")
    .eq("status", "running")
    .lt("started_at", thresholdIso)
    .order("started_at", { ascending: true })
    .limit(MAX_ROWS);

  if (error) {
    return NextResponse.json({ ok: false, error: "Could not query workflow executions." }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    thresholdMinutes: STUCK_THRESHOLD_MINUTES,
    stuckCount: data.length,
    stuck: data,
  });
}

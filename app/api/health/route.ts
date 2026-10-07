import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { evaluateLiveness } from "@/lib/ops/liveness";

/**
 * Final Batch 4: public liveness for an external uptime monitor - the
 * dead-man's switch that works even when every scheduler (Supabase pg_cron
 * and the daily Vercel Cron watchdog) has stopped. Read-only: one SELECT of
 * the latest health-check heartbeat. It never runs automation work and
 * returns no organization, customer or configuration data - only booleans
 * and the heartbeat time. 200 = app, database and scheduler all OK;
 * 503 = something is wrong (see `checks`).
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const result = await evaluateLiveness(async () => {
    const { data, error } = await createServiceRoleClient()
      .from("automation_health_check_runs")
      .select("checked_at")
      .order("checked_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error("heartbeat_read_failed");
    return (data as { checked_at: string } | null)?.checked_at ?? null;
  });
  return NextResponse.json(result.body, { status: result.status, headers: { "cache-control": "no-store" } });
}

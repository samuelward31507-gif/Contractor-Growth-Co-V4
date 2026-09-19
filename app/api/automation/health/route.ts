import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { recordAutomationHealthSignal } from "@/lib/automation-health/service";
import { getAutomationForWorkflowName } from "@/lib/automation/catalog";

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
 *
 * Automation Health + Alerting V1: this is also the one place
 * workflow_stuck incidents are detected (per stuck row found) and stale
 * ones auto-resolved (via resolve_stale_stuck_incidents, once execution has
 * since left 'running') - see lib/automation-health/service.ts. This
 * endpoint was already the sole existing stuck-execution scan (both here and
 * in lib/agency/health.ts, which reads the same rows for display only, never
 * writes an incident) - extending it in place, rather than adding a second
 * scan, keeps exactly one query doing the actual detection work. Each
 * invocation is also logged to automation_health_check_runs (a global
 * heartbeat, not per-organization - see that table's own migration comment)
 * so "is Trackpr's own health-check job even running" is answerable.
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

/** Failed-execution window for this endpoint's headline count - bounded, matching STUCK_THRESHOLD_MINUTES's own "recent, actionable window" spirit rather than an unbounded all-time count. */
const FAILED_EXECUTION_WINDOW_HOURS = 24;

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const service = createServiceRoleClient();
  const thresholdIso = new Date(Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000).toISOString();
  const failedSinceIso = new Date(Date.now() - FAILED_EXECUTION_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

  const { data: stuck, error } = await service
    .from("workflow_executions")
    .select("id, organization_id, workflow_name, attempt, started_at")
    .eq("status", "running")
    .lt("started_at", thresholdIso)
    .order("started_at", { ascending: true })
    .limit(MAX_ROWS);

  if (error) {
    return NextResponse.json({ ok: false, error: "Could not query workflow executions." }, { status: 500 });
  }

  // One incident signal per stuck row - collapses correctly across repeated
  // ticks (fingerprint context is the execution id), never floods.
  let incidentsOpened = 0;
  for (const row of stuck) {
    const automation = getAutomationForWorkflowName(row.workflow_name);
    const incident = await recordAutomationHealthSignal(service, {
      organizationId: row.organization_id,
      category: "workflow_stuck",
      severity: "warning",
      fingerprintContext: row.id,
      title: `${automation?.name ?? row.workflow_name} execution stuck`,
      description: `Running for over ${STUCK_THRESHOLD_MINUTES} minutes with no callback.`,
      automationId: automation?.id ?? null,
      workflowExecutionId: row.id,
    });
    if (incident && incident.occurrenceCount === 1) incidentsOpened += 1;
  }

  const { data: resolvedCount } = await service.rpc("resolve_stale_stuck_incidents");
  const incidentsResolved = typeof resolvedCount === "number" ? resolvedCount : 0;

  const [{ count: failedExecutionCount }, { count: criticalIncidentCount }, { count: warningIncidentCount }] = await Promise.all([
    service.from("workflow_executions").select("id", { count: "exact", head: true }).eq("status", "failed").gte("started_at", failedSinceIso),
    service.from("automation_incidents").select("id", { count: "exact", head: true }).eq("severity", "critical").in("status", ["open", "acknowledged"]),
    service.from("automation_incidents").select("id", { count: "exact", head: true }).eq("severity", "warning").in("status", ["open", "acknowledged"]),
  ]);

  await service.from("automation_health_check_runs").insert({
    stuck_count: stuck.length,
    incidents_opened: incidentsOpened,
    incidents_resolved: incidentsResolved,
  });

  const overall = (criticalIncidentCount ?? 0) > 0 ? "unhealthy" : (warningIncidentCount ?? 0) > 0 || stuck.length > 0 ? "degraded" : "healthy";

  return NextResponse.json({
    ok: true,
    status: overall,
    timestamp: new Date().toISOString(),
    thresholdMinutes: STUCK_THRESHOLD_MINUTES,
    stuckCount: stuck.length,
    stuck,
    failedExecutionCount: failedExecutionCount ?? 0,
    failedExecutionWindowHours: FAILED_EXECUTION_WINDOW_HOURS,
    activeCriticalIncidents: criticalIncidentCount ?? 0,
    activeWarningIncidents: warningIncidentCount ?? 0,
    incidentsOpened,
    incidentsResolved,
    // Configuration-derived only, never a live probe - see this route's own
    // header comment on why n8n/Twilio are never pinged from here. A real
    // outage of either is what the dispatch/send-failure incident detectors
    // (lib/automation/executions.ts) already surface, not a synthetic ping.
    providerStatus: process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER ? "configured" : "not_configured",
    n8nStatus: process.env.N8N_BASE_URL && process.env.N8N_WEBHOOK_SECRET ? "configured" : "not_configured",
    database: "available",
  });
}

/**
 * Batch 4 (production operations hardening): the health tick's truthful
 * verdict, the public liveness automation check, and the structured
 * operator signal every automation route now leaves when it fails.
 *
 * Offline and deterministic - no network, no database, no credentials.
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation-health/batch4-ops.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assessHealthTick, type TickAssessmentInput } from "@/lib/automation-health/tick-assessment";
import { evaluateLiveness } from "@/lib/ops/liveness";
import { withOpsFailureReporting } from "@/lib/ops/route-failure";
import { reportOpsAlert, type OpsAlert } from "@/lib/ops/alert";
import { HEALTH_CHECK_STALE_THRESHOLD_MS } from "@/lib/automation-health/health";

const read = (file: string) => readFileSync(file, "utf8");

const clean = (over: Partial<TickAssessmentInput> = {}): TickAssessmentInput => ({
  phaseFailures: [],
  phaseErrorCounts: { execution_timeout: 0, retry_classification: 0, retry_processing: 0 },
  counts: { failedExecutions: 0, criticalIncidents: 0, warningIncidents: 0 },
  stuckCount: 0,
  staleScheduledAutomationCount: 0,
  heartbeatRecorded: true,
  retryDecisions: [],
  ...over,
});

// ---------------------------------------------------------------------------
// Health tick verdict
// ---------------------------------------------------------------------------

test("a clean, complete tick is healthy and raises nothing", () => {
  const verdict = assessHealthTick(clean());
  assert.deepEqual([verdict.ok, verdict.status, verdict.phaseErrors, verdict.countsUnavailable, verdict.alerts.length], [true, "healthy", [], [], 0]);
});

test("observed problems keep their existing meaning: a critical incident is unhealthy; warnings, stuck executions or stale scheduled automations are degraded", () => {
  assert.equal(assessHealthTick(clean({ counts: { failedExecutions: 0, criticalIncidents: 1, warningIncidents: 0 } })).status, "unhealthy");
  assert.equal(assessHealthTick(clean({ counts: { failedExecutions: 0, criticalIncidents: 0, warningIncidents: 2 } })).status, "degraded");
  assert.equal(assessHealthTick(clean({ stuckCount: 1 })).status, "degraded");
  assert.equal(assessHealthTick(clean({ staleScheduledAutomationCount: 1 })).status, "degraded");
});

test("no false success: an unreadable count is unknown, never 0 - the tick is degraded, not healthy, and says which counts it could not read", () => {
  const verdict = assessHealthTick(clean({ counts: { failedExecutions: null, criticalIncidents: 0, warningIncidents: null } }));
  assert.equal(verdict.status, "degraded");
  assert.deepEqual(verdict.countsUnavailable, ["failedExecutions", "warningIncidents"]);
  assert.deepEqual(verdict.alerts.map((alert) => [alert.code, alert.severity, alert.notify ?? false]), [["health_tick_counts_unavailable", "warning", false]]);
  assert.equal(verdict.ok, true, "the tick itself completed - the heartbeat rule is unchanged");
  // A critical incident still wins even when another count is unknown.
  assert.equal(assessHealthTick(clean({ counts: { failedExecutions: null, criticalIncidents: 3, warningIncidents: 0 } })).status, "unhealthy");
});

test("no false success: a phase that swallowed its own error (the retry classifier could not read failed executions) makes the tick degraded and leaves an operator line", () => {
  const verdict = assessHealthTick(clean({ phaseErrorCounts: { execution_timeout: 0, retry_classification: 1, retry_processing: 2 } }));
  assert.equal(verdict.status, "degraded");
  assert.deepEqual(verdict.phaseErrors, ["retry_classification", "retry_processing"]);
  assert.deepEqual(verdict.alerts[0].context, { phases: "retry_classification,retry_processing", errorCount: 3 });
  assert.equal(verdict.alerts[0].code, "health_tick_phase_errors");
});

test("an incomplete tick (a phase threw, or the heartbeat could not be written) is never ok and never healthy", () => {
  assert.deepEqual([assessHealthTick(clean({ phaseFailures: ["followup_dispatch"] })).ok, assessHealthTick(clean({ phaseFailures: ["followup_dispatch"] })).status], [false, "degraded"]);
  assert.deepEqual([assessHealthTick(clean({ heartbeatRecorded: false })).ok, assessHealthTick(clean({ heartbeatRecorded: false })).status], [false, "degraded"]);
});

test("retry exhaustion is visible to the operator: one structured line per tick with counts and execution ids (UUIDs only, at most five)", () => {
  const ids = Array.from({ length: 7 }, (_, i) => `0000000${i}-0000-4000-8000-000000000000`);
  const verdict = assessHealthTick(clean({ retryDecisions: [...ids.slice(0, 6).map((id) => ({ id, retryState: "exhausted" })), { id: ids[6], retryState: "not_retryable" }, { id: "x", retryState: "scheduled" }, { id: "y", retryState: "retried" }] }));
  assert.deepEqual(verdict.stoppedRetrying, { exhausted: 6, notRetryable: 1 });
  const alert = verdict.alerts.find((a) => a.code === "executions_stopped_retrying")!;
  assert.equal(alert.severity, "warning");
  assert.equal(alert.notify ?? false, false, "log-only - the 15-minute tick never emails");
  assert.deepEqual([alert.context!.exhausted, alert.context!.notRetryable], [6, 1]);
  assert.equal(String(alert.context!.executionIds).split(",").length, 5);
  assert.equal(verdict.status, "healthy", "a stopped retry is surfaced, not a runtime failure - the organization's Today shows it as needing a person");
  // Scheduled / retried decisions alone say nothing.
  assert.equal(assessHealthTick(clean({ retryDecisions: [{ id: "x", retryState: "scheduled" }] })).alerts.length, 0);
});

test("the health route reports through assessHealthTick - unread counts are null, never 0 - and keeps the heartbeat-only-for-a-complete-tick rule", () => {
  const route = read("app/api/automation/health/route.ts");
  assert.match(route, /const assessment = assessHealthTick\(\{/);
  assert.match(route, /phaseErrorCounts: \{ execution_timeout: timeout\.errors, retry_classification: retryDecisions\.errors, retry_processing: retries\.errors \}/);
  assert.match(route, /failedExecutions: failedCountError \? null : \(failedExecutionCount \?\? 0\)/);
  assert.match(route, /for \(const alert of assessment\.alerts\) await reportOpsAlert\(alert\);/);
  assert.match(route, /status: assessment\.status,/);
  assert.doesNotMatch(route, /activeCriticalIncidents: criticalIncidentCount \?\? 0,/, "no unread count reported as 0");
  assert.match(route, /if \(phaseFailures\.length === 0\) \{\n\s+const \{ error: heartbeatError \} = await service\.from\("automation_health_check_runs"\)\.insert/);
  assert.match(route, /\{ status: tickOk \? 200 : 500 \}/);
});

// ---------------------------------------------------------------------------
// Public liveness
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-10-10T15:00:00.000Z");
const fresh = new Date(NOW - 10 * 60_000).toISOString();

test("liveness: the automation check reports what the last fresh tick saw, separately from the 200/503 liveness verdict", async () => {
  const healthy = await evaluateLiveness(async () => ({ checkedAt: fresh, stuckCount: 0 }), NOW);
  assert.deepEqual([healthy.status, healthy.body.ok, healthy.body.automationOk, healthy.body.checks], [200, true, true, { app: "ok", database: "ok", scheduler: "ok", automation: "ok" }]);

  const stuck = await evaluateLiveness(async () => ({ checkedAt: fresh, stuckCount: 3 }), NOW);
  assert.deepEqual([stuck.status, stuck.body.ok, stuck.body.automationOk, stuck.body.checks.automation], [200, true, false, "degraded"], "a 200 never implies the automation runtime is fine");

  const stale = await evaluateLiveness(async () => ({ checkedAt: new Date(NOW - HEALTH_CHECK_STALE_THRESHOLD_MS - 1).toISOString(), stuckCount: 0 }), NOW);
  assert.deepEqual([stale.status, stale.body.automationOk, stale.body.checks.automation], [503, false, "unknown"], "an old tick can't vouch for now");

  const down = await evaluateLiveness(async () => { throw new Error("db down"); }, NOW);
  assert.deepEqual([down.status, down.body.automationOk, down.body.checks], [503, false, { app: "ok", database: "unavailable", scheduler: "unknown", automation: "unknown" }]);

  const unrecorded = await evaluateLiveness(async () => ({ checkedAt: fresh, stuckCount: null }), NOW);
  assert.deepEqual([unrecorded.status, unrecorded.body.checks.automation], [200, "unknown"]);

  const legacy = await evaluateLiveness(async () => fresh, NOW);
  assert.deepEqual([legacy.status, legacy.body.checks.scheduler, legacy.body.checks.automation], [200, "ok", "unknown"]);
});

test("liveness route: still one read of the latest heartbeat row (now with its stuck count), no writes, no automation work, no organization data", () => {
  const route = read("app/api/health/route.ts");
  assert.match(route, /\.from\("automation_health_check_runs"\)\s*\n\s*\.select\("checked_at, stuck_count"\)/);
  assert.match(route, /"cache-control": "no-store"/);
  assert.doesNotMatch(route, /dispatch|processDueRetries|failTimedOut|insert\(|update\(|organization_id/);
});

// ---------------------------------------------------------------------------
// Route failure reporting
// ---------------------------------------------------------------------------

function capture() {
  const alerts: OpsAlert[] = [];
  return { alerts, report: (async (alert: OpsAlert) => (alerts.push(alert), { logged: true, emailed: false })) as typeof reportOpsAlert };
}

const request = (url = "https://app.example.com/api/automation/n8n-callback?token=SECRET-QUERY-VALUE") =>
  new Request(url, { method: "POST", headers: { authorization: "Bearer SECRET-AUTH-VALUE", "x-vercel-id": "iad1::abc123" }, body: JSON.stringify({ phone: "+15125550101", body: "customer text" }) });

test("route wrapper: a successful or client-error response passes through untouched and reports nothing", async () => {
  const { alerts, report } = capture();
  const ok = new Response("{}", { status: 200 });
  const bad = new Response("{}", { status: 400 });
  assert.equal(await withOpsFailureReporting("t", async () => ok, { report })(request()), ok);
  assert.equal(await withOpsFailureReporting("t", async () => bad, { report })(request()), bad);
  assert.equal(alerts.length, 0);
});

test("route wrapper: a 5xx is reported once (method, path, status, request id) and the SAME response is returned - the callback contract is unchanged", async () => {
  const { alerts, report } = capture();
  const failed = new Response(JSON.stringify({ ok: false, error: "Could not record the automation result." }), { status: 500 });
  assert.equal(await withOpsFailureReporting("automation.n8n_callback", async () => failed, { report })(request()), failed);
  assert.equal(alerts.length, 1);
  assert.deepEqual([alerts[0].source, alerts[0].code, alerts[0].severity, alerts[0].notify ?? false], ["automation.n8n_callback", "route_server_error", "warning", false]);
  assert.deepEqual(alerts[0].context, { method: "POST", path: "/api/automation/n8n-callback", requestId: "iad1::abc123", status: 500 });
});

test("route wrapper: a throw is reported (error type only) and rethrown unchanged", async () => {
  const { alerts, report } = capture();
  const boom = new TypeError("database said: secret detail");
  await assert.rejects(withOpsFailureReporting("automation.cron.lead_nurture", async () => { throw boom; }, { report })(request()), (error) => error === boom);
  assert.equal(alerts.length, 1);
  assert.deepEqual([alerts[0].code, alerts[0].severity, alerts[0].context!.errorType], ["route_threw", "critical", "TypeError"]);
  assert.doesNotMatch(JSON.stringify(alerts[0]), /secret detail/);
});

test("no secret or customer data leaks into the operator line: query string, auth header, body and error message never appear", async () => {
  const lines: string[] = [];
  const report = ((alert: OpsAlert) => reportOpsAlert(alert, { log: (line) => lines.push(line), env: {} })) as typeof reportOpsAlert;
  await withOpsFailureReporting("automation.n8n_callback", async () => new Response("{}", { status: 503 }), { report })(request());
  await assert.rejects(withOpsFailureReporting("automation.n8n_callback", async () => { throw new Error("token=SECRET-ERROR-VALUE"); }, { report })(request()));
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const parsed = JSON.parse(line);
    assert.equal(parsed.trackpr_ops_alert, true);
    assert.doesNotMatch(line, /SECRET-|Bearer|\+1512|customer text|token=/);
  }
});

test("every automation route that runs on a schedule or answers n8n is wrapped, and the routes that already alert are left as they were", () => {
  const routes: Record<string, string> = {
    "n8n-callback": "automation.n8n_callback",
    "appointment-reminders": "automation.cron.appointment_reminders",
    "customer-reactivation": "automation.cron.customer_reactivation",
    "estimate-followups": "automation.cron.estimate_followups",
    "invoice-reminders": "automation.cron.invoice_reminders",
    "lead-nurture": "automation.cron.lead_nurture",
    "lead-reactivation": "automation.cron.lead_reactivation",
    "no-show-detection": "automation.cron.no_show_detection",
    "opportunity-sync": "automation.cron.opportunity_sync",
    "owner-digest": "automation.cron.owner_digest",
  };
  for (const [route, source] of Object.entries(routes)) {
    const sourceText = read(`app/api/automation/${route}/route.ts`);
    assert.doesNotMatch(sourceText, /^export async function (GET|POST)\(/m, `${route}: no unwrapped handler is exported`);
    assert.doesNotMatch(sourceText, /^export const (GET|POST) = (?!withOpsFailureReporting\()/m, `${route}: every exported method is the wrapper`);
    const handlers = [...sourceText.matchAll(/^async function handle(GET|POST)\(request: NextRequest\)/gm)].map((m) => m[1]).sort();
    const exported = [...sourceText.matchAll(/^export const (GET|POST) = withOpsFailureReporting\(/gm)].map((m) => m[1]).sort();
    assert.deepEqual(exported, handlers, `${route}: each handler is exported only through the wrapper`);
    const wrapped = [...sourceText.matchAll(/^export const (GET|POST) = withOpsFailureReporting\("([^"]+)", handle(GET|POST)\);$/gm)];
    assert.ok(wrapped.length > 0, `${route} is wrapped`);
    for (const match of wrapped) {
      assert.equal(match[2], source, route);
      assert.equal(match[1], match[3], `${route}: ${match[1]} wraps its own handler`);
    }
  }
  // These two already raise their own structured alerts (Final Batch 4) - unchanged.
  assert.match(read("app/api/automation/health/route.ts"), /^export async function GET\(request: NextRequest\)/m);
  assert.match(read("app/api/automation/scheduler-watchdog/route.ts"), /^export async function GET\(request: NextRequest\)/m);
});

// ---------------------------------------------------------------------------
// Safety architecture untouched
// ---------------------------------------------------------------------------

test("the outbound kill switch is intact: every gated send re-checks automation_paused live and fails closed on a read error", () => {
  const gate = read("lib/automation/outbound-gate.ts");
  assert.match(gate, /supabase\.from\("organizations"\)\.select\("automation_paused"\)\.eq\("id", input\.organizationId\)\.maybeSingle\(\)/);
  assert.match(gate, /if \(pauseError \|\| pauseRow\?\.automation_paused\) return deny\("organization_automation_paused"\);/);
});

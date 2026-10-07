/**
 * Final Batch 4: health tick phase isolation, watchdog alerting and the
 * public liveness decision.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation-health/batch4-health.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runTickPhase } from "./tick-phase";
import { reportSchedulerWatchdogOutcome } from "./watchdog-alert";
import { evaluateLiveness } from "@/lib/ops/liveness";
import { HEALTH_CHECK_STALE_THRESHOLD_MS } from "./health";
import type { OpsAlert } from "@/lib/ops/alert";

const capture = () => {
  const alerts: OpsAlert[] = [];
  const report = async (alert: OpsAlert) => {
    alerts.push(alert);
    return { logged: true as const, emailed: false };
  };
  return { alerts, report };
};

test("runTickPhase: success passes the value through and reports nothing", async () => {
  const { alerts, report } = capture();
  assert.deepEqual(await runTickPhase("retry_processing", async () => ({ started: 2 }), report), { ok: true, value: { started: 2 } });
  assert.equal(alerts.length, 0);
});

test("runTickPhase: a throwing phase is contained and reported (phase + error type only, never the message)", async () => {
  const { alerts, report } = capture();
  const result = await runTickPhase("followup_dispatch", async () => { throw new TypeError("leaked detail +15550001111"); }, report);
  assert.deepEqual(result, { ok: false, phase: "followup_dispatch" });
  assert.equal(alerts.length, 1);
  assert.deepEqual({ severity: alerts[0].severity, code: alerts[0].code, context: alerts[0].context, notify: alerts[0].notify }, { severity: "critical", code: "health_tick_phase_failed", context: { phase: "followup_dispatch", errorType: "TypeError" }, notify: undefined });
  assert.ok(!JSON.stringify(alerts[0]).includes("+1555"));
});

test("the health route isolates every phase and writes the heartbeat only for a complete tick", () => {
  const route = readFileSync("app/api/automation/health/route.ts", "utf8");
  for (const phase of ["execution_timeout", "retry_classification", "retry_processing", "followup_dispatch", "stuck_incidents", "stuck_incident_resolution", "scheduled_liveness", "scheduled_degraded_alert"]) {
    assert.match(route, new RegExp(`phase\\("${phase}"`), phase);
  }
  assert.match(route, /if \(phaseFailures\.length === 0\) \{\n\s+const \{ error: heartbeatError \} = await service\.from\("automation_health_check_runs"\)\.insert/);
  assert.match(route, /code: "health_heartbeat_write_failed"/);
  assert.match(route, /\{ status: tickOk \? 200 : 500 \}/);
});

const result = (over: Record<string, unknown>) => ({ heartbeatReadFailed: false, lastHeartbeatAt: "2026-10-10T12:00:00.000Z", heartbeatStale: false, staleAutomations: [] as string[], degraded: false, alert: null, ...over });

test("watchdog: a healthy run alerts nobody", async () => {
  const { alerts, report } = capture();
  assert.equal(await reportSchedulerWatchdogOutcome({ kind: "ran", result: result({}) as never }, report), null);
  assert.equal(alerts.length, 0);
});

test("watchdog: degraded, unreadable heartbeat and the watchdog itself failing all notify the operator", async () => {
  const { alerts, report } = capture();
  await reportSchedulerWatchdogOutcome({ kind: "ran", result: result({ degraded: true, heartbeatStale: true, staleAutomations: ["lead-nurture", "owner-digest"] }) as never }, report);
  await reportSchedulerWatchdogOutcome({ kind: "ran", result: result({ heartbeatReadFailed: true }) as never }, report);
  await reportSchedulerWatchdogOutcome({ kind: "threw", errorType: "Error" }, report);
  assert.deepEqual(alerts.map((alert) => [alert.code, alert.severity, alert.notify]), [
    ["scheduler_degraded", "critical", true],
    ["scheduler_heartbeat_unreadable", "critical", true],
    ["scheduler_watchdog_failed", "critical", true],
  ]);
  assert.deepEqual(alerts[0].context, { heartbeatStale: true, lastHeartbeatAt: "2026-10-10T12:00:00.000Z", staleAutomationCount: 2, staleAutomations: "lead-nurture,owner-digest", ownersNotified: 0 });
  const route = readFileSync("app/api/automation/scheduler-watchdog/route.ts", "utf8");
  assert.match(route, /catch \(error\) \{\n\s+await reportSchedulerWatchdogOutcome\(\{ kind: "threw"/);
});

test("liveness: healthy -> 200; stale / never-ran scheduler -> 503; unreadable database -> 503 with scheduler unknown", async () => {
  const now = Date.parse("2026-10-10T15:00:00.000Z");
  const fresh = await evaluateLiveness(async () => new Date(now - 10 * 60_000).toISOString(), now);
  assert.deepEqual({ status: fresh.status, ok: fresh.body.ok, checks: fresh.body.checks }, { status: 200, ok: true, checks: { app: "ok", database: "ok", scheduler: "ok" } });
  const stale = await evaluateLiveness(async () => new Date(now - HEALTH_CHECK_STALE_THRESHOLD_MS - 1).toISOString(), now);
  assert.deepEqual({ status: stale.status, scheduler: stale.body.checks.scheduler }, { status: 503, scheduler: "stale" });
  const never = await evaluateLiveness(async () => null, now);
  assert.deepEqual({ status: never.status, scheduler: never.body.checks.scheduler }, { status: 503, scheduler: "stale" });
  const down = await evaluateLiveness(async () => { throw new Error("db down"); }, now);
  assert.deepEqual({ status: down.status, checks: down.body.checks, lastHeartbeatAt: down.body.lastHeartbeatAt }, { status: 503, checks: { app: "ok", database: "unavailable", scheduler: "unknown" }, lastHeartbeatAt: null });
});

test("the public liveness route returns only booleans + the heartbeat time, never caches, and does no automation work", () => {
  const route = readFileSync("app/api/health/route.ts", "utf8");
  assert.match(route, /"cache-control": "no-store"/);
  assert.match(route, /\.from\("automation_health_check_runs"\)\s*\n\s*\.select\("checked_at"\)/);
  assert.doesNotMatch(route, /dispatch|processDueRetries|failTimedOut|insert\(|update\(|organization_id/);
});

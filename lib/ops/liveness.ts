import { isHealthCheckStale } from "@/lib/automation-health/health";

/**
 * Final Batch 4: the decision behind GET /api/health (public liveness).
 * Pure apart from the injected heartbeat read, so every outcome is testable.
 *   app        - always "ok" when this code runs at all;
 *   database   - "ok" when the heartbeat could be read, "unavailable" if not;
 *   scheduler  - "ok" when the last complete health tick is within the stale
 *                threshold (45 min), "stale" when older or never, "unknown"
 *                when the database could not be read.
 *   automation - Batch 4 (operations hardening): what the last complete
 *                tick saw - "ok" with no execution stuck past its callback,
 *                "degraded" with one or more, "unknown" when the scheduler
 *                is not fresh (an old tick can't vouch for now) or the tick
 *                did not record it.
 *
 * `ok` and the status code are LIVENESS only - app, database and scheduler
 * (200 / 503), unchanged, so an uptime monitor pages on a dead app or a
 * dead scheduler. `automationOk` says separately whether the automation
 * runtime looked healthy, so a 200 never implies downstream automation is
 * fine just because the app answered.
 */
export type HeartbeatRead = string | { checkedAt: string; stuckCount: number | null } | null;

export type LivenessBody = {
  ok: boolean;
  automationOk: boolean;
  checks: { app: "ok"; database: "ok" | "unavailable"; scheduler: "ok" | "stale" | "unknown"; automation: "ok" | "degraded" | "unknown" };
  lastHeartbeatAt: string | null;
  at: string;
};

export async function evaluateLiveness(readHeartbeat: () => Promise<HeartbeatRead>, now: number = Date.now()): Promise<{ status: 200 | 503; body: LivenessBody }> {
  let lastHeartbeatAt: string | null = null;
  let stuckCount: number | null = null;
  let database: LivenessBody["checks"]["database"] = "ok";
  try {
    const heartbeat = await readHeartbeat();
    if (typeof heartbeat === "string") lastHeartbeatAt = heartbeat;
    else if (heartbeat) {
      lastHeartbeatAt = heartbeat.checkedAt;
      stuckCount = typeof heartbeat.stuckCount === "number" && Number.isFinite(heartbeat.stuckCount) ? heartbeat.stuckCount : null;
    }
  } catch {
    database = "unavailable";
  }
  const scheduler: LivenessBody["checks"]["scheduler"] = database === "unavailable" ? "unknown" : isHealthCheckStale(lastHeartbeatAt, now) ? "stale" : "ok";
  const automation: LivenessBody["checks"]["automation"] = scheduler !== "ok" || stuckCount === null ? "unknown" : stuckCount > 0 ? "degraded" : "ok";
  const ok = database === "ok" && scheduler === "ok";
  return {
    status: ok ? 200 : 503,
    body: { ok, automationOk: automation === "ok", checks: { app: "ok", database, scheduler, automation }, lastHeartbeatAt, at: new Date(now).toISOString() },
  };
}

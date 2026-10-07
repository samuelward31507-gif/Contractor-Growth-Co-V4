import { isHealthCheckStale } from "@/lib/automation-health/health";

/**
 * Final Batch 4: the decision behind GET /api/health (public liveness).
 * Pure apart from the injected heartbeat read, so every outcome is testable.
 *   app       - always "ok" when this code runs at all;
 *   database  - "ok" when the heartbeat could be read, "unavailable" if not;
 *   scheduler - "ok" when the last complete health tick is within the stale
 *               threshold (45 min), "stale" when older or never, "unknown"
 *               when the database could not be read.
 */
export type LivenessBody = {
  ok: boolean;
  checks: { app: "ok"; database: "ok" | "unavailable"; scheduler: "ok" | "stale" | "unknown" };
  lastHeartbeatAt: string | null;
  at: string;
};

export async function evaluateLiveness(readHeartbeat: () => Promise<string | null>, now: number = Date.now()): Promise<{ status: 200 | 503; body: LivenessBody }> {
  let lastHeartbeatAt: string | null = null;
  let database: LivenessBody["checks"]["database"] = "ok";
  try {
    lastHeartbeatAt = await readHeartbeat();
  } catch {
    database = "unavailable";
  }
  const scheduler: LivenessBody["checks"]["scheduler"] = database === "unavailable" ? "unknown" : isHealthCheckStale(lastHeartbeatAt, now) ? "stale" : "ok";
  const ok = database === "ok" && scheduler === "ok";
  return { status: ok ? 200 : 503, body: { ok, checks: { app: "ok", database, scheduler }, lastHeartbeatAt, at: new Date(now).toISOString() } };
}

import type { SupabaseClient } from "@supabase/supabase-js";
import { getAutomationDefinition } from "@/lib/automation/catalog";

/**
 * Pass 5A: liveness tracking for Trackpr's scheduled (cron-dependent)
 * automations - the 6 real routes under app/api/automation/* that the
 * "Trackpr Scheduled Automation Dispatch" n8n workflow calls on their
 * behalf, every 15 minutes, alongside health (see lib/automation/cron-auth.ts
 * and lib/automation-health/health.ts): appointment-reminders,
 * estimate-followups, lead-nurture, lead-reactivation,
 * customer-reactivation, no-show-detection.
 *
 * This list is NOT derived from AUTOMATION_CATALOG's own `kind` field.
 * estimate-followup's `kind` is "event-triggered" - its primary behavior
 * (the initial AI notification when an estimate is sent) really is
 * event-driven - even though it also has a genuine scheduled check-in
 * component reachable only through its own cron route
 * (app/api/automation/estimate-followups/route.ts). Deriving this list from
 * `kind === "scheduled"` would silently miss it. This is its own small,
 * explicit, code-verified list - not a second competing automation catalog,
 * just the subset of catalog ids that have a real cron dependency, still
 * resolved back through getAutomationDefinition for display name/detail.
 *
 * WHY A NEW TABLE (automation_schedule_runs, see its own migration
 * comment): before this, a scheduled route's own success was only ever
 * recorded per-CANDIDATE, via workflow_executions - a tick that finds zero
 * eligible candidates (a common, healthy outcome for a lightly-loaded
 * organization) writes nothing at all, so "the route hasn't run in days"
 * and "the route runs constantly but nobody currently qualifies" were
 * indistinguishable. recordScheduledAutomationRun below closes that gap.
 */

export const SCHEDULED_AUTOMATION_IDS = [
  "appointment-reminders",
  "estimate-followup",
  "lost-lead-nurture",
  "lead-reactivation",
  "customer-reactivation",
  // Pass 5B: app/api/automation/no-show-detection/route.ts.
  "no-show-detection",
  // Phase 3D: app/api/automation/opportunity-sync/route.ts - scheduled
  // opportunity detection. Not an automation catalog entry, so its display
  // name comes from NON_CATALOG_SCHEDULED_NAMES below.
  "opportunity-sync",
] as const;

/** Display names for scheduled routes that aren't automation catalog entries. */
const NON_CATALOG_SCHEDULED_NAMES: Partial<Record<(typeof SCHEDULED_AUTOMATION_IDS)[number], string>> = {
  "opportunity-sync": "Opportunity Detection",
};

export type ScheduledAutomationId = (typeof SCHEDULED_AUTOMATION_IDS)[number];

/**
 * The real n8n cadence for these routes is now confirmed (Phase 0 final
 * completion program audit, live inspection of the "Trackpr Scheduled
 * Automation Dispatch" workflow): every 15 minutes, uniform across all 6
 * routes plus health. This applies the exact same "3x the interval"
 * convention HEALTH_CHECK_STALE_THRESHOLD_MS already established in
 * ./health.ts for that identical 15-minute cadence - tolerating a couple of
 * missed ticks before alarming, rather than the previous 24h placeholder,
 * which existed only because no ground truth was available yet.
 */
export const SCHEDULED_AUTOMATION_STALE_THRESHOLD_MS = 45 * 60 * 1000;

export type ScheduledAutomationLivenessState = "healthy" | "stale" | "unverified";

export type ScheduledAutomationLiveness = {
  automationId: ScheduledAutomationId;
  automationName: string;
  state: ScheduledAutomationLivenessState;
  lastRanAt: string | null;
  lastCandidateCount: number | null;
};

/**
 * Pure classification, extracted for direct unit testing without a mocked
 * Supabase client - matches isHealthCheckStale's own established shape in
 * ./health.ts. "unverified" (never observed running at all) is deliberately
 * never treated as "stale": a fresh deployment of this tracking, or any
 * other innocent reason for no evidence yet, must never read as a false
 * alarm - only a route that WAS observed running, and has since gone quiet
 * past the grace window, is "stale".
 */
export function computeScheduledAutomationLivenessState(lastRanAtIso: string | null, nowMs: number = Date.now()): ScheduledAutomationLivenessState {
  if (!lastRanAtIso) return "unverified";
  return nowMs - new Date(lastRanAtIso).getTime() > SCHEDULED_AUTOMATION_STALE_THRESHOLD_MS ? "stale" : "healthy";
}

/**
 * Best-effort, non-throwing - matches recordAutomationHealthSignal's own
 * established rule (lib/automation-health/service.ts) that an observability
 * write must never make a real automation run's own success/failure path
 * fail harder. Called once per scheduled-route invocation, regardless of
 * candidate count (see this file's own header comment for why zero
 * candidates must still be recorded) - always from that route's own
 * service-role client, never a session client.
 */
export async function recordScheduledAutomationRun(supabase: SupabaseClient, automationId: ScheduledAutomationId, candidateCount: number): Promise<void> {
  const { error } = await supabase.from("automation_schedule_runs").insert({ automation_id: automationId, candidate_count: candidateCount });
  if (error) {
    console.error("[automation-health] failed to record scheduled automation run", { automationId, error: error.message });
  }
}

type LivenessRpcRow = { automation_id: string; last_ran_at: string | null; last_candidate_count: number | null };

/**
 * Always returns exactly SCHEDULED_AUTOMATION_IDS.length entries, one per
 * known scheduled automation, even when automation_schedule_runs has no row
 * for one yet (state "unverified" in that case, never omitted) - callers
 * never need to handle a missing entry. Works with either a session-scoped
 * or service-role client: get_scheduled_automation_liveness() is a
 * SECURITY DEFINER RPC granted to `authenticated`, since the data it
 * returns is global and non-sensitive - see the migration's own comment.
 */
export async function getScheduledAutomationLiveness(supabase: SupabaseClient, now: Date = new Date()): Promise<ScheduledAutomationLiveness[]> {
  const { data, error } = await supabase.rpc("get_scheduled_automation_liveness");
  const rows = error || !data ? [] : (data as LivenessRpcRow[]);
  const byAutomationId = new Map(rows.map((row) => [row.automation_id, row]));

  return SCHEDULED_AUTOMATION_IDS.map((automationId) => {
    const row = byAutomationId.get(automationId);
    const definition = getAutomationDefinition(automationId);
    return {
      automationId,
      automationName: definition?.name ?? NON_CATALOG_SCHEDULED_NAMES[automationId] ?? automationId,
      state: computeScheduledAutomationLivenessState(row?.last_ran_at ?? null, now.getTime()),
      lastRanAt: row?.last_ran_at ?? null,
      lastCandidateCount: row?.last_candidate_count ?? null,
    };
  });
}

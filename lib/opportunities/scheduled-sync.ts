import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllPages } from "@/lib/bi/revenue-attribution";
import { syncOpportunities, type OpportunitySyncResult } from "./detect";

/**
 * Phase 3D: opportunity detection on a schedule, independent of anyone
 * opening /today. Called by app/api/automation/opportunity-sync (Supabase
 * pg_cron job trackpr_opportunity_sync, every 15 minutes) with a
 * service-role client - there is no user session, so the Dashboard's
 * claim_opportunity_sync RPC (which requires auth.uid() and membership) is
 * not usable here and is left untouched.
 *
 * Eligibility mirrors that RPC's own rule: payment_status = 'active'
 * (organization_payment_active). Throttling reuses the same
 * opportunity_sync_state row and the same 5-minute cooldown, maintained
 * directly by the service role (which keeps its default table grants - see
 * the opportunity_sync_state migration). The read-then-upsert is not atomic,
 * but it doesn't need to be: overlapping syncs of one organization are
 * already safe (the partial unique index on open opportunities turns a
 * duplicate insert into a tolerated 23505, and refresh/resolve updates are
 * scoped to open rows - see lib/opportunities/background-sync.ts). The
 * cooldown only avoids redundant work, e.g. right after a /today sync.
 *
 * syncOpportunities itself is unchanged; it scopes every read and write to
 * the organization id it is given, and it never sends a message. One
 * organization's failure never stops the others.
 */

export const SCHEDULED_SYNC_COOLDOWN_MS = 5 * 60 * 1000;

export type ScheduledOpportunitySyncOutcome = { organizationId: string; outcome: "synced" | "throttled" | "failed" };

export type ScheduledOpportunitySyncResult = {
  candidates: number;
  synced: number;
  throttled: number;
  failed: number;
  /** True when the eligible-organization scan itself failed - nothing was synced. */
  scanFailed: boolean;
  outcomes: ScheduledOpportunitySyncOutcome[];
};

export type ScheduledOpportunitySyncDeps = {
  sync?: (supabase: SupabaseClient, organizationId: string, now: Date) => Promise<OpportunitySyncResult>;
  log?: (message: string, context: Record<string, unknown>) => void;
};

/** True when this run should sync the organization: no claim yet, or the last one is at least SCHEDULED_SYNC_COOLDOWN_MS old. Records the claim before returning true. Throws on a read or write error. */
async function claimScheduledSync(service: SupabaseClient, organizationId: string, now: Date): Promise<boolean> {
  const { data, error } = await service.from("opportunity_sync_state").select("last_started_at").eq("organization_id", organizationId).maybeSingle();
  if (error) throw new Error(`opportunity_sync_state read failed: ${error.message}`);

  const lastStartedAt = (data as { last_started_at: string } | null)?.last_started_at;
  if (lastStartedAt && now.getTime() - new Date(lastStartedAt).getTime() < SCHEDULED_SYNC_COOLDOWN_MS) return false;

  const { error: upsertError } = await service
    .from("opportunity_sync_state")
    .upsert({ organization_id: organizationId, last_started_at: now.toISOString() }, { onConflict: "organization_id" });
  if (upsertError) throw new Error(`opportunity_sync_state write failed: ${upsertError.message}`);
  return true;
}

export async function runScheduledOpportunitySync(service: SupabaseClient, now: Date = new Date(), deps: ScheduledOpportunitySyncDeps = {}): Promise<ScheduledOpportunitySyncResult> {
  const sync = deps.sync ?? syncOpportunities;
  const log = deps.log ?? ((message, context) => console.error(message, context));

  const organizations = await readAllPages<{ id: string }>(() => service.from("organizations").select("id").eq("payment_status", "active").order("id"));
  if (organizations.failed) {
    log("[opportunities] scheduled sync: eligible organization scan failed", {});
    return { candidates: 0, synced: 0, throttled: 0, failed: 0, scanFailed: true, outcomes: [] };
  }

  const outcomes: ScheduledOpportunitySyncOutcome[] = [];
  // Sequential on purpose: one organization at a time bounds the database
  // load of a 15-minute tick (each sync is ~25+ reads).
  for (const { id: organizationId } of organizations.rows) {
    try {
      if (!(await claimScheduledSync(service, organizationId, now))) {
        outcomes.push({ organizationId, outcome: "throttled" });
        continue;
      }
      const result = await sync(service, organizationId, now);
      outcomes.push({ organizationId, outcome: result.failed ? "failed" : "synced" });
    } catch (error) {
      log("[opportunities] scheduled sync failed for an organization", { organizationId, error: error instanceof Error ? error.message : String(error) });
      outcomes.push({ organizationId, outcome: "failed" });
    }
  }

  const count = (outcome: ScheduledOpportunitySyncOutcome["outcome"]) => outcomes.filter((o) => o.outcome === outcome).length;
  return { candidates: organizations.rows.length, synced: count("synced"), throttled: count("throttled"), failed: count("failed"), scanFailed: false, outcomes };
}

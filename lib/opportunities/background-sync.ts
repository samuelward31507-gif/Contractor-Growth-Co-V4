import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAccessTokenClient } from "@/lib/supabase/access-token-client";
import { syncOpportunities } from "./detect";

/**
 * Phase 2C: the Dashboard's opportunity sync, moved off the blocking render
 * path. /today used to `await syncOpportunities(...)` (~21 reads, plus any
 * writes) before it read anything else; it now renders from the
 * opportunities table as it stands and the sync runs after the response,
 * through Next.js's after() - the same mechanism lib/automation/* already
 * uses. The one behavioral difference: an opportunity detected or updated
 * by this sync shows up on the next Dashboard render instead of this one.
 * syncOpportunities itself (detectors, thresholds, dedup, dismissal,
 * create/refresh/resolve) is untouched.
 *
 * Why not just `after(() => syncOpportunities(supabase, ...))`: the page's
 * session client reads the request's cookies on every query, and Server
 * Components may not use request-time APIs inside after(). So the access
 * token is read now, during render, and the post-response sync runs on a
 * client built from that token alone (lib/supabase/access-token-client.ts):
 * the same user's JWT, so the same RLS and the same organization isolation -
 * never a service-role client. The organization id is the caller's verified
 * membership.
 *
 * Never throws and never rejects: a missing session skips the sync, and a
 * failed sync is logged ("[opportunities] ..." console.error, this module's
 * existing convention) instead of reaching the page. Concurrent syncs (two
 * tabs) are safe - the partial unique index on (organization_id, type,
 * source_entity_id) WHERE status = 'open' turns a duplicate insert into a
 * tolerated 23505, and refresh/resolve updates are scoped to open rows.
 *
 * Performance Pass 2: at most one sync per organization per 5 minutes. The
 * after() task first calls claim_opportunity_sync (supabase/migrations/
 * 20260930025936_opportunity_sync_state.sql) on the same token-scoped client - an atomic,
 * SECURITY DEFINER claim that returns true for exactly one caller per
 * organization per 5 minutes, and only for a member of an organization whose
 * payment is active (the sync's own existing rules). A lost claim skips the
 * sync quietly; a claim that errors or throws skips it and logs - never a
 * blind sync. The claim runs inside the after() task, so the Dashboard's
 * response never waits for it either. A sync that fails or aborts keeps its
 * claim until the cooldown expires.
 */

export type OpportunitySyncDeps = {
  after?: (task: () => Promise<void>) => void;
  sync?: (supabase: SupabaseClient, organizationId: string) => Promise<unknown>;
  createClient?: (accessToken: string) => SupabaseClient;
  log?: (message: string, context: Record<string, unknown>) => void;
};

export async function scheduleOpportunitySync(requestSupabase: SupabaseClient, organizationId: string, deps: OpportunitySyncDeps = {}): Promise<void> {
  const schedule = deps.after ?? after;
  const sync = deps.sync ?? syncOpportunities;
  const makeClient = deps.createClient ?? createAccessTokenClient;
  const log = deps.log ?? ((message, context) => console.error(message, context));

  let accessToken: string | undefined;
  try {
    const { data } = await requestSupabase.auth.getSession();
    accessToken = data.session?.access_token;
  } catch (error) {
    log("[opportunities] background sync not scheduled: session unavailable", { organizationId, error: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (!accessToken) {
    log("[opportunities] background sync not scheduled: no session", { organizationId });
    return;
  }

  const token = accessToken;
  schedule(async () => {
    const client = makeClient(token);

    let claimed: boolean;
    try {
      const { data, error } = await client.rpc("claim_opportunity_sync", { p_organization_id: organizationId });
      if (error) throw new Error(error.message);
      claimed = data === true;
    } catch (error) {
      log("[opportunities] background sync skipped: claim failed", { organizationId, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    // Another request already synced this organization within the cooldown
    // (or it isn't eligible) - nothing to do, and nothing worth logging.
    if (!claimed) return;

    try {
      await sync(client, organizationId);
    } catch (error) {
      log("[opportunities] background sync failed", { organizationId, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

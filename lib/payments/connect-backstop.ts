import type { SupabaseClient } from "@supabase/supabase-js";
import { syncConnectAccountStatus, type ConnectStatus, type PaymentsDeps } from "./connect";

/**
 * Phase 1C (W2 backstop): refreshes an organization's stored Connect status
 * from Stripe when an admin opens Settings and that status is incomplete -
 * the safety net for any status change whose webhook never arrived or was
 * missed. The v2 thin-event webhook (connect-accounts-webhook.ts) is the
 * primary path; this only catches what it didn't.
 *
 * Scope, deliberately narrow:
 *   - only for an account Trackpr already holds (never creates an account,
 *     never creates an onboarding link - it calls syncConnectAccountStatus,
 *     which only re-fetches with Accounts v2 and stores the mapped flags);
 *   - only when something is still off (charges, payouts or details false) -
 *     a fully enabled account is never re-fetched on a Settings view;
 *   - at most once per REFRESH_INTERVAL_MS per organization, judged by the
 *     stored stripe_connect_synced_at, so re-renders and reloads can't turn
 *     into a Stripe request loop;
 *   - the caller runs it for owners/admins only; the public pay page never
 *     calls it (no Stripe request per anonymous visitor).
 * If Stripe is unreachable (or storage fails) the stored status is kept as it
 * was and the caller shows a fixed notice - no Stripe error text ever reaches
 * the page.
 */

export const REFRESH_INTERVAL_MS = 60_000;

export type BackstopResult = {
  status: ConnectStatus | null;
  refreshed: boolean;
  /** Set only when a refresh was attempted and failed; the stored status is returned unchanged. */
  refreshFailed: boolean;
};

export function needsBackstopRefresh(status: ConnectStatus | null, now: Date = new Date()): boolean {
  if (!status?.accountId) return false;
  if (status.chargesEnabled && status.payoutsEnabled && status.detailsSubmitted) return false;
  if (!status.syncedAt) return true;
  const last = new Date(status.syncedAt).getTime();
  return !Number.isFinite(last) || now.getTime() - last >= REFRESH_INTERVAL_MS;
}

export async function refreshStaleConnectStatus(
  service: SupabaseClient,
  organizationId: string,
  current: ConnectStatus | null,
  options: PaymentsDeps & { now?: Date } = {},
): Promise<BackstopResult> {
  if (!needsBackstopRefresh(current, options.now)) return { status: current, refreshed: false, refreshFailed: false };

  const synced = await syncConnectAccountStatus(service, organizationId, { stripe: options.stripe });
  if (synced.ok) return { status: synced.data, refreshed: true, refreshFailed: false };

  console.error("[payments][connect-backstop] Settings refresh from Stripe failed; keeping the stored status", { organizationId, code: synced.code });
  return { status: current, refreshed: false, refreshFailed: true };
}

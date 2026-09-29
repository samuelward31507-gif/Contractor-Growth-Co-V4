import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getPaymentsStripeClient } from "@/lib/billing/stripe-mode-guard";

/**
 * Phase 1C (Online Payments): the contractor's Stripe Connect account, on the
 * Accounts v2 API (/v2/core/accounts) - Stripe's current model for new
 * Connect integrations. Accounts v1 creation is never used (a structural test
 * in lib/billing/stripe-mode-guard.test.ts enforces it for lib/payments).
 *
 * Account model (approved, and permanent once created - Stripe does not allow
 * the dashboard or the responsibilities to change later):
 *   dashboard: "full"                         the contractor gets the full
 *                                             Stripe Dashboard (Standard-style)
 *   defaults.responsibilities.fees_collector: "stripe"
 *                                             Stripe collects its processing
 *                                             fees from the contractor on
 *                                             direct charges
 *   defaults.responsibilities.losses_collector: "stripe"
 *                                             Stripe, not Trackpr, is liable
 *                                             for negative balances; with a
 *                                             full dashboard this also makes
 *                                             Stripe the requirements collector
 *   configuration.merchant, card_payments requested, identity.country "us",
 *   defaults.currency "usd"                   Phase 1C is USD-only, for U.S.
 *                                             contractors
 * Invoice payments are direct charges on this account (lib/payments/
 * invoice-checkout.ts, via the Stripe-Account header, which accepts v2
 * account ids) with no platform fee.
 *
 * Every Stripe call goes through getPaymentsStripeClient() (the live-key
 * guard). The `stripe` dep exists only so tests can pass a fake - production
 * callers never set it.
 *
 * Every write to the organizations Connect columns needs the service-role
 * client: the organizations_stripe_connect_guard trigger refuses them from a
 * user session (supabase/pending/online_payments.sql). Callers derive
 * `organizationId` from the signed-in admin's own organization (onboarding
 * routes) or from a signed Stripe event (webhook), never from request input.
 */

export type PaymentsDeps = {
  /** Test seam only. Omitted in production: the guarded client is used. */
  stripe?: Stripe;
};

export function paymentsStripe(deps: PaymentsDeps = {}): Stripe {
  return deps.stripe ?? getPaymentsStripeClient();
}

export type ConnectStatus = {
  accountId: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  syncedAt: string | null;
};

/** What Settings shows: never connected, connected but Stripe can't take charges yet, or ready. */
export type ConnectState = "not_connected" | "onboarding_incomplete" | "enabled";

/**
 * Why a Connect operation failed, for callers that must decide what to do
 * next (the Connect webhook retries only stripe_unavailable/storage_failed -
 * see lib/payments/connect-webhook.ts). `error` stays the user-facing text.
 */
export type ConnectErrorCode = "not_found" | "not_connected" | "unknown_account" | "account_mismatch" | "stripe_unavailable" | "storage_failed" | "invalid_request";

export type ConnectResult<T> = { ok: true; data: T; error?: undefined; code?: undefined } | { ok: false; error: string; code: ConnectErrorCode; data?: undefined };

export const CONNECT_ACCOUNT_ID_PATTERN = /^acct_[A-Za-z0-9]{1,255}$/;

/** v2 only returns these properties when asked; without them the status can't be read. */
export const V2_ACCOUNT_INCLUDE: Array<"configuration.merchant" | "requirements"> = ["configuration.merchant", "requirements"];

const CONNECT_COLUMNS = "stripe_connect_account_id, stripe_connect_charges_enabled, stripe_connect_payouts_enabled, stripe_connect_details_submitted, stripe_connect_synced_at";

type ConnectRow = {
  stripe_connect_account_id: string | null;
  stripe_connect_charges_enabled: boolean | null;
  stripe_connect_payouts_enabled: boolean | null;
  stripe_connect_details_submitted: boolean | null;
  stripe_connect_synced_at: string | null;
};

function toStatus(row: ConnectRow): ConnectStatus {
  return {
    accountId: row.stripe_connect_account_id ?? null,
    chargesEnabled: row.stripe_connect_charges_enabled === true,
    payoutsEnabled: row.stripe_connect_payouts_enabled === true,
    detailsSubmitted: row.stripe_connect_details_submitted === true,
    syncedAt: row.stripe_connect_synced_at ?? null,
  };
}

export function describeConnectState(status: Pick<ConnectStatus, "accountId" | "chargesEnabled">): ConnectState {
  if (!status.accountId) return "not_connected";
  return status.chargesEnabled ? "enabled" : "onboarding_incomplete";
}

/**
 * The single eligibility rule for taking a card payment on an invoice: a
 * connected account Stripe says can accept charges, and an organization whose
 * own Trackpr subscription is active. Used by the public pay page and by
 * Checkout Session creation, so both always agree.
 */
export function canAcceptOnlinePayments(input: { paymentStatus: string | null | undefined; connect: Pick<ConnectStatus, "accountId" | "chargesEnabled"> }): boolean {
  return input.paymentStatus === "active" && Boolean(input.connect.accountId) && input.connect.chargesEnabled;
}

export type V2AccountStatus = Pick<ConnectStatus, "chargesEnabled" | "payoutsEnabled" | "detailsSubmitted">;

/**
 * How Trackpr reads a v2 Account (retrieved with V2_ACCOUNT_INCLUDE) into its
 * three stored flags. Fails closed: anything missing reads as false.
 *
 *   chargesEnabled   configuration.merchant.capabilities.card_payments.status
 *                    === "active" ('pending' | 'restricted' | 'unsupported'
 *                    are all "no")
 *   payoutsEnabled   configuration.merchant.capabilities.stripe_balance
 *                    .payouts.status === "active"
 *   detailsSubmitted v2 has no details_submitted field. Stripe's documented v2
 *                    onboarding check is the requirements hash: an entry whose
 *                    minimum_deadline.status is currently_due or past_due is
 *                    outstanding. Only entries awaiting action from the USER
 *                    count - one awaiting Stripe (awaiting_action_from:
 *                    "stripe") is information the contractor already gave
 *                    that Stripe is still reviewing. eventually_due entries
 *                    don't block onboarding ("currently_due" collection). If
 *                    the requirements hash is absent the answer is false.
 */
export function statusFromV2Account(account: Pick<Stripe.V2.Core.Account, "configuration" | "requirements">): V2AccountStatus {
  const capabilities = account.configuration?.merchant?.capabilities;
  const chargesEnabled = capabilities?.card_payments?.status === "active";
  const payoutsEnabled = capabilities?.stripe_balance?.payouts?.status === "active";

  const requirements = account.requirements;
  const outstanding = (requirements?.entries ?? []).some(
    (entry) => entry.awaiting_action_from !== "stripe" && (entry.minimum_deadline?.status === "currently_due" || entry.minimum_deadline?.status === "past_due"),
  );
  const detailsSubmitted = Boolean(requirements) && !outstanding;

  return { chargesEnabled, payoutsEnabled, detailsSubmitted };
}

function statusColumns(status: V2AccountStatus, syncedAt: string): Omit<ConnectRow, "stripe_connect_account_id"> {
  return {
    stripe_connect_charges_enabled: status.chargesEnabled,
    stripe_connect_payouts_enabled: status.payoutsEnabled,
    stripe_connect_details_submitted: status.detailsSubmitted,
    stripe_connect_synced_at: syncedAt,
  };
}

export async function getOrganizationConnectStatus(supabase: SupabaseClient, organizationId: string): Promise<ConnectStatus | null> {
  const { data, error } = await supabase.from("organizations").select(CONNECT_COLUMNS).eq("id", organizationId).maybeSingle();
  if (error || !data) return null;
  return toStatus(data as ConnectRow);
}

/**
 * The permanent v2 creation parameters for an organization's account -
 * exported so tests pin them exactly.
 */
export function buildConnectAccountCreateParams(organizationId: string, organizationName: string | null | undefined): Stripe.V2.Core.AccountCreateParams {
  const displayName = (organizationName ?? "").trim();
  return {
    dashboard: "full",
    defaults: {
      currency: "usd",
      responsibilities: { fees_collector: "stripe", losses_collector: "stripe" },
    },
    configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
    identity: { country: "us" },
    ...(displayName ? { display_name: displayName.slice(0, 100) } : {}),
    metadata: { organization_id: organizationId },
    include: V2_ACCOUNT_INCLUDE,
  };
}

/**
 * Returns the organization's connected account, creating it on first use.
 *
 * Double-submit safe twice over: the Stripe idempotency key is derived from
 * the organization, so two concurrent "Connect" clicks get the SAME account
 * back from Stripe; and the write only fills an empty column
 * (`.is("stripe_connect_account_id", null)`), so a concurrent winner is read
 * back rather than overwritten.
 */
export async function ensureConnectAccount(service: SupabaseClient, organizationId: string, deps: PaymentsDeps = {}): Promise<ConnectResult<{ accountId: string; created: boolean }>> {
  const { data: orgRow, error: orgError } = await service.from("organizations").select(`name, ${CONNECT_COLUMNS}`).eq("id", organizationId).maybeSingle();
  if (orgError || !orgRow) return { ok: false, error: "This organization could not be found.", code: "not_found" };
  const current = toStatus(orgRow as ConnectRow);
  if (current.accountId) return { ok: true, data: { accountId: current.accountId, created: false } };

  let account: Stripe.V2.Core.Account;
  try {
    account = await paymentsStripe(deps).v2.core.accounts.create(buildConnectAccountCreateParams(organizationId, (orgRow as { name?: string | null }).name), {
      idempotencyKey: `trackpr-connect-account-${organizationId}`,
    });
  } catch (error) {
    console.error("[payments][connect] failed to create connected account", { organizationId, error: stripeErrorMessage(error) });
    return { ok: false, error: "We couldn't start Stripe setup. Please try again.", code: "stripe_unavailable" };
  }

  if (!CONNECT_ACCOUNT_ID_PATTERN.test(account.id ?? "")) {
    console.error("[payments][connect] Stripe returned an unexpected account id", { organizationId });
    return { ok: false, error: "We couldn't start Stripe setup. Please try again.", code: "stripe_unavailable" };
  }

  const { data: updated, error: updateError } = await service
    .from("organizations")
    .update({ stripe_connect_account_id: account.id, ...statusColumns(statusFromV2Account(account), new Date().toISOString()) })
    .eq("id", organizationId)
    .is("stripe_connect_account_id", null)
    .select("id");

  if (updateError) {
    console.error("[payments][connect] failed to store connected account", { organizationId, accountId: account.id, error: updateError.message });
    return { ok: false, error: "We couldn't save your Stripe account. Please try again.", code: "storage_failed" };
  }

  if (!updated || updated.length === 0) {
    // Another request stored an account first - use whatever is stored now.
    const winner = await getOrganizationConnectStatus(service, organizationId);
    if (winner?.accountId) return { ok: true, data: { accountId: winner.accountId, created: false } };
    return { ok: false, error: "We couldn't save your Stripe account. Please try again.", code: "storage_failed" };
  }

  return { ok: true, data: { accountId: account.id, created: true } };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** A single-use Stripe-hosted v2 onboarding link (merchant configuration, currently_due collection) for an account Trackpr already holds. */
async function createV2OnboardingLink(organizationId: string, accountId: string, urls: { returnUrl: string; refreshUrl: string }, deps: PaymentsDeps): Promise<ConnectResult<{ url: string; accountId: string }>> {
  try {
    const link = await paymentsStripe(deps).v2.core.accountLinks.create({
      account: accountId,
      use_case: {
        type: "account_onboarding",
        account_onboarding: {
          configurations: ["merchant"],
          collection_options: { fields: "currently_due" },
          return_url: urls.returnUrl,
          refresh_url: urls.refreshUrl,
        },
      },
    });
    if (!link.url) return { ok: false, error: "We couldn't open Stripe setup. Please try again.", code: "stripe_unavailable" };
    return { ok: true, data: { url: link.url, accountId } };
  } catch (error) {
    console.error("[payments][connect] failed to create account link", { organizationId, accountId, error: stripeErrorMessage(error) });
    return { ok: false, error: "We couldn't open Stripe setup. Please try again.", code: "stripe_unavailable" };
  }
}

/**
 * The "Connect Stripe" / "Finish setup" start: the organization's onboarding
 * link, creating its account first if it has none. `returnUrl`/`refreshUrl`
 * are built by the caller from the app's own origin, never from request input.
 */
export async function createConnectOnboardingLink(
  service: SupabaseClient,
  organizationId: string,
  urls: { returnUrl: string; refreshUrl: string },
  deps: PaymentsDeps = {},
): Promise<ConnectResult<{ url: string; accountId: string }>> {
  if (!isHttpUrl(urls.returnUrl) || !isHttpUrl(urls.refreshUrl)) return { ok: false, error: "Stripe setup is not configured correctly.", code: "invalid_request" };

  const ensured = await ensureConnectAccount(service, organizationId, deps);
  if (!ensured.ok) return ensured;
  return createV2OnboardingLink(organizationId, ensured.data.accountId, urls, deps);
}

/**
 * The refresh flow (Stripe's refresh_url, when a link expired or was already
 * used): a NEW link for the organization's EXISTING account. It never creates
 * an account - an organization with none gets not_connected.
 */
export async function refreshConnectOnboardingLink(
  service: SupabaseClient,
  organizationId: string,
  urls: { returnUrl: string; refreshUrl: string },
  deps: PaymentsDeps = {},
): Promise<ConnectResult<{ url: string; accountId: string }>> {
  if (!isHttpUrl(urls.returnUrl) || !isHttpUrl(urls.refreshUrl)) return { ok: false, error: "Stripe setup is not configured correctly.", code: "invalid_request" };

  const current = await getOrganizationConnectStatus(service, organizationId);
  if (!current) return { ok: false, error: "This organization could not be found.", code: "not_found" };
  if (!current.accountId) return { ok: false, error: "Stripe has not been connected yet.", code: "not_connected" };
  return createV2OnboardingLink(organizationId, current.accountId, urls, deps);
}

/**
 * Re-reads the connected account from Stripe (v2, with V2_ACCOUNT_INCLUDE)
 * and stores its mapped flags. Always a fresh retrieve, never a webhook
 * payload, so out-of-order account.updated deliveries can never store a stale
 * snapshot. The account returned by Stripe must be the one stored for this
 * organization, and when it carries Trackpr's organization_id metadata that
 * must match too.
 */
async function syncAccount(service: SupabaseClient, organizationId: string, accountId: string, deps: PaymentsDeps): Promise<ConnectResult<ConnectStatus>> {
  let account: Stripe.V2.Core.Account;
  try {
    account = await paymentsStripe(deps).v2.core.accounts.retrieve(accountId, { include: V2_ACCOUNT_INCLUDE });
  } catch (error) {
    console.error("[payments][connect] failed to retrieve connected account", { organizationId, accountId, error: stripeErrorMessage(error) });
    return { ok: false, error: "We couldn't reach Stripe. Please try again.", code: "stripe_unavailable" };
  }

  const metadataOrganization = account.metadata?.organization_id;
  if (account.id !== accountId || (metadataOrganization && metadataOrganization !== organizationId)) {
    console.error("[payments][connect] connected account does not belong to this organization", { organizationId, accountId, returnedId: account.id });
    return { ok: false, error: "This Stripe account does not match your organization.", code: "account_mismatch" };
  }

  const columns = statusColumns(statusFromV2Account(account), new Date().toISOString());
  const { error } = await service.from("organizations").update(columns).eq("id", organizationId).eq("stripe_connect_account_id", accountId);
  if (error) {
    console.error("[payments][connect] failed to store connected account status", { organizationId, accountId, error: error.message });
    return { ok: false, error: "We couldn't save your Stripe status. Please try again.", code: "storage_failed" };
  }

  return { ok: true, data: toStatus({ stripe_connect_account_id: accountId, ...columns }) };
}

/** The onboarding return route's sync: the organization's own stored account. */
export async function syncConnectAccountStatus(service: SupabaseClient, organizationId: string, deps: PaymentsDeps = {}): Promise<ConnectResult<ConnectStatus>> {
  const current = await getOrganizationConnectStatus(service, organizationId);
  if (!current) return { ok: false, error: "This organization could not be found.", code: "not_found" };
  if (!current.accountId) return { ok: false, error: "Stripe has not been connected yet.", code: "not_connected" };
  return syncAccount(service, organizationId, current.accountId, deps);
}

/**
 * The account.updated webhook's sync: resolves the organization from the
 * signed event's account id (the stored, unique stripe_connect_account_id),
 * then re-reads the account from Stripe. An account no organization owns is
 * reported, never adopted.
 */
export async function syncConnectAccountById(service: SupabaseClient, accountId: string, deps: PaymentsDeps = {}): Promise<ConnectResult<{ organizationId: string; status: ConnectStatus }>> {
  if (!CONNECT_ACCOUNT_ID_PATTERN.test(accountId)) return { ok: false, error: "unknown_account", code: "unknown_account" };
  const { data, error } = await service.from("organizations").select("id").eq("stripe_connect_account_id", accountId).maybeSingle();
  if (error || !data) return { ok: false, error: "unknown_account", code: "unknown_account" };
  const organizationId = (data as { id: string }).id;
  const synced = await syncAccount(service, organizationId, accountId, deps);
  if (!synced.ok) return synced;
  return { ok: true, data: { organizationId, status: synced.data } };
}

/** Stripe errors carry a message and a type; never a key. Anything else is reduced to a string. */
export function stripeErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const { type, message } = error as { type?: unknown; message?: unknown };
    if (typeof message === "string") return typeof type === "string" ? `${type}: ${message}` : message;
  }
  return String(error);
}

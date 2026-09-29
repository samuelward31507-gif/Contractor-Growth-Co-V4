/**
 * Phase 1C: unit tests for lib/payments/connect.ts (Stripe Accounts v2). Fake
 * Supabase and a v2-only fake Stripe (the v1 accounts/accountLinks resources
 * don't exist on it, so any v1 call fails) - no network, no .env.local, no
 * real key. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/payments/connect.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type Stripe from "stripe";
import { makeFakeStripe, makeFakeSupabase, stripeApiError, v2Account, withStripeKey, type Row } from "./test-fakes";

const require = createRequire(import.meta.url);
const connect: typeof import("./connect") = require("./connect.ts");
const {
  buildConnectAccountCreateParams,
  canAcceptOnlinePayments,
  createConnectOnboardingLink,
  describeConnectState,
  ensureConnectAccount,
  getOrganizationConnectStatus,
  refreshConnectOnboardingLink,
  statusFromV2Account,
  syncConnectAccountById,
  syncConnectAccountStatus,
} = connect;

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const ACCT = "acct_1TestConnect000001";
const LINK_URL = "https://accounts.stripe.com/r/acct_1TestConnect000001#alu_test_link";

function org(overrides: Partial<Row> = {}): Row {
  return {
    id: ORG,
    name: "Acme Roofing",
    payment_status: "active",
    stripe_connect_account_id: null,
    stripe_connect_charges_enabled: false,
    stripe_connect_payouts_enabled: false,
    stripe_connect_details_submitted: false,
    stripe_connect_synced_at: null,
    ...overrides,
  };
}

const URLS = { returnUrl: "http://localhost:3000/api/payments/connect/return", refreshUrl: "http://localhost:3000/api/payments/connect/refresh" };

// ---------------------------------------------------------------------------
// statusFromV2Account
// ---------------------------------------------------------------------------

test("statusFromV2Account: card payments - only 'active' enables charges", () => {
  assert.equal(statusFromV2Account(v2Account({ card: "active" })).chargesEnabled, true);
  for (const status of ["pending", "restricted", "unsupported"] as const) {
    assert.equal(statusFromV2Account(v2Account({ card: status })).chargesEnabled, false, status);
  }
  assert.equal(statusFromV2Account(v2Account({ card: null })).chargesEnabled, false, "capability absent");
});

test("statusFromV2Account: payouts - only 'active'; payouts pending while card payments are active", () => {
  const status = statusFromV2Account(v2Account({ card: "active", payouts: "pending" }));
  assert.deepEqual({ charges: status.chargesEnabled, payouts: status.payoutsEnabled }, { charges: true, payouts: false });
  assert.equal(statusFromV2Account(v2Account({ payouts: "active" })).payoutsEnabled, true);
  for (const payouts of ["restricted", "unsupported", null] as const) assert.equal(statusFromV2Account(v2Account({ payouts })).payoutsEnabled, false, String(payouts));
});

test("statusFromV2Account: a missing merchant configuration (or a response without include) fails closed on every flag", () => {
  assert.deepEqual(statusFromV2Account(v2Account({ configuration: false, requirements: false })), { chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false });
  assert.deepEqual(statusFromV2Account({ configuration: undefined, requirements: undefined }), { chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false });
  assert.equal(statusFromV2Account(v2Account({ configuration: false })).detailsSubmitted, true, "requirements are judged on their own");
});

test("statusFromV2Account: requirements (v2 has no details_submitted) - none or eventually_due only = submitted; currently_due or past_due awaiting the user = not", () => {
  assert.equal(statusFromV2Account(v2Account({ requirements: [] })).detailsSubmitted, true, "no entries");
  assert.equal(statusFromV2Account(v2Account({ requirements: [{ status: "eventually_due" }, { status: "eventually_due" }] })).detailsSubmitted, true, "eventually_due only");
  assert.equal(statusFromV2Account(v2Account({ requirements: [{ status: "currently_due" }] })).detailsSubmitted, false, "currently_due");
  assert.equal(statusFromV2Account(v2Account({ requirements: [{ status: "past_due" }] })).detailsSubmitted, false, "past_due");
  assert.equal(statusFromV2Account(v2Account({ requirements: [{ status: "eventually_due" }, { status: "currently_due" }] })).detailsSubmitted, false, "mixed");
  assert.equal(statusFromV2Account(v2Account({ requirements: false })).detailsSubmitted, false, "requirements hash absent fails closed");
});

test("statusFromV2Account: an entry awaiting Stripe's review (already submitted by the contractor) does not count as outstanding", () => {
  assert.equal(statusFromV2Account(v2Account({ requirements: [{ status: "currently_due", awaitingActionFrom: "stripe" }] })).detailsSubmitted, true);
  assert.equal(statusFromV2Account(v2Account({ requirements: [{ status: "currently_due", awaitingActionFrom: "stripe" }, { status: "past_due", awaitingActionFrom: "user" }] })).detailsSubmitted, false);
});

test("describeConnectState and canAcceptOnlinePayments: charges must be enabled AND the Trackpr subscription active", () => {
  assert.equal(describeConnectState({ accountId: null, chargesEnabled: false }), "not_connected");
  assert.equal(describeConnectState({ accountId: ACCT, chargesEnabled: false }), "onboarding_incomplete");
  assert.equal(describeConnectState({ accountId: ACCT, chargesEnabled: true }), "enabled");
  const ready = { accountId: ACCT, chargesEnabled: true };
  assert.equal(canAcceptOnlinePayments({ paymentStatus: "active", connect: ready }), true);
  for (const status of ["suspended", "cancelled", "payment_required", null, undefined]) {
    assert.equal(canAcceptOnlinePayments({ paymentStatus: status, connect: ready }), false, `payment_status ${String(status)}`);
  }
  assert.equal(canAcceptOnlinePayments({ paymentStatus: "active", connect: { accountId: ACCT, chargesEnabled: false } }), false);
  assert.equal(canAcceptOnlinePayments({ paymentStatus: "active", connect: { accountId: null, chargesEnabled: true } }), false);
});

test("getOrganizationConnectStatus maps the stored columns and treats null flags as false", async () => {
  const db = makeFakeSupabase({ organizations: [org({ stripe_connect_account_id: ACCT, stripe_connect_charges_enabled: true, stripe_connect_payouts_enabled: null })] });
  assert.deepEqual(await getOrganizationConnectStatus(db.client, ORG), { accountId: ACCT, chargesEnabled: true, payoutsEnabled: false, detailsSubmitted: false, syncedAt: null });
  assert.equal(await getOrganizationConnectStatus(db.client, OTHER_ORG), null);
});

// ---------------------------------------------------------------------------
// Account creation (v2)
// ---------------------------------------------------------------------------

test("the permanent v2 creation configuration is EXACTLY: full dashboard, Stripe collects fees and carries losses, card_payments requested, US, USD, org name, org metadata", () => {
  assert.deepEqual(buildConnectAccountCreateParams(ORG, "  Acme Roofing  "), {
    dashboard: "full",
    defaults: { currency: "usd", responsibilities: { fees_collector: "stripe", losses_collector: "stripe" } },
    configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
    identity: { country: "us" },
    display_name: "Acme Roofing",
    metadata: { organization_id: ORG },
    include: ["configuration.merchant", "requirements"],
  });
  assert.equal("display_name" in buildConnectAccountCreateParams(ORG, "   "), false, "a blank name is not sent");
  assert.equal("display_name" in buildConnectAccountCreateParams(ORG, null), false);
});

test("ensureConnectAccount: an organization that already has an account never calls Stripe", async () => {
  const db = makeFakeSupabase({ organizations: [org({ stripe_connect_account_id: ACCT })] });
  const fake = makeFakeStripe();
  assert.deepEqual(await ensureConnectAccount(db.client, ORG, { stripe: fake.stripe }), { ok: true, data: { accountId: ACCT, created: false } });
  assert.equal(fake.calls.length, 0);
  assert.equal(db.writes().length, 0);
});

test("ensureConnectAccount: creates the account with v2 accounts.create, the exact permanent parameters, an organization-derived idempotency key, and stores it only into an empty column", async () => {
  const db = makeFakeSupabase({ organizations: [org()] });
  const fake = makeFakeStripe({ v2AccountsCreate: () => v2Account({ card: "pending", payouts: "pending", requirements: [{ status: "currently_due" }] }) });
  assert.deepEqual(await ensureConnectAccount(db.client, ORG, { stripe: fake.stripe }), { ok: true, data: { accountId: ACCT, created: true } });

  assert.deepEqual(fake.calls.map((call) => call.method), ["v2.core.accounts.create"]);
  const [params, options] = fake.calls[0].args as [Stripe.V2.Core.AccountCreateParams, Stripe.RequestOptions];
  assert.deepEqual(params, buildConnectAccountCreateParams(ORG, "Acme Roofing"));
  assert.equal(params.dashboard, "full");
  assert.deepEqual(params.defaults?.responsibilities, { fees_collector: "stripe", losses_collector: "stripe" });
  assert.equal(params.configuration?.merchant?.capabilities?.card_payments?.requested, true);
  assert.equal(params.identity?.country, "us");
  assert.equal(options.idempotencyKey, `trackpr-connect-account-${ORG}`);

  const [update] = db.writes("organizations");
  assert.deepEqual(update.filters, [["eq", "id", ORG], ["is", "stripe_connect_account_id", null]]);
  const stored = update.payload as Row;
  assert.equal(stored.stripe_connect_account_id, ACCT);
  assert.deepEqual([stored.stripe_connect_charges_enabled, stored.stripe_connect_payouts_enabled, stored.stripe_connect_details_submitted], [false, false, false], "flags mapped from the v2 response");
});

test("idempotency: a double click reuses the same key, and Stripe's replay of that key returns the same account - one account, stored once", async () => {
  const db = makeFakeSupabase({ organizations: [org()] });
  const keysSeen = new Map<string, string>();
  const fake = makeFakeStripe({
    v2AccountsCreate: (_params, options) => {
      const key = options?.idempotencyKey ?? "";
      if (!keysSeen.has(key)) keysSeen.set(key, `acct_1Created${keysSeen.size}000000000`);
      return v2Account({ id: keysSeen.get(key) });
    },
  });
  // Two clicks racing: both see an empty column before either writes.
  const [first, second] = await Promise.all([ensureConnectAccount(db.client, ORG, { stripe: fake.stripe }), ensureConnectAccount(db.client, ORG, { stripe: fake.stripe })]);
  assert.equal(first.ok && second.ok, true);
  const keys = fake.calls.map((call) => (call.args[1] as Stripe.RequestOptions).idempotencyKey);
  assert.deepEqual(new Set(keys), new Set([`trackpr-connect-account-${ORG}`]), "the same key both times");
  assert.equal(keysSeen.size, 1, "Stripe created exactly one account");
  assert.equal(first.data?.accountId, second.data?.accountId);
  assert.equal(db.tables.organizations[0].stripe_connect_account_id, first.data?.accountId);
  assert.equal([first.data?.created, second.data?.created].filter(Boolean).length, 1, "only one request actually stored it");
});

test("ensureConnectAccount: a concurrent request that stored a DIFFERENT account first wins - its id is read back, never overwritten", async () => {
  const db = makeFakeSupabase({ organizations: [org()] });
  const fake = makeFakeStripe({
    v2AccountsCreate: () => {
      db.tables.organizations[0].stripe_connect_account_id = "acct_1WinnerAccount00001";
      return v2Account();
    },
  });
  assert.deepEqual(await ensureConnectAccount(db.client, ORG, { stripe: fake.stripe }), { ok: true, data: { accountId: "acct_1WinnerAccount00001", created: false } });
  assert.equal(db.tables.organizations[0].stripe_connect_account_id, "acct_1WinnerAccount00001");
});

test("ensureConnectAccount: a Stripe error, a malformed account id, or a missing organization stores nothing", async () => {
  const failing = makeFakeSupabase({ organizations: [org()] });
  const errorResult = await ensureConnectAccount(failing.client, ORG, { stripe: makeFakeStripe({ v2AccountsCreate: () => { throw stripeApiError("boom"); } }).stripe });
  assert.equal(errorResult.code, "stripe_unavailable");
  assert.equal(failing.writes().length, 0);

  const weird = makeFakeSupabase({ organizations: [org()] });
  const weirdResult = await ensureConnectAccount(weird.client, ORG, { stripe: makeFakeStripe({ v2AccountsCreate: () => v2Account({ id: "not-an-account" }) }).stripe });
  assert.equal(weirdResult.ok, false);
  assert.equal(weird.writes().length, 0);

  const missing = makeFakeSupabase({ organizations: [] });
  assert.equal((await ensureConnectAccount(missing.client, ORG, { stripe: makeFakeStripe().stripe })).code, "not_found");
});

test("the default Stripe client is the guarded one: a live key outside Vercel Production is refused before any request, and nothing is stored", async () => {
  const db = makeFakeSupabase({ organizations: [org()] });
  const result = await withStripeKey("sk_live_guard_unit_test_only", () => ensureConnectAccount(db.client, ORG));
  assert.equal(result.ok, false);
  assert.equal(db.writes().length, 0);
});

// ---------------------------------------------------------------------------
// Onboarding links (v2)
// ---------------------------------------------------------------------------

test("createConnectOnboardingLink: validates the URLs first, then creates a v2 account_onboarding link (merchant, currently_due) for the organization's account", async () => {
  const noCall = makeFakeStripe();
  const db0 = makeFakeSupabase({ organizations: [org({ stripe_connect_account_id: ACCT })] });
  assert.equal((await createConnectOnboardingLink(db0.client, ORG, { returnUrl: "javascript:alert(1)", refreshUrl: URLS.refreshUrl }, { stripe: noCall.stripe })).ok, false);
  assert.equal(noCall.calls.length, 0);

  const db = makeFakeSupabase({ organizations: [org({ stripe_connect_account_id: ACCT })] });
  const fake = makeFakeStripe({ v2AccountLinksCreate: () => ({ url: LINK_URL }) });
  assert.deepEqual(await createConnectOnboardingLink(db.client, ORG, URLS, { stripe: fake.stripe }), { ok: true, data: { url: LINK_URL, accountId: ACCT } });
  assert.deepEqual(fake.calls.map((call) => call.method), ["v2.core.accountLinks.create"]);
  assert.deepEqual(fake.calls[0].args[0], {
    account: ACCT,
    use_case: { type: "account_onboarding", account_onboarding: { configurations: ["merchant"], collection_options: { fields: "currently_due" }, return_url: URLS.returnUrl, refresh_url: URLS.refreshUrl } },
  });
});

test("createConnectOnboardingLink: creates the account first when none exists; a link failure is reported and the account is kept", async () => {
  const db = makeFakeSupabase({ organizations: [org()] });
  const fake = makeFakeStripe({ v2AccountsCreate: () => v2Account({ card: "pending" }), v2AccountLinksCreate: () => { throw stripeApiError("link failed"); } });
  const result = await createConnectOnboardingLink(db.client, ORG, URLS, { stripe: fake.stripe });
  assert.equal(result.code, "stripe_unavailable");
  assert.deepEqual(fake.calls.map((call) => call.method), ["v2.core.accounts.create", "v2.core.accountLinks.create"]);
  assert.equal(db.tables.organizations[0].stripe_connect_account_id, ACCT);
});

test("refreshConnectOnboardingLink: a new link for the EXISTING account only - it never creates an account", async () => {
  const db = makeFakeSupabase({ organizations: [org({ stripe_connect_account_id: ACCT })] });
  const fake = makeFakeStripe({ v2AccountLinksCreate: () => ({ url: LINK_URL }) });
  assert.deepEqual(await refreshConnectOnboardingLink(db.client, ORG, URLS, { stripe: fake.stripe }), { ok: true, data: { url: LINK_URL, accountId: ACCT } });
  assert.deepEqual(fake.calls.map((call) => call.method), ["v2.core.accountLinks.create"]);
  assert.equal((fake.calls[0].args[0] as Stripe.V2.Core.AccountLinkCreateParams).account, ACCT);
  assert.equal(db.writes().length, 0);

  const none = makeFakeSupabase({ organizations: [org()] });
  const untouched = makeFakeStripe();
  const result = await refreshConnectOnboardingLink(none.client, ORG, URLS, { stripe: untouched.stripe });
  assert.equal(result.code, "not_connected");
  assert.equal(untouched.calls.length, 0, "no account created, no link created");
  assert.equal(none.writes().length, 0);

  assert.equal((await refreshConnectOnboardingLink(makeFakeSupabase({ organizations: [] }).client, ORG, URLS, { stripe: untouched.stripe })).code, "not_found");
  assert.equal((await refreshConnectOnboardingLink(db.client, ORG, { ...URLS, refreshUrl: "ftp://x" }, { stripe: untouched.stripe })).code, "invalid_request");
});

// ---------------------------------------------------------------------------
// Sync (v2 retrieve)
// ---------------------------------------------------------------------------

test("syncConnectAccountStatus: re-reads the stored account with v2 accounts.retrieve (include merchant + requirements) and stores the mapped flags, scoped to that account id", async () => {
  const db = makeFakeSupabase({ organizations: [org({ stripe_connect_account_id: ACCT })] });
  const fake = makeFakeStripe({ v2AccountsRetrieve: () => v2Account({ card: "active", payouts: "pending", requirements: [{ status: "eventually_due" }] }) });
  const result = await syncConnectAccountStatus(db.client, ORG, { stripe: fake.stripe });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual({ ...result.data, syncedAt: typeof result.data.syncedAt }, { accountId: ACCT, chargesEnabled: true, payoutsEnabled: false, detailsSubmitted: true, syncedAt: "string" });
  assert.deepEqual(fake.calls[0], { method: "v2.core.accounts.retrieve", args: [ACCT, { include: ["configuration.merchant", "requirements"] }] });
  const [update] = db.writes("organizations");
  assert.deepEqual(update.filters, [["eq", "id", ORG], ["eq", "stripe_connect_account_id", ACCT]]);
  assert.equal("stripe_connect_account_id" in (update.payload as Row), false, "sync never changes the account id itself");
});

test("syncConnectAccountStatus: refuses an account whose metadata names another organization or whose id differs (account_mismatch), and an organization with no account", async () => {
  for (const account of [v2Account({ organizationId: OTHER_ORG }), v2Account({ id: "acct_1SomeoneElse0000000" })]) {
    const db = makeFakeSupabase({ organizations: [org({ stripe_connect_account_id: ACCT })] });
    const mismatch = await syncConnectAccountStatus(db.client, ORG, { stripe: makeFakeStripe({ v2AccountsRetrieve: () => account }).stripe });
    assert.equal(mismatch.code, "account_mismatch");
    assert.equal(db.writes().length, 0);
  }

  const none = makeFakeSupabase({ organizations: [org()] });
  const untouched = makeFakeStripe();
  assert.deepEqual(await syncConnectAccountStatus(none.client, ORG, { stripe: untouched.stripe }), { ok: false, error: "Stripe has not been connected yet.", code: "not_connected" });
  assert.equal(untouched.calls.length, 0);
});

test("syncConnectAccountStatus: Stripe unreachable -> stripe_unavailable, nothing stored", async () => {
  const db = makeFakeSupabase({ organizations: [org({ stripe_connect_account_id: ACCT })] });
  const result = await syncConnectAccountStatus(db.client, ORG, { stripe: makeFakeStripe({ v2AccountsRetrieve: () => { throw stripeApiError("down"); } }).stripe });
  assert.equal(result.code, "stripe_unavailable");
  assert.equal(db.writes().length, 0);
});

test("syncConnectAccountById (account.updated): resolves the organization from the stored account id and re-reads Stripe; unknown or malformed accounts are never adopted", async () => {
  const db = makeFakeSupabase({ organizations: [org({ stripe_connect_account_id: ACCT })] });
  const fake = makeFakeStripe({ v2AccountsRetrieve: () => v2Account({ card: "active" }) });
  const result = await syncConnectAccountById(db.client, ACCT, { stripe: fake.stripe });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.data.organizationId, ORG);
  assert.equal(db.tables.organizations[0].stripe_connect_charges_enabled, true);

  const unknown = makeFakeStripe();
  assert.deepEqual(await syncConnectAccountById(db.client, "acct_1NobodyOwnsThis0000", { stripe: unknown.stripe }), { ok: false, error: "unknown_account", code: "unknown_account" });
  assert.deepEqual(await syncConnectAccountById(db.client, "bogus", { stripe: unknown.stripe }), { ok: false, error: "unknown_account", code: "unknown_account" });
  assert.equal(unknown.calls.length, 0);
});

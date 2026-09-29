/**
 * Phase 1C (W2 backstop): unit tests for lib/payments/connect-backstop.ts - the
 * Settings-time refresh of an incomplete stored Connect status. Fake Supabase
 * and a v2-only fake Stripe. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/payments/connect-backstop.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { makeFakeStripe, makeFakeSupabase, stripeApiError, v2Account, withStripeKey, type Row } from "./test-fakes";
import type { ConnectStatus } from "./connect";

const require = createRequire(import.meta.url);
const { needsBackstopRefresh, refreshStaleConnectStatus, REFRESH_INTERVAL_MS }: typeof import("./connect-backstop") = require("./connect-backstop.ts");

const ORG = "11111111-1111-4111-8111-111111111111";
const ACCT = "acct_1TestConnect000001";
const NOW = new Date("2026-09-29T02:00:00.000Z");
const LONG_AGO = new Date(NOW.getTime() - 10 * 60_000).toISOString();

function status(overrides: Partial<ConnectStatus> = {}): ConnectStatus {
  return { accountId: ACCT, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: true, syncedAt: LONG_AGO, ...overrides };
}

function org(overrides: Partial<Row> = {}): Row {
  return { id: ORG, stripe_connect_account_id: ACCT, stripe_connect_charges_enabled: false, stripe_connect_payouts_enabled: false, stripe_connect_details_submitted: true, stripe_connect_synced_at: LONG_AGO, ...overrides };
}

test("needsBackstopRefresh: only a connected account whose stored state is incomplete, and only when the last sync is at least a minute old", () => {
  assert.equal(needsBackstopRefresh(null, NOW), false, "no status");
  assert.equal(needsBackstopRefresh(status({ accountId: null }), NOW), false, "not connected: nothing to refresh (and no account is ever created)");
  assert.equal(needsBackstopRefresh(status({ chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true }), NOW), false, "fully enabled: never re-fetched on a view");
  assert.equal(needsBackstopRefresh(status(), NOW), true, "charges off, synced long ago");
  assert.equal(needsBackstopRefresh(status({ chargesEnabled: true, payoutsEnabled: false }), NOW), true, "payouts still off");
  assert.equal(needsBackstopRefresh(status({ chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: false }), NOW), true, "details outstanding");
  assert.equal(needsBackstopRefresh(status({ syncedAt: null }), NOW), true, "never synced");
  assert.equal(needsBackstopRefresh(status({ syncedAt: new Date(NOW.getTime() - (REFRESH_INTERVAL_MS - 1)).toISOString() }), NOW), false, "synced within the last minute: throttled");
  assert.equal(needsBackstopRefresh(status({ syncedAt: new Date(NOW.getTime() - REFRESH_INTERVAL_MS).toISOString() }), NOW), true, "exactly a minute ago");
  assert.equal(needsBackstopRefresh(status({ syncedAt: "not a date" }), NOW), true, "unreadable timestamp is treated as stale");
});

test("backstop sync: an incomplete, stale status is refreshed from a fresh Accounts v2 retrieve and stored", async () => {
  const db = makeFakeSupabase({ organizations: [org()] });
  const fake = makeFakeStripe({ v2AccountsRetrieve: () => v2Account({ card: "active", payouts: "active", requirements: [] }) });
  const result = await refreshStaleConnectStatus(db.client, ORG, status(), { stripe: fake.stripe, now: NOW });
  assert.equal(result.refreshed, true);
  assert.equal(result.refreshFailed, false);
  assert.deepEqual([result.status?.chargesEnabled, result.status?.payoutsEnabled, result.status?.detailsSubmitted], [true, true, true]);
  assert.deepEqual(fake.calls.map((call) => call.method), ["v2.core.accounts.retrieve"], "a v2 re-fetch only");
  assert.equal(db.tables.organizations[0].stripe_connect_charges_enabled, true);
  assert.notEqual(db.tables.organizations[0].stripe_connect_synced_at, LONG_AGO);
});

test("the backstop never creates an account and never creates an onboarding link - not connected means no Stripe call at all", async () => {
  const db = makeFakeSupabase({ organizations: [org({ stripe_connect_account_id: null })] });
  const fake = makeFakeStripe();
  const result = await refreshStaleConnectStatus(db.client, ORG, status({ accountId: null }), { stripe: fake.stripe, now: NOW });
  assert.deepEqual(result, { status: status({ accountId: null }), refreshed: false, refreshFailed: false });
  assert.equal(fake.calls.length, 0);
  assert.equal(db.calls.length, 0);

  // Even when it does refresh, the only Stripe method it touches is retrieve.
  const db2 = makeFakeSupabase({ organizations: [org()] });
  const fake2 = makeFakeStripe({ v2AccountsRetrieve: () => v2Account({ card: "pending" }) });
  await refreshStaleConnectStatus(db2.client, ORG, status(), { stripe: fake2.stripe, now: NOW });
  assert.equal(fake2.calls.some((call) => call.method === "v2.core.accounts.create" || call.method === "v2.core.accountLinks.create"), false);
});

test("no Stripe request loop: a fully enabled or recently synced status is returned untouched with no Stripe or database call", async () => {
  for (const current of [status({ chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true }), status({ syncedAt: new Date(NOW.getTime() - 5_000).toISOString() })]) {
    const db = makeFakeSupabase({ organizations: [org()] });
    const fake = makeFakeStripe();
    const result = await refreshStaleConnectStatus(db.client, ORG, current, { stripe: fake.stripe, now: NOW });
    assert.deepEqual(result, { status: current, refreshed: false, refreshFailed: false });
    assert.equal(fake.calls.length, 0);
    assert.equal(db.calls.length, 0);
  }
});

test("Stripe unreachable: the stored status is preserved unchanged and refreshFailed is set - no Stripe text is returned", async () => {
  const db = makeFakeSupabase({ organizations: [org()] });
  const fake = makeFakeStripe({ v2AccountsRetrieve: () => { throw stripeApiError("No such account XYZZY-STRIPE-TEXT"); } });
  const current = status();
  const result = await refreshStaleConnectStatus(db.client, ORG, current, { stripe: fake.stripe, now: NOW });
  assert.deepEqual(result, { status: current, refreshed: false, refreshFailed: true });
  assert.equal(db.writes().length, 0);
  assert.equal(JSON.stringify(result).includes("XYZZY"), false);
});

test("an ownership mismatch is not stored (fails closed through the shared sync) and is reported as a failed refresh", async () => {
  const db = makeFakeSupabase({ organizations: [org()] });
  const fake = makeFakeStripe({ v2AccountsRetrieve: () => v2Account({ organizationId: "22222222-2222-4222-8222-222222222222" }) });
  const result = await refreshStaleConnectStatus(db.client, ORG, status(), { stripe: fake.stripe, now: NOW });
  assert.equal(result.refreshFailed, true);
  assert.equal(db.writes().length, 0);
});

test("guarded client: with a live key outside Vercel Production the backstop can't reach Stripe and keeps the stored status", async () => {
  const db = makeFakeSupabase({ organizations: [org()] });
  const current = status();
  const result = await withStripeKey("sk_live_guard_unit_test_only", () => refreshStaleConnectStatus(db.client, ORG, current, { now: NOW }));
  assert.deepEqual(result, { status: current, refreshed: false, refreshFailed: true });
  assert.equal(db.writes().length, 0);
});

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("structural: the backstop calls only the shared sync; Settings runs it for owners/admins only; the pay page never calls Stripe", () => {
  const backstop = read("lib/payments/connect-backstop.ts");
  assert.match(backstop, /syncConnectAccountStatus\(service, organizationId, \{ stripe: options\.stripe \}\)/);
  assert.doesNotMatch(backstop, /ensureConnectAccount|createConnectOnboardingLink|refreshConnectOnboardingLink|accounts\.create|accountLinks|paymentsStripe/);

  const page = read("app/(app)/settings/page.tsx");
  assert.match(page, /const connectBackstop = canEdit\s*\?\s*await refreshStaleConnectStatus\(createServiceRoleClient\(\), organizationId, storedConnectStatus\)\s*:\s*\{ status: storedConnectStatus, refreshed: false, refreshFailed: false \};/);

  for (const file of ["app/pay/[token]/page.tsx", "lib/payments/public-invoice.ts", "lib/payments/pay-page-view.ts"]) {
    assert.doesNotMatch(read(file), /refreshStaleConnectStatus|syncConnect|paymentsStripe|getPaymentsStripeClient/, `${file} makes no Stripe call`);
  }
});

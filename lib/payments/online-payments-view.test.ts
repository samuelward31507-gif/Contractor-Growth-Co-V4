/**
 * Phase 1C, Step 4: unit tests for lib/payments/online-payments-view.ts - the
 * state, copy and banners of the Settings "Online payments" section. Pure
 * functions, no I/O. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/payments/online-payments-view.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { describeOnlinePayments, onlinePaymentsBanner }: typeof import("./online-payments-view") = require("./online-payments-view.ts");

const ACCT = "acct_1TestConnect000001";
const connected = (overrides: Partial<{ chargesEnabled: boolean; payoutsEnabled: boolean }> = {}) => ({ accountId: ACCT, chargesEnabled: true, payoutsEnabled: true, ...overrides });

test("not connected: admins get Connect Stripe; members get no action and a clear note", () => {
  for (const status of [null, { accountId: null, chargesEnabled: false, payoutsEnabled: false }]) {
    const view = describeOnlinePayments({ status, paymentStatus: "active", canEdit: true });
    assert.equal(view.state, "not_connected");
    assert.deepEqual(view.action, { label: "Connect Stripe" });
    assert.equal(view.badge, null);
    assert.equal(view.showDashboardLink, false);
  }
  const member = describeOnlinePayments({ status: null, paymentStatus: "active", canEdit: false });
  assert.equal(member.action, null);
  assert.equal(member.detail, "Only owners and admins can connect Stripe.");
});

test("connected but Stripe can't take charges yet: Finish setup", () => {
  const view = describeOnlinePayments({ status: connected({ chargesEnabled: false, payoutsEnabled: false }), paymentStatus: "active", canEdit: true });
  assert.equal(view.state, "onboarding_incomplete");
  assert.deepEqual(view.badge, { tone: "warning", label: "Setup incomplete" });
  assert.deepEqual(view.action, { label: "Finish setup" });
  assert.equal(describeOnlinePayments({ status: connected({ chargesEnabled: false }), paymentStatus: "active", canEdit: false }).action, null);
});

test("accepting card payments ONLY when charges are enabled AND the Trackpr subscription is active (canAcceptOnlinePayments)", () => {
  const view = describeOnlinePayments({ status: connected(), paymentStatus: "active", canEdit: true });
  assert.equal(view.state, "accepting");
  assert.deepEqual(view.badge, { tone: "success", label: "Accepting card payments" });
  assert.equal(view.action, null, "nothing left to do");
  assert.equal(view.showDashboardLink, true);
  assert.equal(view.detail, null);

  for (const paymentStatus of ["suspended", "cancelled", "payment_required"]) {
    const paused = describeOnlinePayments({ status: connected(), paymentStatus, canEdit: true });
    assert.equal(paused.state, "paused", paymentStatus);
    assert.deepEqual(paused.badge, { tone: "warning", label: "Paused" });
    assert.equal(paused.action, null);
  }
});

test("payouts not yet enabled is called out, without blocking charges", () => {
  const view = describeOnlinePayments({ status: connected({ payoutsEnabled: false }), paymentStatus: "active", canEdit: true });
  assert.equal(view.state, "accepting");
  assert.match(view.detail ?? "", /bank details/);
});

test("the view never contains the Stripe account id", () => {
  for (const status of [null, connected({ chargesEnabled: false }), connected()]) {
    assert.equal(JSON.stringify(describeOnlinePayments({ status, paymentStatus: "active", canEdit: true })).includes(ACCT), false);
  }
});

test("banners: fixed vocabulary only; unknown values never render raw input", () => {
  assert.deepEqual(onlinePaymentsBanner({ payments: "connected" }), { tone: "success", message: "Stripe is connected. Customers can now pay your invoices by card." });
  assert.equal(onlinePaymentsBanner({ payments: "incomplete" })?.tone, "info");
  assert.equal(onlinePaymentsBanner({ payments: "expired" })?.tone, "info");
  for (const reason of ["invalid_request", "not_authorized", "subscription_inactive", "stripe_unavailable", "not_connected", "sync_failed"]) {
    const banner = onlinePaymentsBanner({ payments: "error", reason });
    assert.equal(banner?.tone, "error", reason);
    assert.notEqual(banner?.message, "We couldn't connect Stripe. Please try again.", `${reason} has its own message`);
  }
  const injected = onlinePaymentsBanner({ payments: "error", reason: "<script>alert(1)</script>" });
  assert.equal(injected?.message, "We couldn't connect Stripe. Please try again.");
  assert.equal(onlinePaymentsBanner({ payments: "<b>hi</b>" }), null);
  assert.equal(onlinePaymentsBanner({}), null);
  assert.equal(onlinePaymentsBanner({ payments: ["connected", "error"] }), null, "a repeated parameter is ignored");
  assert.equal(onlinePaymentsBanner({ calendar: "connected" }), null, "the calendar banner's parameter is not this banner's");
});

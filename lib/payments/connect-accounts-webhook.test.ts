/**
 * Phase 1C (W2): unit tests for lib/payments/connect-accounts-webhook.ts - the
 * Accounts v2 thin-event webhook. Signatures and parsing are REAL: payloads
 * are signed with the SDK's local HMAC helper and parsed by the guarded
 * client's own parseEventNotification (placeholder sk_test_ key, no
 * network). Supabase and the v2 account retrieve are fakes. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/payments/connect-accounts-webhook.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { makeFakeStripe, makeFakeSupabase, stripeApiError, v2Account, withStripeKey, type FakeStripeBehavior, type Row } from "./test-fakes";

const require = createRequire(import.meta.url);
const { handleConnectAccountsWebhook, HANDLED_V2_ACCOUNT_EVENT_TYPES }: typeof import("./connect-accounts-webhook") = require("./connect-accounts-webhook.ts");
const { getPaymentsStripeClient }: typeof import("@/lib/billing/stripe-mode-guard") = require("../billing/stripe-mode-guard.ts");

const SECRET = "whsec_connect_accounts_unit_tests_only";
const ENV = { STRIPE_CONNECT_ACCOUNTS_WEBHOOK_SECRET: SECRET } as unknown as NodeJS.ProcessEnv;
const signer = getPaymentsStripeClient({ STRIPE_SECRET_KEY: "sk_test_placeholder_connect_accounts_tests" } as unknown as NodeJS.ProcessEnv);

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const ACCT = "acct_1TestConnect000001";
const OTHER_ACCT = "acct_1OtherOrg0000000001";
const CAPABILITY = "v2.core.account[configuration.merchant].capability_status_updated";
const REQUIREMENTS = "v2.core.account[requirements].updated";

function organizations(): Row[] {
  return [
    { id: ORG, stripe_connect_account_id: ACCT, stripe_connect_charges_enabled: false, stripe_connect_payouts_enabled: false, stripe_connect_details_submitted: false, stripe_connect_synced_at: null },
    { id: OTHER_ORG, stripe_connect_account_id: OTHER_ACCT, stripe_connect_charges_enabled: false, stripe_connect_payouts_enabled: false, stripe_connect_details_submitted: false, stripe_connect_synced_at: null },
  ];
}

/** A thin event notification exactly as Stripe documents it (object v2.core.event, context null for the platform's own accounts, account in related_object). */
function thinEvent(type: string, options: { accountId?: string; relatedType?: string; context?: string | null; related?: unknown } = {}): string {
  const accountId = options.accountId ?? ACCT;
  const event: Record<string, unknown> = {
    id: `evt_test_${Math.random().toString(36).slice(2)}`,
    object: "v2.core.event",
    type,
    created: "2026-09-29T01:38:41.385Z",
    livemode: false,
    context: options.context === undefined ? null : options.context,
    related_object: options.related !== undefined ? options.related : { id: accountId, type: options.relatedType ?? "v2.core.account", url: `/v2/core/accounts/${accountId}` },
  };
  return JSON.stringify(event);
}

function signedRequest(payload: string, options: { secret?: string; signature?: string | null } = {}): Request {
  const headers = new Headers({ "content-type": "application/json" });
  const signature = options.signature === undefined ? signer.webhooks.generateTestHeaderString({ payload, secret: options.secret ?? SECRET }) : options.signature;
  if (signature !== null) headers.set("stripe-signature", signature);
  return new Request("http://localhost:3000/api/webhooks/stripe-connect/accounts", { method: "POST", headers, body: payload });
}

function setup(stripeBehavior: FakeStripeBehavior = {}, options: { updateFails?: boolean } = {}) {
  const tables = { organizations: organizations() };
  const db = makeFakeSupabase(tables);
  if (options.updateFails) {
    // Make every organizations update fail the way PostgREST would.
    const from = db.client.from.bind(db.client);
    (db.client as unknown as { from: (t: string) => unknown }).from = (table: string) => {
      const builder = from(table) as unknown as Record<string, unknown>;
      const update = builder.update as (patch: unknown) => Record<string, unknown>;
      builder.update = (patch: unknown) => {
        const b = update(patch);
        b.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: { code: "XX000", message: "storage down" } });
        return b;
      };
      return builder;
    };
  }
  const stripe = makeFakeStripe({
    v2AccountsRetrieve: () => v2Account({ card: "active", payouts: "active", requirements: [] }),
    ...stripeBehavior,
    webhooks: signer.webhooks,
    parseEventNotification: signer.parseEventNotification.bind(signer),
  });
  let serviceCreated = 0;
  const deps = { createService: () => ((serviceCreated += 1), db.client), stripe: stripe.stripe, env: ENV };
  return { db, stripe, deps, serviceCreated: () => serviceCreated };
}

async function body(response: Response) {
  return (await response.json()) as { ok: boolean; outcome: string; reason?: string };
}

// ---------------------------------------------------------------------------
// Handled events
// ---------------------------------------------------------------------------

test("the handled event types are exactly the two v2 account events", () => {
  assert.deepEqual([...HANDLED_V2_ACCOUNT_EVENT_TYPES], [CAPABILITY, REQUIREMENTS]);
});

test("a valid capability_status_updated event re-fetches the account through Accounts v2 (by related_object.id) and stores the mapped flags", async () => {
  const ctx = setup();
  const response = await handleConnectAccountsWebhook(signedRequest(thinEvent(CAPABILITY)), ctx.deps);
  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), { ok: true, outcome: "synced" });
  assert.deepEqual(ctx.stripe.calls.map((call) => call.method), ["v2.core.accounts.retrieve"]);
  assert.deepEqual(ctx.stripe.calls[0].args, [ACCT, { include: ["configuration.merchant", "requirements"] }]);
  const org = ctx.db.tables.organizations[0];
  assert.deepEqual([org.stripe_connect_charges_enabled, org.stripe_connect_payouts_enabled, org.stripe_connect_details_submitted], [true, true, true]);
  assert.ok(org.stripe_connect_synced_at);
  const other = ctx.db.tables.organizations[1];
  assert.equal(other.stripe_connect_charges_enabled, false, "the other organization is untouched");
  const lookup = ctx.db.calls.find((call) => call.table === "organizations" && call.op === "select");
  assert.deepEqual(lookup?.filters, [["eq", "stripe_connect_account_id", ACCT]], "the organization comes only from the stored account id");
});

test("a valid requirements.updated event syncs too, storing whatever the fresh account says (here: still incomplete)", async () => {
  const ctx = setup({ v2AccountsRetrieve: () => v2Account({ card: "restricted", payouts: "restricted", requirements: [{ status: "past_due" }] }) });
  const response = await handleConnectAccountsWebhook(signedRequest(thinEvent(REQUIREMENTS)), ctx.deps);
  assert.deepEqual(await body(response), { ok: true, outcome: "synced" });
  const org = ctx.db.tables.organizations[0];
  assert.deepEqual([org.stripe_connect_charges_enabled, org.stripe_connect_payouts_enabled, org.stripe_connect_details_submitted], [false, false, false]);
});

test("a duplicate/replayed event is idempotent: the same fresh state is stored again, nothing else changes", async () => {
  const ctx = setup();
  const payload = thinEvent(CAPABILITY);
  for (let i = 0; i < 2; i += 1) assert.deepEqual(await body(await handleConnectAccountsWebhook(signedRequest(payload), ctx.deps)), { ok: true, outcome: "synced" });
  const org = ctx.db.tables.organizations[0];
  assert.deepEqual([org.stripe_connect_account_id, org.stripe_connect_charges_enabled, org.stripe_connect_payouts_enabled, org.stripe_connect_details_submitted], [ACCT, true, true, true]);
  assert.equal(ctx.db.tables.organizations.length, 2);
  for (const write of ctx.db.writes()) assert.equal("stripe_connect_account_id" in (write.payload as Row), false, "a sync never rewrites the account id");
});

// ---------------------------------------------------------------------------
// Signature, configuration, method
// ---------------------------------------------------------------------------

test("an invalid, tampered or missing signature is 400 before any database or Stripe API work", async () => {
  const payload = thinEvent(CAPABILITY);
  const cases: [string, Request][] = [
    ["wrong secret", signedRequest(payload, { secret: "whsec_someone_else" })],
    ["tampered payload", signedRequest(payload.replace(ACCT, OTHER_ACCT), { signature: signer.webhooks.generateTestHeaderString({ payload, secret: SECRET }) })],
    ["garbage", signedRequest(payload, { signature: "t=1,v1=deadbeef" })],
    ["missing header", signedRequest(payload, { signature: null })],
  ];
  for (const [label, request] of cases) {
    const ctx = setup();
    const response = await handleConnectAccountsWebhook(request, ctx.deps);
    assert.equal(response.status, 400, label);
    assert.deepEqual(await body(response), { ok: false, outcome: "invalid_signature" });
    assert.equal(ctx.serviceCreated(), 0, label);
    assert.equal(ctx.stripe.calls.length, 0, label);
  }
});

test("a missing STRIPE_CONNECT_ACCOUNTS_WEBHOOK_SECRET is 500 (retry after configuration); the snapshot webhook's secret is never used", async () => {
  const ctx = setup();
  const env = { STRIPE_CONNECT_WEBHOOK_SECRET: SECRET, STRIPE_WEBHOOK_SECRET: SECRET } as unknown as NodeJS.ProcessEnv;
  const response = await handleConnectAccountsWebhook(signedRequest(thinEvent(CAPABILITY)), { ...ctx.deps, env });
  assert.equal(response.status, 500);
  assert.deepEqual(await body(response), { ok: false, outcome: "not_configured" });
  assert.equal(ctx.serviceCreated(), 0);
});

test("live key refusal: with the real guarded client and a live key outside Vercel Production, 500 before anything is verified or read", async () => {
  const db = makeFakeSupabase({ organizations: organizations() });
  let serviceCreated = 0;
  const response = await withStripeKey("sk_live_guard_unit_test_only", () => handleConnectAccountsWebhook(signedRequest(thinEvent(CAPABILITY)), { createService: () => ((serviceCreated += 1), db.client), env: ENV }));
  assert.equal(response.status, 500);
  assert.deepEqual(await body(response), { ok: false, outcome: "not_configured" });
  assert.equal(serviceCreated, 0);
});

test("only POST", async () => {
  const ctx = setup();
  assert.equal((await handleConnectAccountsWebhook(new Request("http://localhost:3000/api/webhooks/stripe-connect/accounts"), ctx.deps)).status, 405);
});

// ---------------------------------------------------------------------------
// Ignored (200, no retry can help)
// ---------------------------------------------------------------------------

test("unknown event types are ignored with 200 - no database or Stripe API call", async () => {
  for (const type of ["v2.core.account.updated", "v2.core.account[identity].updated", "v2.core.account[configuration.customer].capability_status_updated", "v2.core.account_link.returned", "v1.billing.meter.no_meter_found"]) {
    const ctx = setup();
    const response = await handleConnectAccountsWebhook(signedRequest(thinEvent(type)), ctx.deps);
    assert.deepEqual(await body(response), { ok: true, outcome: "ignored", reason: "unhandled_event_type" }, type);
    assert.equal(ctx.serviceCreated(), 0);
    assert.equal(ctx.stripe.calls.length, 0);
  }
});

test("a missing or invalid related_object is ignored with 200, never guessed", async () => {
  const cases: [string, string][] = [
    ["no related_object", thinEvent(CAPABILITY, { related: null })],
    ["not an account", thinEvent(CAPABILITY, { relatedType: "v2.core.account_person" })],
    ["malformed id", thinEvent(CAPABILITY, { accountId: "not-an-account" })],
    ["empty object", thinEvent(CAPABILITY, { related: {} })],
  ];
  for (const [label, payload] of cases) {
    const ctx = setup();
    const response = await handleConnectAccountsWebhook(signedRequest(payload), ctx.deps);
    assert.deepEqual(await body(response), { ok: true, outcome: "ignored", reason: "invalid_related_object" }, label);
    assert.equal(ctx.serviceCreated(), 0, label);
  }
});

test("an event raised in a connected-account context (not one of the platform's own merchant accounts) is ignored", async () => {
  const ctx = setup();
  const response = await handleConnectAccountsWebhook(signedRequest(thinEvent(CAPABILITY, { context: OTHER_ACCT })), ctx.deps);
  assert.deepEqual(await body(response), { ok: true, outcome: "ignored", reason: "not_platform_event" });
  assert.equal(ctx.serviceCreated(), 0);
});

test("an unknown account (no organization stores it) is ignored with 200 - never adopted, Stripe never called", async () => {
  const ctx = setup();
  const response = await handleConnectAccountsWebhook(signedRequest(thinEvent(CAPABILITY, { accountId: "acct_1NobodyOwnsThis0000" })), ctx.deps);
  assert.deepEqual(await body(response), { ok: true, outcome: "ignored", reason: "unknown_account" });
  assert.equal(ctx.stripe.calls.length, 0);
  assert.equal(ctx.db.writes().length, 0);
});

test("a signed payload that is a v1 snapshot event (misrouted) is ignored with 200 - parseEventNotification refuses it", async () => {
  const ctx = setup();
  const v1 = JSON.stringify({ id: "evt_1", object: "event", type: "account.updated", account: ACCT, data: { object: { id: ACCT } } });
  const response = await handleConnectAccountsWebhook(signedRequest(v1), ctx.deps);
  assert.deepEqual(await body(response), { ok: true, outcome: "ignored", reason: "not_a_thin_event" });
  assert.equal(ctx.serviceCreated(), 0);
});

// ---------------------------------------------------------------------------
// Retry vs non-retry
// ---------------------------------------------------------------------------

test("retry classification: Stripe retrieve failure and storage failure are 500 (retry helps); an ownership mismatch is 200 not_applied (retry can't help)", async () => {
  const down = setup({ v2AccountsRetrieve: () => { throw stripeApiError("connection reset"); } });
  const downResponse = await handleConnectAccountsWebhook(signedRequest(thinEvent(CAPABILITY)), down.deps);
  assert.equal(downResponse.status, 500);
  assert.deepEqual(await body(downResponse), { ok: false, outcome: "retry", reason: "stripe_unavailable" });
  assert.equal(down.db.writes().length, 0, "stored state preserved");

  const storage = setup({}, { updateFails: true });
  const storageResponse = await handleConnectAccountsWebhook(signedRequest(thinEvent(CAPABILITY)), storage.deps);
  assert.equal(storageResponse.status, 500);
  assert.deepEqual(await body(storageResponse), { ok: false, outcome: "retry", reason: "storage_failed" });

  const mismatch = setup({ v2AccountsRetrieve: () => v2Account({ organizationId: OTHER_ORG }) });
  const mismatchResponse = await handleConnectAccountsWebhook(signedRequest(thinEvent(CAPABILITY)), mismatch.deps);
  assert.equal(mismatchResponse.status, 200);
  assert.deepEqual(await body(mismatchResponse), { ok: false, outcome: "not_applied", reason: "account_mismatch" });
  assert.equal(mismatch.db.writes().length, 0, "fails closed");
});

test("responses never carry account ids, organization ids, event ids or Stripe error text", async () => {
  const ctx = setup({ v2AccountsRetrieve: () => { throw stripeApiError(`No such account: ${ACCT} XYZZY-STRIPE-TEXT`); } });
  const payload = thinEvent(CAPABILITY);
  const eventId = JSON.parse(payload).id as string;
  const text = await (await handleConnectAccountsWebhook(signedRequest(payload), ctx.deps)).text();
  for (const secret of [ACCT, ORG, eventId, "XYZZY-STRIPE-TEXT", "No such account"]) assert.equal(text.includes(secret), false, secret);
});

// ---------------------------------------------------------------------------
// Structural
// ---------------------------------------------------------------------------

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("structural: the route exports POST only and wires the handler; the handler uses parseEventNotification, its own secret, the guarded client, and syncConnectAccountById", () => {
  const route = read("app/api/webhooks/stripe-connect/accounts/route.ts");
  assert.match(route, /export async function POST\(/);
  assert.doesNotMatch(route, /export (async )?function (GET|PUT|PATCH|DELETE)\b/);
  assert.match(route, /handleConnectAccountsWebhook\(request, \{ createService: createServiceRoleClient \}\)/);
  assert.doesNotMatch(route, /from "stripe"|getStripeClient|new\s+Stripe\s*\(/);

  const handler = read("lib/payments/connect-accounts-webhook.ts");
  assert.match(handler, /stripe\.parseEventNotification\(rawBody, signature, secret\)/);
  assert.match(handler, /\.STRIPE_CONNECT_ACCOUNTS_WEBHOOK_SECRET\b/);
  assert.doesNotMatch(handler, /STRIPE_CONNECT_WEBHOOK_SECRET\b|STRIPE_WEBHOOK_SECRET\b/, "never another endpoint's secret");
  assert.match(handler, /syncConnectAccountById\(deps\.createService\(\), accountId, \{ stripe: deps\.stripe \}\)/);
  assert.doesNotMatch(handler, /statusFromV2Account|\.update\(|getStripeClient|new\s+Stripe\s*\(|metadata/, "no duplicated status logic, no direct writes, metadata never selects the organization");
});

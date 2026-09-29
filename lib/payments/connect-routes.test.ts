/**
 * Phase 1C, Step 4: unit tests for the Stripe Connect onboarding routes -
 * lib/payments/connect-routes.ts (all the logic) and the two thin route files
 * that wire it. Fake session, fake Supabase and fake Stripe only: no network,
 * no .env.local, no real key. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/payments/connect-routes.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type Stripe from "stripe";
import { makeFakeStripe, makeFakeSupabase, stripeApiError, v2Account, withStripeKey, type Row } from "./test-fakes";
import type { ConnectRouteSession } from "./connect-routes";

const require = createRequire(import.meta.url);
const { handleConnectRefresh, handleConnectReturn, handleConnectStart, isSameOriginPost, isTopLevelNavigation }: typeof import("./connect-routes") = require("./connect-routes.ts");

const ORIGIN = "http://localhost:3000";
const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const ACCT = "acct_1TestConnect000001";
const ONBOARDING_URL = "https://accounts.stripe.com/r/acct_1TestConnect000001#alu_test_link";

function org(overrides: Partial<Row> = {}): Row {
  return { id: ORG, stripe_connect_account_id: null, stripe_connect_charges_enabled: false, stripe_connect_payouts_enabled: false, stripe_connect_details_submitted: false, stripe_connect_synced_at: null, ...overrides };
}

const admin: ConnectRouteSession = { kind: "member", organizationId: ORG, role: "owner", paymentStatus: "active" };

function startRequest(init: { origin?: string | null; fetchSite?: string | null; method?: string; url?: string; body?: string } = {}): Request {
  const headers = new Headers({ host: "localhost:3000", "content-type": "application/x-www-form-urlencoded" });
  if (init.origin !== null) headers.set("origin", init.origin ?? ORIGIN);
  if (init.fetchSite !== null) headers.set("sec-fetch-site", init.fetchSite ?? "same-origin");
  const method = init.method ?? "POST";
  return new Request(init.url ?? `${ORIGIN}/api/payments/connect/start`, { method, headers, body: method === "POST" ? (init.body ?? "") : undefined });
}

function returnRequest(query = ""): Request {
  return new Request(`${ORIGIN}/api/payments/connect/return${query}`, { method: "GET", headers: { host: "localhost:3000" } });
}

function setup(options: { session?: ConnectRouteSession; organizations?: Row[]; stripe?: Parameters<typeof makeFakeStripe>[0] } = {}) {
  const db = makeFakeSupabase({ organizations: options.organizations ?? [org()] });
  const stripe = makeFakeStripe(options.stripe ?? {});
  let serviceCreated = 0;
  const deps = {
    resolveSession: async () => options.session ?? admin,
    createService: () => ((serviceCreated += 1), db.client),
    stripe: stripe.stripe,
  };
  return { db, stripe, deps, serviceCreated: () => serviceCreated };
}

function location(response: Response): URL {
  const value = response.headers.get("location");
  assert.ok(value, "a redirect");
  return new URL(value);
}

function assertSettingsNotice(response: Response, payments: string, reason?: string) {
  assert.equal(response.status, 303);
  const target = location(response);
  assert.equal(target.origin + target.pathname, `${ORIGIN}/settings`);
  assert.equal(target.searchParams.get("payments"), payments);
  assert.equal(target.searchParams.get("reason"), reason ?? null);
  assert.deepEqual([...target.searchParams.keys()].sort(), reason ? ["payments", "reason"] : ["payments"], "only fixed-vocabulary parameters");
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

test("start: an admin of an active organization is sent to Stripe onboarding (303), with return/refresh URLs on this app's own origin", async () => {
  const ctx = setup({ stripe: { v2AccountsCreate: () => v2Account({ card: "pending", payouts: "pending", requirements: [{ status: "currently_due" }] }), v2AccountLinksCreate: () => ({ url: ONBOARDING_URL }) } });
  const response = await handleConnectStart(startRequest(), ctx.deps);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), ONBOARDING_URL);

  assert.deepEqual(ctx.stripe.calls.map((call) => call.method), ["v2.core.accounts.create", "v2.core.accountLinks.create"]);
  const [accountParams] = ctx.stripe.calls[0].args as [Stripe.V2.Core.AccountCreateParams];
  assert.equal(accountParams.dashboard, "full", "Standard-style (Accounts v2), via the connect service");
  assert.deepEqual(accountParams.defaults?.responsibilities, { fees_collector: "stripe", losses_collector: "stripe" });
  assert.equal(accountParams.identity?.country, "us");
  const [link] = ctx.stripe.calls[1].args as [Stripe.V2.Core.AccountLinkCreateParams];
  const linkParams = { account: link.account, type: link.use_case.type, ...link.use_case.account_onboarding };
  assert.equal(linkParams.account, ACCT);
  assert.equal(linkParams.type, "account_onboarding");
  assert.equal(linkParams.return_url, `${ORIGIN}/api/payments/connect/return`);
  assert.equal(linkParams.refresh_url, `${ORIGIN}/api/payments/connect/refresh`, "an expired link goes to the refresh route, which only re-links the existing account");
  assert.deepEqual(linkParams.configurations, ["merchant"]);
  assert.deepEqual(linkParams.collection_options, { fields: "currently_due" });
  assert.equal(ctx.db.tables.organizations[0].stripe_connect_account_id, ACCT);
});

test("start: an existing account is reused - only a new link is created", async () => {
  const ctx = setup({ organizations: [org({ stripe_connect_account_id: ACCT })], stripe: { v2AccountLinksCreate: () => ({ url: ONBOARDING_URL }) } });
  const response = await handleConnectStart(startRequest(), ctx.deps);
  assert.equal(response.headers.get("location"), ONBOARDING_URL);
  assert.deepEqual(ctx.stripe.calls.map((call) => call.method), ["v2.core.accountLinks.create"]);
  assert.equal(ctx.db.writes().length, 0);
});

test("start: organization and account ids in the query string or form body are ignored - the session's organization is the only one used", async () => {
  const ctx = setup({
    organizations: [org(), { ...org({ id: OTHER_ORG, stripe_connect_account_id: "acct_1OtherOrg0000000001" }) }],
    stripe: { v2AccountsCreate: () => v2Account({ card: "pending" }), v2AccountLinksCreate: () => ({ url: ONBOARDING_URL }) },
  });
  const request = startRequest({ url: `${ORIGIN}/api/payments/connect/start?organization_id=${OTHER_ORG}&account=acct_1OtherOrg0000000001`, body: `organization_id=${OTHER_ORG}&account=acct_1OtherOrg0000000001` });
  await handleConnectStart(request, ctx.deps);
  const [accountParams, options] = ctx.stripe.calls[0].args as [Stripe.V2.Core.AccountCreateParams, Stripe.RequestOptions];
  assert.deepEqual(accountParams.metadata, { organization_id: ORG });
  assert.equal(options.idempotencyKey, `trackpr-connect-account-${ORG}`);
  assert.equal((ctx.stripe.calls[1].args[0] as Stripe.V2.Core.AccountLinkCreateParams).account, ACCT);
  assert.equal(ctx.db.tables.organizations[1].stripe_connect_account_id, "acct_1OtherOrg0000000001", "the other organization is untouched");
  for (const write of ctx.db.writes()) assert.deepEqual(write.filters[0], ["eq", "id", ORG]);
});

test("start: GET, a cross-site POST, or a POST without Origin is refused before any session, database or Stripe work", async () => {
  const cases: [string, Request][] = [
    ["GET", startRequest({ method: "GET" })],
    ["cross-site Origin", startRequest({ origin: "https://evil.example" })],
    ["cross-site Sec-Fetch-Site", startRequest({ fetchSite: "cross-site" })],
    ["same-site (sibling subdomain) Sec-Fetch-Site", startRequest({ fetchSite: "same-site" })],
    ["no Origin", startRequest({ origin: null })],
  ];
  for (const [label, request] of cases) {
    let sessionResolved = false;
    const ctx = setup();
    const response = await handleConnectStart(request, { ...ctx.deps, resolveSession: async () => ((sessionResolved = true), admin) });
    assertSettingsNotice(response, "error", "invalid_request");
    assert.equal(sessionResolved, false, label);
    assert.equal(ctx.serviceCreated(), 0, label);
    assert.equal(ctx.stripe.calls.length, 0, label);
  }
});

test("isSameOriginPost: a same-origin form POST passes, with or without Sec-Fetch-Site", () => {
  assert.equal(isSameOriginPost(startRequest()), true);
  assert.equal(isSameOriginPost(startRequest({ fetchSite: null })), true);
});

test("start: unauthenticated -> /login, no organization -> /onboarding, a plain member -> not_authorized; none of them touch the database or Stripe", async () => {
  const cases: [ConnectRouteSession, string, string | null][] = [
    [{ kind: "unauthenticated" }, "/login", null],
    [{ kind: "no_organization" }, "/onboarding", null],
    [{ kind: "member", organizationId: ORG, role: "member", paymentStatus: "active" }, "/settings", "not_authorized"],
  ];
  for (const [session, pathname, reason] of cases) {
    const ctx = setup({ session });
    const response = await handleConnectStart(startRequest(), ctx.deps);
    assert.equal(response.status, 303);
    assert.equal(location(response).pathname, pathname, session.kind);
    if (reason) assertSettingsNotice(response, "error", reason);
    assert.equal(ctx.serviceCreated(), 0);
    assert.equal(ctx.stripe.calls.length, 0);
  }
});

test("start: the payment gate applies - an organization whose Trackpr subscription is not active cannot start onboarding", async () => {
  for (const paymentStatus of ["payment_required", "suspended", "cancelled"] as const) {
    const ctx = setup({ session: { kind: "member", organizationId: ORG, role: "admin", paymentStatus } });
    assertSettingsNotice(await handleConnectStart(startRequest(), ctx.deps), "error", "subscription_inactive");
    assert.equal(ctx.stripe.calls.length, 0);
  }
});

test("start: a Stripe failure, or a link that is not an https Stripe URL, returns to Settings instead of redirecting anywhere else", async () => {
  const failing = setup({ organizations: [org({ stripe_connect_account_id: ACCT })], stripe: { v2AccountLinksCreate: () => { throw stripeApiError("down"); } } });
  assertSettingsNotice(await handleConnectStart(startRequest(), failing.deps), "error", "stripe_unavailable");

  for (const url of ["https://evil.example/onboard", "http://connect.stripe.com/insecure", "https://stripe.com.evil.example/x"]) {
    const ctx = setup({ organizations: [org({ stripe_connect_account_id: ACCT })], stripe: { v2AccountLinksCreate: () => ({ url }) } });
    assertSettingsNotice(await handleConnectStart(startRequest(), ctx.deps), "error", "stripe_unavailable");
  }
});

test("start: with the real (guarded) client and a live key outside Vercel Production, nothing reaches Stripe and nothing is stored", async () => {
  const db = makeFakeSupabase({ organizations: [org()] });
  const response = await withStripeKey("sk_live_guard_unit_test_only", () => handleConnectStart(startRequest(), { resolveSession: async () => admin, createService: () => db.client }));
  assertSettingsNotice(response, "error", "stripe_unavailable");
  assert.equal(db.writes().length, 0);
});

test("start: redirects back to Settings never carry an account id, organization id or Stripe message", async () => {
  const ctx = setup({ organizations: [org({ stripe_connect_account_id: ACCT })], stripe: { v2AccountLinksCreate: () => { throw stripeApiError(`No such account: ${ACCT}`); } } });
  const response = await handleConnectStart(startRequest(), ctx.deps);
  const target = response.headers.get("location") ?? "";
  for (const secret of [ACCT, ORG, "No such account"]) assert.equal(target.includes(secret), false, secret);
});

// ---------------------------------------------------------------------------
// return
// ---------------------------------------------------------------------------

test("return: re-reads the organization's STORED account from Stripe, stores the flags, and reports connected", async () => {
  const ctx = setup({ organizations: [org({ stripe_connect_account_id: ACCT })], stripe: { v2AccountsRetrieve: () => v2Account({ card: "active", payouts: "active", requirements: [] }) } });
  const response = await handleConnectReturn(returnRequest(), ctx.deps);
  assertSettingsNotice(response, "connected");
  assert.deepEqual(ctx.stripe.calls.map((call) => [call.method, call.args[0]]), [["v2.core.accounts.retrieve", ACCT]]);
  assert.equal(ctx.db.tables.organizations[0].stripe_connect_charges_enabled, true);
  assert.equal(ctx.db.tables.organizations[0].stripe_connect_details_submitted, true);
});

test("return: an account Stripe says cannot take charges yet reports incomplete", async () => {
  const ctx = setup({ organizations: [org({ stripe_connect_account_id: ACCT })], stripe: { v2AccountsRetrieve: () => v2Account({ card: "pending", requirements: [] }) } });
  assertSettingsNotice(await handleConnectReturn(returnRequest(), ctx.deps), "incomplete");
  assert.equal(ctx.db.tables.organizations[0].stripe_connect_charges_enabled, false);
});

test("return: nothing in the URL is trusted - account ids, organization ids and status flags in the query are ignored", async () => {
  const ctx = setup({ organizations: [org({ stripe_connect_account_id: ACCT })], stripe: { v2AccountsRetrieve: () => v2Account({ card: "pending" }) } });
  const response = await handleConnectReturn(returnRequest(`?account=acct_1Attacker000000000001&organization_id=${OTHER_ORG}&charges_enabled=true&status=enabled`), ctx.deps);
  assertSettingsNotice(response, "incomplete");
  assert.deepEqual(ctx.stripe.calls.map((call) => call.args[0]), [ACCT]);
  assert.equal(ctx.db.tables.organizations[0].stripe_connect_charges_enabled, false);
});

test("return: no stored account -> not_connected without calling Stripe; a mismatched or unreachable account -> sync_failed without storing", async () => {
  const none = setup();
  assertSettingsNotice(await handleConnectReturn(returnRequest(), none.deps), "error", "not_connected");
  assert.equal(none.stripe.calls.length, 0);

  const mismatched = setup({ organizations: [org({ stripe_connect_account_id: ACCT })], stripe: { v2AccountsRetrieve: () => v2Account({ card: "active", organizationId: OTHER_ORG }) } });
  assertSettingsNotice(await handleConnectReturn(returnRequest(), mismatched.deps), "error", "sync_failed");
  assert.equal(mismatched.db.writes().length, 0);

  const down = setup({ organizations: [org({ stripe_connect_account_id: ACCT })], stripe: { v2AccountsRetrieve: () => { throw stripeApiError("down"); } } });
  assertSettingsNotice(await handleConnectReturn(returnRequest(), down.deps), "error", "sync_failed");
  assert.equal(down.db.writes().length, 0);
});

test("return: unauthenticated, no organization and plain members are handled before any database or Stripe work", async () => {
  const cases: [ConnectRouteSession, string][] = [
    [{ kind: "unauthenticated" }, "/login"],
    [{ kind: "no_organization" }, "/onboarding"],
    [{ kind: "member", organizationId: ORG, role: "member", paymentStatus: "active" }, "/settings"],
  ];
  for (const [session, pathname] of cases) {
    const ctx = setup({ session, organizations: [org({ stripe_connect_account_id: ACCT })] });
    const response = await handleConnectReturn(returnRequest(), ctx.deps);
    assert.equal(location(response).pathname, pathname);
    assert.equal(ctx.serviceCreated(), 0);
    assert.equal(ctx.stripe.calls.length, 0);
  }
});

test("return: an admin can still sync while the subscription is inactive (reading Stripe changes nothing a customer can do)", async () => {
  const ctx = setup({ session: { kind: "member", organizationId: ORG, role: "admin", paymentStatus: "suspended" }, organizations: [org({ stripe_connect_account_id: ACCT })], stripe: { v2AccountsRetrieve: () => v2Account({ card: "active" }) } });
  assertSettingsNotice(await handleConnectReturn(returnRequest(), ctx.deps), "connected");
});

// ---------------------------------------------------------------------------
// Structural: the route files only wire the handlers
// ---------------------------------------------------------------------------

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("structural: start exports POST only, return exports GET only, and both just wire the tested handlers with the session resolver and the service client", () => {
  const start = read("app/api/payments/connect/start/route.ts");
  const ret = read("app/api/payments/connect/return/route.ts");
  assert.match(start, /export async function POST\(/);
  assert.doesNotMatch(start, /export (async )?function (GET|PUT|PATCH|DELETE)\b/);
  assert.match(start, /handleConnectStart\(request, \{ resolveSession: resolveConnectSession, createService: createServiceRoleClient \}\)/);
  assert.match(ret, /export async function GET\(/);
  assert.doesNotMatch(ret, /export (async )?function (POST|PUT|PATCH|DELETE)\b/);
  assert.match(ret, /handleConnectReturn\(request, \{ resolveSession: resolveConnectSession, createService: createServiceRoleClient \}\)/);
  for (const source of [start, ret]) {
    assert.doesNotMatch(source, /from "stripe"|getStripeClient|getPaymentsStripeClient|new\s+Stripe\s*\(|searchParams|formData|\.json\(/, "no Stripe or request-input handling in the route files");
  }
});

test("structural: the session resolver uses the cookie session and the caller's own membership, never request input", () => {
  const source = read("lib/payments/connect-session.ts");
  assert.match(source, /supabase\.auth\.getUser\(\)/);
  assert.match(source, /getUserOrganization\(supabase, user\.id\)/);
  assert.doesNotMatch(source, /request|searchParams|headers\(|cookies\(/);
});

test("structural: Settings renders the Online payments section in the existing Business & Organization group, reading status with the page's own session client", () => {
  const page = read("app/(app)/settings/page.tsx");
  assert.match(page, /getOrganizationConnectStatus\(supabase, organizationId\)/);
  assert.match(page, /<BusinessProfileSection profile=\{profile\} canEdit=\{canEdit\} \/>\s*<OnlinePaymentsSection status=\{connectBackstop\.status\} paymentStatus=\{membership\.paymentStatus\} canEdit=\{canEdit\} refreshFailed=\{connectBackstop\.refreshFailed\} \/>/);
  assert.match(page, /const SETTINGS_GROUP_LABELS = \["Business & Organization", "Automations", "Scheduling & Booking", "Communications & Notifications", "AI", "Reputation"\];/, "no new Settings group");
  const section = read("app/(app)/settings/_components/online-payments-section.tsx");
  assert.match(section, /<form method="post" action=\{ONLINE_PAYMENTS_START_PATH\}>/);
  assert.doesNotMatch(section, /accountId|organizationId|<a[^>]+\/api\/payments\/connect\/start/, "no internal ids rendered and no GET link to the start route");
});

// ---------------------------------------------------------------------------
// refresh (Stripe's refresh_url)
// ---------------------------------------------------------------------------

/** Stripe navigates the browser here from accounts.stripe.com: a cross-site, top-level GET with no Origin. */
function refreshRequest(init: { method?: string; fetchMode?: string | null; fetchDest?: string | null; fetchSite?: string | null; query?: string } = {}): Request {
  const headers = new Headers({ host: "localhost:3000" });
  if (init.fetchMode !== null) headers.set("sec-fetch-mode", init.fetchMode ?? "navigate");
  if (init.fetchDest !== null) headers.set("sec-fetch-dest", init.fetchDest ?? "document");
  if (init.fetchSite !== null) headers.set("sec-fetch-site", init.fetchSite ?? "cross-site");
  return new Request(`${ORIGIN}/api/payments/connect/refresh${init.query ?? ""}`, { method: init.method ?? "GET", headers });
}

test("refresh: Stripe's cross-site navigation back gets a NEW link for the EXISTING account and a 303 straight to Stripe - no account is created", async () => {
  const ctx = setup({ organizations: [org({ stripe_connect_account_id: ACCT })], stripe: { v2AccountLinksCreate: () => ({ url: ONBOARDING_URL }) } });
  const response = await handleConnectRefresh(refreshRequest(), ctx.deps);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), ONBOARDING_URL);
  assert.deepEqual(ctx.stripe.calls.map((call) => call.method), ["v2.core.accountLinks.create"], "only a link - never v2.core.accounts.create");
  const [link] = ctx.stripe.calls[0].args as [Stripe.V2.Core.AccountLinkCreateParams];
  assert.equal(link.account, ACCT);
  assert.deepEqual(link.use_case, { type: "account_onboarding", account_onboarding: { configurations: ["merchant"], collection_options: { fields: "currently_due" }, return_url: `${ORIGIN}/api/payments/connect/return`, refresh_url: `${ORIGIN}/api/payments/connect/refresh` } });
  assert.equal(ctx.db.writes().length, 0);
});

test("refresh: an organization with no connected account is sent to Settings as not_connected - Stripe is never called, no account is created", async () => {
  const ctx = setup();
  const response = await handleConnectRefresh(refreshRequest(), ctx.deps);
  assertSettingsNotice(response, "error", "not_connected");
  assert.equal(ctx.stripe.calls.length, 0);
  assert.equal(ctx.db.writes().length, 0);
});

test("refresh: only a top-level GET navigation - fetch/XHR, iframes, images or a POST are refused before any session, database or Stripe work", async () => {
  const cases: [string, Request][] = [
    ["POST", refreshRequest({ method: "POST" })],
    ["fetch (cors mode)", refreshRequest({ fetchMode: "cors", fetchDest: "empty" })],
    ["no-cors subresource", refreshRequest({ fetchMode: "no-cors", fetchDest: "image" })],
    ["iframe", refreshRequest({ fetchDest: "iframe" })],
  ];
  for (const [label, request] of cases) {
    let sessionResolved = false;
    const ctx = setup({ organizations: [org({ stripe_connect_account_id: ACCT })] });
    const response = await handleConnectRefresh(request, { ...ctx.deps, resolveSession: async () => ((sessionResolved = true), admin) });
    assertSettingsNotice(response, "error", "invalid_request");
    assert.equal(sessionResolved, false, label);
    assert.equal(ctx.serviceCreated(), 0, label);
    assert.equal(ctx.stripe.calls.length, 0, label);
  }
  assert.equal(isTopLevelNavigation(refreshRequest({ fetchMode: null, fetchDest: null, fetchSite: null })), true, "older browsers without Fetch Metadata still work");
});

test("refresh: unauthenticated -> /login, no organization -> /onboarding, plain member -> not_authorized, inactive subscription -> subscription_inactive; none reach Stripe", async () => {
  const cases: [ConnectRouteSession, string, string | null][] = [
    [{ kind: "unauthenticated" }, "/login", null],
    [{ kind: "no_organization" }, "/onboarding", null],
    [{ kind: "member", organizationId: ORG, role: "member", paymentStatus: "active" }, "/settings", "not_authorized"],
    [{ kind: "member", organizationId: ORG, role: "owner", paymentStatus: "suspended" }, "/settings", "subscription_inactive"],
  ];
  for (const [session, pathname, reason] of cases) {
    const ctx = setup({ session, organizations: [org({ stripe_connect_account_id: ACCT })] });
    const response = await handleConnectRefresh(refreshRequest(), ctx.deps);
    assert.equal(location(response).pathname, pathname, JSON.stringify(session));
    if (reason) assertSettingsNotice(response, "error", reason);
    assert.equal(ctx.stripe.calls.length, 0);
  }
});

test("refresh: account/organization ids in the query are ignored - the session's stored account is the only one linked", async () => {
  const ctx = setup({ organizations: [org({ stripe_connect_account_id: ACCT }), org({ id: OTHER_ORG, stripe_connect_account_id: "acct_1OtherOrg0000000001" })], stripe: { v2AccountLinksCreate: () => ({ url: ONBOARDING_URL }) } });
  await handleConnectRefresh(refreshRequest({ query: `?account=acct_1OtherOrg0000000001&organization_id=${OTHER_ORG}` }), ctx.deps);
  assert.equal((ctx.stripe.calls[0].args[0] as Stripe.V2.Core.AccountLinkCreateParams).account, ACCT);
});

test("refresh: a Stripe failure or a non-Stripe URL returns to Settings with a generic reason - no ids or Stripe text in the URL", async () => {
  const failing = setup({ organizations: [org({ stripe_connect_account_id: ACCT })], stripe: { v2AccountLinksCreate: () => { throw stripeApiError(`No such account: ${ACCT}`); } } });
  const response = await handleConnectRefresh(refreshRequest(), failing.deps);
  assertSettingsNotice(response, "error", "stripe_unavailable");
  const target = response.headers.get("location") ?? "";
  for (const secret of [ACCT, ORG, "No such account"]) assert.equal(target.includes(secret), false, secret);

  for (const url of ["https://evil.example/onboard", "http://accounts.stripe.com/insecure", "https://accounts.stripe.com.evil.example/x"]) {
    const ctx = setup({ organizations: [org({ stripe_connect_account_id: ACCT })], stripe: { v2AccountLinksCreate: () => ({ url }) } });
    assertSettingsNotice(await handleConnectRefresh(refreshRequest(), ctx.deps), "error", "stripe_unavailable");
  }
});

test("refresh: with the real (guarded) client and a live key outside Vercel Production, nothing reaches Stripe", async () => {
  const db = makeFakeSupabase({ organizations: [org({ stripe_connect_account_id: ACCT })] });
  const response = await withStripeKey("sk_live_guard_unit_test_only", () => handleConnectRefresh(refreshRequest(), { resolveSession: async () => admin, createService: () => db.client }));
  assertSettingsNotice(response, "error", "stripe_unavailable");
  assert.equal(db.writes().length, 0);
});

test("structural: the refresh route exports GET only and just wires handleConnectRefresh; the handler can only refresh, never create", () => {
  const route = read("app/api/payments/connect/refresh/route.ts");
  assert.match(route, /export async function GET\(/);
  assert.doesNotMatch(route, /export (async )?function (POST|PUT|PATCH|DELETE)\b/);
  assert.match(route, /handleConnectRefresh\(request, \{ resolveSession: resolveConnectSession, createService: createServiceRoleClient \}\)/);
  assert.doesNotMatch(route, /from "stripe"|getStripeClient|new\s+Stripe\s*\(|searchParams/);
  const handlers = read("lib/payments/connect-routes.ts");
  const refresh = handlers.slice(handlers.indexOf("export async function handleConnectRefresh"));
  assert.match(refresh, /refreshConnectOnboardingLink\(/);
  assert.doesNotMatch(refresh, /createConnectOnboardingLink|ensureConnectAccount/, "the refresh handler has no path to account creation");
});

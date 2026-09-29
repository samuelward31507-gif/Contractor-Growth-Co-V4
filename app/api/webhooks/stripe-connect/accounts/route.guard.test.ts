/**
 * Phase 1C (W2): route-level guard tests for app/api/webhooks/stripe-connect/accounts.
 *
 * Environment safety (the app/api/webhooks/stripe-connect/route.guard.test.ts
 * pattern): never reads .env.local, never uses a real Stripe key, never
 * reaches a real database. The service-role client points at a fake PostgREST
 * server on 127.0.0.1 that serves in-memory rows, records every request and
 * fails any write. Signatures are real (local HMAC), parsed by Stripe's own
 * parseEventNotification. Only paths that never call the Stripe API are
 * driven here; the re-fetch branches are covered with fakes in
 * lib/payments/connect-accounts-webhook.test.ts.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/api/webhooks/stripe-connect/accounts/route.guard.test.ts"
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import path from "node:path";

const REPO_ROOT = process.cwd();
const require = createRequire(path.join(REPO_ROOT, "package.json"));

type RecordedRequest = { method: string; table: string; query: string };
const requests: RecordedRequest[] = [];
let rows: Record<string, Record<string, unknown>[]> = {};

const fakePostgrest = http.createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const table = url.pathname.replace(/^\/rest\/v1\//, "");
    requests.push({ method: req.method ?? "", table, query: url.search });
    if (req.method !== "GET") {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ message: "unexpected write in guard test" }));
      return;
    }
    const filters = [...url.searchParams.entries()].filter(([, v]) => v.startsWith("eq.")).map(([c, v]) => [c, v.slice(3)] as const);
    const matched = (rows[table] ?? []).filter((row) => filters.every(([c, v]) => String(row[c]) === v));
    if ((req.headers.accept ?? "").includes("application/vnd.pgrst.object+json")) {
      if (matched.length !== 1) {
        res.writeHead(406, { "content-type": "application/json" }).end(JSON.stringify({ code: "PGRST116", details: `The result contains ${matched.length} rows`, hint: null, message: "JSON object requested, multiple (or no) rows returned" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/vnd.pgrst.object+json" }).end(JSON.stringify(matched[0]));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(matched));
  });
});

const SECRET = "whsec_phase1c_connect_accounts_guard_only";
const ORG = "11111111-1111-4111-8111-111111111111";
const ACCT = "acct_1TestConnect000001";
const CAPABILITY = "v2.core.account[configuration.merchant].capability_status_updated";

let POST: typeof import("./route").POST;
let signer: { webhooks: { generateTestHeaderString: (o: { payload: string; secret: string }) => string } };

before(async () => {
  await new Promise<void>((resolve) => fakePostgrest.listen(0, "127.0.0.1", resolve));
  const { port } = fakePostgrest.address() as AddressInfo;
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role-key-for-local-fake-only";
  process.env.STRIPE_CONNECT_SECRET_KEY = "sk_test_placeholder_phase1c_accounts_guard_never_calls_stripe";
  process.env.STRIPE_CONNECT_ACCOUNTS_WEBHOOK_SECRET = SECRET;
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  assert.match(process.env.NEXT_PUBLIC_SUPABASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/, "refusing to run against anything but the local fake");
  assert.ok(process.env.STRIPE_CONNECT_SECRET_KEY.startsWith("sk_test_"), "refusing to run with a non-test Stripe key");
  ({ POST } = require(path.join(REPO_ROOT, "app/api/webhooks/stripe-connect/accounts/route.ts")));
  const { getPaymentsStripeClient } = require(path.join(REPO_ROOT, "lib/billing/stripe-mode-guard.ts")) as typeof import("@/lib/billing/stripe-mode-guard");
  signer = getPaymentsStripeClient();
});

after(() => {
  fakePostgrest.close();
});

beforeEach(() => {
  requests.length = 0;
  rows = { organizations: [{ id: ORG, stripe_connect_account_id: ACCT }] };
  process.env.STRIPE_CONNECT_SECRET_KEY = "sk_test_placeholder_phase1c_accounts_guard_never_calls_stripe";
  process.env.STRIPE_CONNECT_ACCOUNTS_WEBHOOK_SECRET = SECRET;
});

function thin(type: string, accountId = ACCT): string {
  return JSON.stringify({ id: `evt_test_${Math.random().toString(36).slice(2)}`, object: "v2.core.event", type, created: "2026-09-29T01:38:41.385Z", livemode: false, context: null, related_object: { id: accountId, type: "v2.core.account", url: `/v2/core/accounts/${accountId}` } });
}

function request(body: string, signature: string | null = signer.webhooks.generateTestHeaderString({ payload: body, secret: SECRET })): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature !== null) headers.set("stripe-signature", signature);
  return new Request("http://localhost/api/webhooks/stripe-connect/accounts", { method: "POST", headers, body });
}

async function call(req: Request) {
  const response = await POST(req as never);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("route: an invalid or missing signature is 400 and the database is never contacted", async () => {
  const body = thin(CAPABILITY);
  for (const signature of [signer.webhooks.generateTestHeaderString({ payload: body, secret: "whsec_wrong" }), "t=1,v1=00", null]) {
    const result = await call(request(body, signature));
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { ok: false, outcome: "invalid_signature" });
  }
  assert.equal(requests.length, 0);
});

test("route: an unset secret or a live key is 500, before anything is read", async () => {
  const body = thin(CAPABILITY);
  const signature = signer.webhooks.generateTestHeaderString({ payload: body, secret: SECRET });
  delete process.env.STRIPE_CONNECT_ACCOUNTS_WEBHOOK_SECRET;
  assert.equal((await call(request(body, signature))).status, 500);
  process.env.STRIPE_CONNECT_ACCOUNTS_WEBHOOK_SECRET = SECRET;
  process.env.STRIPE_CONNECT_SECRET_KEY = "sk_live_guard_unit_test_only";
  assert.deepEqual((await call(request(body, signature))).body, { ok: false, outcome: "not_configured" });
  assert.equal(requests.length, 0);
});

test("route: with only the billing STRIPE_SECRET_KEY configured the accounts webhook is 500 not_configured - no fallback, no database access", async () => {
  const body = thin(CAPABILITY);
  const signature = signer.webhooks.generateTestHeaderString({ payload: body, secret: SECRET });
  delete process.env.STRIPE_CONNECT_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_placeholder_phase1c_billing_key_only";
  try {
    const result = await call(request(body, signature));
    assert.equal(result.status, 500);
    assert.deepEqual(result.body, { ok: false, outcome: "not_configured" });
    assert.equal(requests.length, 0);
  } finally {
    delete process.env.STRIPE_SECRET_KEY;
  }
});

test("route: an unhandled v2 event type is 200 ignored with no database access", async () => {
  assert.deepEqual((await call(request(thin("v2.core.account[identity].updated")))).body, { ok: true, outcome: "ignored", reason: "unhandled_event_type" });
  assert.equal(requests.length, 0);
});

test("route: the organization is looked up only by the stored account id; an unknown account is 200 ignored with no write and no Stripe call", async () => {
  const result = await call(request(thin(CAPABILITY, "acct_1NobodyOwnsThis0000")));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, outcome: "ignored", reason: "unknown_account" });
  assert.deepEqual(requests.map((r) => [r.method, r.table]), [["GET", "organizations"]]);
  assert.match(requests[0].query, /stripe_connect_account_id=eq\.acct_1NobodyOwnsThis0000/);
});

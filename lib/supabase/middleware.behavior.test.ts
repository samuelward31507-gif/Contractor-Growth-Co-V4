/**
 * Performance Pass B: behavioral tests for the real updateSession()
 * (lib/supabase/middleware.ts, run by proxy.ts on every navigable request).
 *
 * The existing middleware.*.test.ts files check the source; these run it:
 * a real NextRequest carrying a real @supabase/ssr session cookie, with the
 * global fetch replaced by a fake Supabase (Auth + PostgREST) that records
 * every call. No network, no real project.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/supabase/middleware.behavior.test.ts
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(path.join(process.cwd(), "package.json"));

const SUPABASE_URL = "http://fakeproject.invalid";
const COOKIE_NAME = "sb-fakeproject-auth-token";
const USER_WITH_ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_WITHOUT_ORG = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REVOKED_USER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

type Call = { kind: "auth" | "membership" | "other"; url: string };
let calls: Call[] = [];
const realFetch = globalThis.fetch;
let updateSession: typeof import("./middleware").updateSession;
let NextRequestCtor: typeof import("next/server").NextRequest;

function jwt(sub: string): string {
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
}

function sessionCookie(userId: string): string {
  const session = {
    access_token: jwt(userId),
    refresh_token: "refresh-token",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: userId, aud: "authenticated", role: "authenticated", email: `${userId.slice(0, 4)}@example.com` },
  };
  return `${COOKIE_NAME}=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
}

before(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "fake-anon-key-for-local-test-only";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers ?? (typeof input === "object" && "headers" in input ? (input as Request).headers : undefined));
    const bearer = (headers.get("authorization") ?? "").replace(/^Bearer /, "");
    const sub = bearer.split(".").length === 3 ? (JSON.parse(Buffer.from(bearer.split(".")[1], "base64url").toString()) as { sub?: string }).sub : undefined;
    if (url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) {
      calls.push({ kind: "auth", url });
      if (!sub || sub === REVOKED_USER) return new Response(JSON.stringify({ code: 403, error_code: "session_not_found", msg: "Session not found" }), { status: 403, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ id: sub, aud: "authenticated", role: "authenticated", email: "x@example.com" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith(`${SUPABASE_URL}/rest/v1/organization_members`)) {
      calls.push({ kind: "membership", url });
      const rows = sub === USER_WITH_ORG ? [{ organization_id: "11111111-1111-4111-8111-111111111111", role: "owner", organizations: { name: "Org", payment_status: "active", vertical: "contractor" } }] : [];
      return new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } });
    }
    calls.push({ kind: "other", url });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  ({ updateSession } = require(path.join(process.cwd(), "lib/supabase/middleware.ts")));
  ({ NextRequest: NextRequestCtor } = require("next/server"));
});

after(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  calls = [];
});

async function run(pathname: string, userId?: string) {
  calls = [];
  const headers = new Headers();
  if (userId) headers.set("cookie", sessionCookie(userId));
  const response = await updateSession(new NextRequestCtor(`http://localhost:3000${pathname}`, { headers }));
  const location = response.headers.get("location");
  return {
    redirect: location ? new URL(location).pathname : null,
    passed: response.headers.get("x-middleware-next") === "1",
    auth: calls.filter((c) => c.kind === "auth").length,
    membership: calls.filter((c) => c.kind === "membership").length,
    other: calls.filter((c) => c.kind === "other").length,
  };
}

const APP_ROUTES = ["/today", "/people", "/people/some-id", "/jobs", "/schedule", "/conversations", "/settings", "/insights", "/money?browse=invoices"];
const PUBLIC_ROUTES = ["/", "/how-it-works", "/privacy", "/terms", "/robots.txt", "/sitemap.xml", "/demo", "/quote/abc", "/api/leads/capture/x", "/auth/reset-password"];

test("1. logged out: every protected route redirects to /login, with no membership query", async () => {
  for (const route of [...APP_ROUTES, "/agency", "/agency/usage", "/onboarding"]) {
    const result = await run(route);
    assert.equal(result.redirect, "/login", route);
    assert.equal(result.membership, 0, route);
  }
});

test("2. logged out: the auth pages and every public route pass through untouched", async () => {
  for (const route of ["/login", "/signup", "/forgot-password", ...PUBLIC_ROUTES]) {
    const result = await run(route);
    assert.equal(result.redirect, null, route);
    assert.equal(result.passed, true, route);
    assert.equal(result.membership, 0, route);
  }
});

test("3. public routes stay public for a signed-in user too - no redirect, no membership query", async () => {
  for (const route of PUBLIC_ROUTES) {
    const result = await run(route, USER_WITH_ORG);
    assert.deepEqual([result.redirect, result.passed, result.membership], [null, true, 0], route);
  }
});

test("4. authenticated member on an (app) route: verified once with Auth and passed through - no membership query any more (the layout/page resolves it)", async () => {
  for (const route of APP_ROUTES) {
    const result = await run(route, USER_WITH_ORG);
    assert.deepEqual([result.redirect, result.passed, result.auth, result.membership, result.other], [null, true, 1, 0, 0], route);
  }
});

test("5. authenticated user WITHOUT an organization on an (app) route: the middleware passes it on; the (app) layout/page sends it to /onboarding (proved in middleware.membership.test.ts)", async () => {
  for (const route of APP_ROUTES) {
    const result = await run(route, USER_WITHOUT_ORG);
    assert.deepEqual([result.redirect, result.passed, result.membership], [null, true, 0], route);
  }
});

test("6. auth pages while signed in: redirected by membership, exactly as before - /today with an organization, /onboarding without", async () => {
  for (const route of ["/login", "/signup", "/forgot-password"]) {
    const member = await run(route, USER_WITH_ORG);
    assert.deepEqual([member.redirect, member.membership], ["/today", 1], route);
    const noOrg = await run(route, USER_WITHOUT_ORG);
    assert.deepEqual([noOrg.redirect, noOrg.membership], ["/onboarding", 1], route);
  }
});

test("7. /onboarding is reachable for any signed-in user, with or without an organization, and needs no membership query", async () => {
  for (const userId of [USER_WITH_ORG, USER_WITHOUT_ORG]) {
    const result = await run("/onboarding", userId);
    assert.deepEqual([result.redirect, result.passed, result.membership], [null, true, 0]);
  }
});

test("8. /agency keeps its middleware membership gate (its layout doesn't check membership): no organization -> /onboarding; member -> through", async () => {
  for (const route of ["/agency", "/agency/usage", "/agency/organizations/x"]) {
    const noOrg = await run(route, USER_WITHOUT_ORG);
    assert.deepEqual([noOrg.redirect, noOrg.membership], ["/onboarding", 1], route);
    const member = await run(route, USER_WITH_ORG);
    assert.deepEqual([member.redirect, member.passed, member.membership], [null, true, 1], route);
  }
  // A lookalike path is not /agency.
  const lookalike = await run("/agencyx", USER_WITHOUT_ORG);
  assert.equal(lookalike.membership, 0);
});

test("9. a revoked session (Auth rejects it) is treated as logged out on protected routes", async () => {
  for (const route of ["/today", "/settings", "/agency"]) {
    const result = await run(route, REVOKED_USER);
    assert.equal(result.redirect, "/login", route);
    assert.equal(result.membership, 0, route);
  }
});

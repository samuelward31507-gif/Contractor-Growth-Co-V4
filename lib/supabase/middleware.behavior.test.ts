/**
 * Performance Pass B: behavioral tests for the real updateSession()
 * (lib/supabase/middleware.ts, run by proxy.ts on every navigable request).
 *
 * The existing middleware.*.test.ts files check the source; these run it:
 * a real NextRequest carrying a real @supabase/ssr session cookie, with the
 * global fetch replaced by a fake Supabase (Auth + PostgREST) that records
 * every call. No network, no real project.
 *
 * The middleware reads the session with getClaims(): an asymmetric (ES256,
 * what production signs with) token is verified locally against the
 * project's JWKS - no /auth/v1/user round trip - while a symmetric (HS256)
 * token makes auth-js fall back to getUser(). Tests 1-9 use HS256 tokens, so
 * they pin the pre-existing getUser() behavior through that fallback; the
 * ES256 tests below use a real P-256 key pair served from the fake JWKS
 * endpoint and cover the path production actually takes.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/supabase/middleware.behavior.test.ts
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import path from "node:path";

const require = createRequire(path.join(process.cwd(), "package.json"));

const SUPABASE_URL = "http://fakeproject.invalid";
const COOKIE_NAME = "sb-fakeproject-auth-token";
const USER_WITH_ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_WITHOUT_ORG = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REVOKED_USER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const ES_KID = "es256-test-key";
const esKeys = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const otherEsKeys = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
/** Refresh tokens the fake /token endpoint accepts, mapped to the user the new session belongs to. */
const refreshable = new Map<string, string>();

type Call = { kind: "auth" | "membership" | "jwks" | "token" | "other"; url: string };
let calls: Call[] = [];
const realFetch = globalThis.fetch;
let updateSession: typeof import("./middleware").updateSession;
let NextRequestCtor: typeof import("next/server").NextRequest;

function jwt(sub: string): string {
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
}

/** A real ES256 JWT, signed with `key` (the JWKS key unless a test says otherwise). */
function es256(sub: string, { exp = Math.floor(Date.now() / 1000) + 3600, kid = ES_KID, key = esKeys.privateKey }: { exp?: number; kid?: string; key?: crypto.KeyObject } = {}): string {
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${b64({ alg: "ES256", typ: "JWT", kid })}.${b64({ sub, role: "authenticated", aud: "authenticated", session_id: `session-${sub.slice(0, 4)}`, exp })}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${signingInput}.${signature}`;
}

function sessionCookie(userId: string, { accessToken = jwt(userId), refreshToken = "refresh-token", expiresAt = Math.floor(Date.now() / 1000) + 3600 }: { accessToken?: string; refreshToken?: string; expiresAt?: number } = {}): string {
  const session = {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: expiresAt,
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
    if (url.startsWith(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`)) {
      calls.push({ kind: "jwks", url });
      return new Response(JSON.stringify({ keys: [{ ...esKeys.publicKey.export({ format: "jwk" }), kid: ES_KID, alg: "ES256", use: "sig" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith(`${SUPABASE_URL}/auth/v1/token`)) {
      calls.push({ kind: "token", url });
      const { refresh_token: presented } = JSON.parse(String(init?.body ?? "{}")) as { refresh_token?: string };
      const owner = presented ? refreshable.get(presented) : undefined;
      if (!owner) return new Response(JSON.stringify({ code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token: Refresh Token Not Found" }), { status: 400, headers: { "content-type": "application/json" } });
      refreshable.delete(presented!);
      const now = Math.floor(Date.now() / 1000);
      return new Response(JSON.stringify({ access_token: es256(owner), refresh_token: `rotated-${presented}`, token_type: "bearer", expires_in: 3600, expires_at: now + 3600, user: { id: owner, aud: "authenticated", role: "authenticated", email: "x@example.com" } }), { status: 200, headers: { "content-type": "application/json" } });
    }
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

async function run(pathname: string, userId?: string, cookie: string | undefined = userId ? sessionCookie(userId) : undefined) {
  calls = [];
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  const response = await updateSession(new NextRequestCtor(`http://localhost:3000${pathname}`, { headers }));
  const location = response.headers.get("location");
  const sessionCookies = response.cookies.getAll().filter((c) => c.name.startsWith(COOKIE_NAME));
  return {
    redirect: location ? new URL(location).pathname : null,
    passed: response.headers.get("x-middleware-next") === "1",
    auth: calls.filter((c) => c.kind === "auth").length,
    membership: calls.filter((c) => c.kind === "membership").length,
    membershipUrls: calls.filter((c) => c.kind === "membership").map((c) => c.url),
    token: calls.filter((c) => c.kind === "token").length,
    other: calls.filter((c) => c.kind === "other").length,
    sessionCookies,
  };
}

/** Decodes the session a response rewrote into the (possibly chunked) @supabase/ssr cookie. */
function rewrittenSession(cookies: { name: string; value: string }[]): { access_token: string; refresh_token: string } | null {
  const ordered = [...cookies].filter((c) => c.value).sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  if (ordered.length === 0) return null;
  const joined = ordered.map((c) => c.value).join("");
  return JSON.parse(Buffer.from(joined.replace(/^base64-/, ""), "base64url").toString()) as { access_token: string; refresh_token: string };
}

const subOf = (token: string) => (JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as { sub: string }).sub;
const esCookie = (userId: string, options: Parameters<typeof es256>[1] = {}) => sessionCookie(userId, { accessToken: es256(userId, options) });

const APP_ROUTES = ["/today", "/people", "/people/some-id", "/jobs", "/schedule", "/conversations", "/settings", "/insights", "/money?browse=invoices"];
const PUBLIC_ROUTES = ["/", "/how-it-works", "/privacy", "/terms", "/robots.txt", "/sitemap.xml", "/demo", "/quote/abc", "/pay/abc", "/api/leads/capture/x", "/auth/reset-password"];

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

// ---------------------------------------------------------------------------
// ES256 (production's signing algorithm): the middleware verifies locally.
// ---------------------------------------------------------------------------

test("10. valid ES256 session on (app) routes: passed through with NO /auth/v1/user call and no membership query (the JWKS is fetched at most once, then cached)", async () => {
  for (const route of APP_ROUTES) {
    const result = await run(route, USER_WITH_ORG, esCookie(USER_WITH_ORG));
    assert.deepEqual([result.redirect, result.passed, result.auth, result.membership, result.token, result.other], [null, true, 0, 0, 0, 0], route);
  }
  const again = await run("/today", USER_WITHOUT_ORG, esCookie(USER_WITHOUT_ORG));
  assert.equal(calls.filter((c) => c.kind === "jwks").length, 0, "the JWKS stays cached across requests");
  assert.deepEqual([again.passed, again.auth], [true, 0]);
});

test("11. valid ES256 session: the verified claims.sub is the user the middleware acts on (/agency membership lookup is by that sub; no /auth/v1/user call)", async () => {
  const member = await run("/agency", USER_WITH_ORG, esCookie(USER_WITH_ORG));
  assert.deepEqual([member.redirect, member.passed, member.auth, member.membership], [null, true, 0, 1]);
  assert.match(member.membershipUrls[0], new RegExp(`user_id=eq\\.${USER_WITH_ORG}`));
  const noOrg = await run("/agency/usage", USER_WITHOUT_ORG, esCookie(USER_WITHOUT_ORG));
  assert.deepEqual([noOrg.redirect, noOrg.auth, noOrg.membership], ["/onboarding", 0, 1]);
  assert.match(noOrg.membershipUrls[0], new RegExp(`user_id=eq\\.${USER_WITHOUT_ORG}`));
});

test("12. tampered ES256 token (payload swapped, or signed by a key not in the JWKS) is rejected: protected routes redirect to /login with no membership query and no Auth fallback", async () => {
  const genuine = es256(USER_WITHOUT_ORG);
  const [header, , signature] = genuine.split(".");
  const forgedPayload = Buffer.from(JSON.stringify({ sub: USER_WITH_ORG, role: "authenticated", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  const swapped = `${header}.${forgedPayload}.${signature}`;
  const wrongKey = es256(USER_WITH_ORG, { key: otherEsKeys.privateKey });
  for (const token of [swapped, wrongKey]) {
    for (const route of ["/today", "/settings", "/agency", "/onboarding"]) {
      const result = await run(route, USER_WITH_ORG, sessionCookie(USER_WITH_ORG, { accessToken: token }));
      assert.deepEqual([result.redirect, result.membership, result.auth], ["/login", 0, 0], route);
    }
    // ...and the auth pages treat it as logged out: the login page renders.
    const login = await run("/login", USER_WITH_ORG, sessionCookie(USER_WITH_ORG, { accessToken: token }));
    assert.deepEqual([login.redirect, login.passed, login.membership], [null, true, 0]);
  }
});

test("13. an ES256 token whose kid is not in the JWKS falls back to the Auth server (auth-js getUser fallback), never to trusting the token", async () => {
  const result = await run("/today", USER_WITH_ORG, esCookie(USER_WITH_ORG, { kid: "unknown-kid" }));
  assert.deepEqual([result.passed, result.auth], [true, 1]);
});

test("14. missing session: protected routes -> /login, auth pages and public routes pass, with no Auth, token or membership call", async () => {
  for (const route of ["/today", "/agency", "/onboarding"]) {
    const result = await run(route);
    assert.deepEqual([result.redirect, result.auth, result.token, result.membership], ["/login", 0, 0, 0], route);
  }
  for (const route of ["/login", ...PUBLIC_ROUTES]) {
    const result = await run(route);
    assert.deepEqual([result.redirect, result.passed, result.auth, result.membership], [null, true, 0, 0], route);
  }
});

test("15. expired ES256 session whose refresh fails: treated as logged out (/login), exactly as before", async () => {
  const past = Math.floor(Date.now() / 1000) - 60;
  const cookie = sessionCookie(USER_WITH_ORG, { accessToken: es256(USER_WITH_ORG, { exp: past }), refreshToken: "dead-refresh-token", expiresAt: past });
  const result = await run("/today", USER_WITH_ORG, cookie);
  assert.deepEqual([result.redirect, result.token, result.membership], ["/login", 1, 0]);
  // A cookie that claims to be fresh but carries an expired JWT is rejected by the local exp check.
  const staleJwt = sessionCookie(USER_WITH_ORG, { accessToken: es256(USER_WITH_ORG, { exp: past }) });
  const stale = await run("/today", USER_WITH_ORG, staleJwt);
  assert.deepEqual([stale.redirect, stale.membership], ["/login", 0]);
});

test("16. expiring ES256 session: refreshed once and the rotated session is rewritten into the response cookies; the request passes with no /auth/v1/user call", async () => {
  const soon = Math.floor(Date.now() / 1000) + 5;
  refreshable.set("live-refresh-token", USER_WITH_ORG);
  const cookie = sessionCookie(USER_WITH_ORG, { accessToken: es256(USER_WITH_ORG, { exp: soon }), refreshToken: "live-refresh-token", expiresAt: soon });
  const result = await run("/today", USER_WITH_ORG, cookie);
  assert.deepEqual([result.redirect, result.passed, result.token, result.auth], [null, true, 1, 0]);
  const session = rewrittenSession(result.sessionCookies);
  assert.ok(session, "the refreshed session is written back to the cookie");
  assert.equal(session.refresh_token, "rotated-live-refresh-token");
  assert.equal(subOf(session.access_token), USER_WITH_ORG);
});

test("17. HS256 token: auth-js falls back to getUser(), so the middleware still makes exactly one /auth/v1/user call (pre-existing behavior)", async () => {
  const result = await run("/today", USER_WITH_ORG, sessionCookie(USER_WITH_ORG));
  assert.deepEqual([result.passed, result.auth, result.membership], [true, 1, 0]);
  const revoked = await run("/today", REVOKED_USER, sessionCookie(REVOKED_USER));
  assert.equal(revoked.redirect, "/login");
});

test("18. public routes are untouched by the ES256 path for signed-in users too", async () => {
  for (const route of PUBLIC_ROUTES) {
    const result = await run(route, USER_WITH_ORG, esCookie(USER_WITH_ORG));
    assert.deepEqual([result.redirect, result.passed, result.membership, result.auth], [null, true, 0, 0], route);
  }
});

test("19. auth pages with a valid ES256 session: still confirmed with Auth and redirected by membership (/today or /onboarding), exactly as before", async () => {
  for (const route of ["/login", "/signup", "/forgot-password"]) {
    const member = await run(route, USER_WITH_ORG, esCookie(USER_WITH_ORG));
    assert.deepEqual([member.redirect, member.auth, member.membership], ["/today", 1, 1], route);
    assert.match(member.membershipUrls[0], new RegExp(`user_id=eq\\.${USER_WITH_ORG}`));
    const noOrg = await run(route, USER_WITHOUT_ORG, esCookie(USER_WITHOUT_ORG));
    assert.deepEqual([noOrg.redirect, noOrg.auth, noOrg.membership], ["/onboarding", 1, 1], route);
  }
});

test("20. revoked-but-validly-signed ES256 session: the middleware passes it (the page's getUser() sends it to /login), and /login then renders and clears the cookie - no /login <-> /today loop", async () => {
  const cookie = esCookie(REVOKED_USER);
  const app = await run("/today", REVOKED_USER, cookie);
  assert.deepEqual([app.passed, app.auth], [true, 0], "routing layer only; the (app) layout's getUser() is the check");
  const login = await run("/login", REVOKED_USER, cookie);
  assert.deepEqual([login.redirect, login.passed, login.auth, login.membership], [null, true, 1, 0], "the login page renders instead of bouncing to /today");
  assert.ok(login.sessionCookies.length > 0 && login.sessionCookies.every((c) => c.value === ""), "the revoked session's cookie is cleared, as the middleware always did");
});

// Fail-closed safety guard for tests that talk to a real database.
//
// Installed by lib/automation/test-loader.mjs (the `--import` every test run
// uses), so it is in place before any test module - and therefore before any
// fixture, setup or test body - is loaded. Every Supabase call goes through
// global fetch (supabase-js resolves `fetch` at call time; no test uses a
// direct Postgres driver), so the guard sits on fetch: a request to a
// database is refused BEFORE it leaves the process unless the target is
// verified as an authorized test database.
//
// A request is treated as a database request when it targets a
// *.supabase.co / *.supabase.in host, the configured NEXT_PUBLIC_SUPABASE_URL
// origin, or carries an `apikey` header. Such a request is allowed only when
// ALL of these hold:
//   TEST project (TRACKPR_INTEGRATION_TARGET=test):
//     - the host is <ref>.supabase.co with ref === AUTHORIZED_TEST_PROJECT_REF
//     - the request's key (apikey header, else the Bearer token) is a JWT
//       whose `ref` claim is also AUTHORIZED_TEST_PROJECT_REF - checked from
//       the credential itself, independently of any variable name
//   local/disposable database (TRACKPR_INTEGRATION_TARGET=local):
//     - the host is loopback (localhost, 127.0.0.1, ::1)
//   a test's own in-process fake server: loopback with a fake (non-JWT,
//     non-sb_) key needs no setting - it is not a database. A real key on
//     loopback without the local setting is refused.
// Always refused: the Production project ref anywhere (host or key), a
// missing/unknown target, an unverifiable key (non-JWT keys, malformed
// tokens), any other host. Real-message providers (Twilio, Resend) and
// live-mode Stripe keys are always refused.
//
// Errors name the reason and the project ref only - never a key, token or
// header value. Tests that replace globalThis.fetch with an in-memory fake
// are unaffected (they never reach the network).

export const AUTHORIZED_TEST_PROJECT_REF = "lwofqffxagxiqodqvcfr";
export const PRODUCTION_PROJECT_REF = "mywznmxtlgajnczjvbmk";
export const GUARD_ERROR_PREFIX = "[test-db-guard] refused:";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const MESSAGE_PROVIDER_HOSTS = ["api.twilio.com", "api.resend.com"];

export class TestDatabaseGuardError extends Error {
  constructor(reason) {
    super(`${GUARD_ERROR_PREFIX} ${reason}`);
    this.name = "TestDatabaseGuardError";
  }
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  if (Array.isArray(headers)) {
    const hit = headers.find(([k]) => String(k).toLowerCase() === name);
    return hit ? hit[1] : null;
  }
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v;
  return null;
}

/** The `ref` claim of a Supabase JWT key, or null if it is not a decodable JWT. Never returns any other part of the token. */
export function jwtProjectRef(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof payload?.ref === "string" ? payload.ref : null;
  } catch {
    return null;
  }
}

function isJwt(token) {
  if (typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    return typeof JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) === "object";
  } catch {
    return false;
  }
}

function supabaseHostRef(hostname) {
  const match = /^([a-z0-9]{20})\.supabase\.(co|in)$/.exec(hostname);
  return match ? match[1] : null;
}

function configuredSupabaseOrigin(env) {
  try {
    return env.NEXT_PUBLIC_SUPABASE_URL ? new URL(env.NEXT_PUBLIC_SUPABASE_URL).origin : null;
  } catch {
    return null;
  }
}

/**
 * Pure decision for one outbound request: { allowed: true } or
 * { allowed: false, reason } (reason never contains credentials).
 */
export function evaluateTestRequest(rawUrl, headers, env = process.env) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return { allowed: true }; // not an absolute URL - not a network database request
  }
  const host = url.hostname.toLowerCase();

  if (MESSAGE_PROVIDER_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
    return { allowed: false, reason: `tests may not call a real messaging provider (${host})` };
  }
  const authorization = headerValue(headers, "authorization");
  if (host === "api.stripe.com" && typeof authorization === "string" && /\bsk_live_|\brk_live_/.test(authorization)) {
    return { allowed: false, reason: "tests may not use a live-mode Stripe key" };
  }

  const apikey = headerValue(headers, "apikey");
  const hostRef = supabaseHostRef(host);
  const isDatabaseRequest = hostRef !== null || url.origin === configuredSupabaseOrigin(env) || apikey != null;
  if (!isDatabaseRequest) return { allowed: true };

  const bearer = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : null;
  const keyRef = jwtProjectRef(apikey ?? bearer);
  const bearerRef = jwtProjectRef(bearer);

  if (hostRef === PRODUCTION_PROJECT_REF || keyRef === PRODUCTION_PROJECT_REF || bearerRef === PRODUCTION_PROJECT_REF) {
    return { allowed: false, reason: `the Production project (${PRODUCTION_PROJECT_REF}) is never a test target` };
  }

  const target = env.TRACKPR_INTEGRATION_TARGET;
  // A loopback request that carries no real-looking credential is a test's
  // own in-process fake server (fake keys like "fake-anon-key"), not a
  // database. A real key on loopback - a JWT (local Supabase or a tunnel to a
  // hosted project) or a new-style sb_ key - needs the explicit local setting.
  if (LOOPBACK.has(host) && target !== "local") {
    const presented = apikey ?? bearer;
    const looksReal = isJwt(presented) || (typeof presented === "string" && /^sb_(secret|publishable)_/.test(presented));
    if (!looksReal) return { allowed: true };
    return { allowed: false, reason: "a real database key was sent to a loopback host; set TRACKPR_INTEGRATION_TARGET=local for a disposable local database" };
  }
  if (target === "local") {
    if (!LOOPBACK.has(host)) return { allowed: false, reason: `TRACKPR_INTEGRATION_TARGET=local only allows a loopback database, not ${host}` };
    return { allowed: true };
  }
  if (target === "test") {
    if (hostRef !== AUTHORIZED_TEST_PROJECT_REF) return { allowed: false, reason: `database host is not the authorized TEST project (${hostRef ?? host})` };
    if (keyRef !== AUTHORIZED_TEST_PROJECT_REF) {
      return { allowed: false, reason: keyRef ? `the request key belongs to project ${keyRef}, not the authorized TEST project` : "the request key's project could not be verified (not a Supabase JWT key)" };
    }
    // A user session token carries no `ref`; a project key used as the bearer must be the TEST project's too.
    if (bearerRef !== null && bearerRef !== AUTHORIZED_TEST_PROJECT_REF) return { allowed: false, reason: `the bearer key belongs to project ${bearerRef}` };
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: target
      ? `TRACKPR_INTEGRATION_TARGET="${String(target).slice(0, 20)}" is not recognized (use "test" or "local")`
      : `database requests need TRACKPR_INTEGRATION_TARGET=test (authorized TEST project ${AUTHORIZED_TEST_PROJECT_REF}) or =local (loopback database)`,
  };
}

/** Wraps globalThis.fetch (once). Refused requests throw before any network I/O. */
export function installTestDatabaseGuard(env = process.env) {
  const current = globalThis.fetch;
  if (typeof current !== "function" || current.__trackprTestDbGuard) return;
  const underlying = current;
  const guarded = async function guardedFetch(input, init) {
    const rawUrl = typeof input === "string" || input instanceof URL ? input : input?.url;
    const headers = init?.headers ?? (typeof input === "object" && input && "headers" in input ? input.headers : undefined);
    const verdict = evaluateTestRequest(rawUrl, headers, env);
    if (!verdict.allowed) throw new TestDatabaseGuardError(verdict.reason);
    return underlying(input, init);
  };
  guarded.__trackprTestDbGuard = true;
  globalThis.fetch = guarded;
}

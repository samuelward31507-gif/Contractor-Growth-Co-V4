/**
 * Structural tests for the Google Calendar OAuth routes (Phase 1
 * Scheduling Foundation, Stage 3). Both routes call createClient()
 * (lib/supabase/server.ts), which depends on next/headers's cookies() - a
 * real Next.js request-scoped context unavailable to a bare node:test
 * script, the same "outside a request scope" limitation this codebase's
 * other Server Action/route tests already document (e.g.
 * middleware.forgot-password.test.ts). Verified against the real source.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/api/calendar/oauth/oauth-routes.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const START_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "app/api/calendar/oauth/start/route.ts"), "utf8");
const CALLBACK_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "app/api/calendar/oauth/callback/route.ts"), "utf8");

test("1. the start route requires GOOGLE_CALENDAR_CLIENT_ID to be configured before doing anything else", () => {
  assert.match(START_SOURCE, /const clientId = process\.env\.GOOGLE_CALENDAR_CLIENT_ID;/);
  assert.match(START_SOURCE, /if \(!clientId\)/);
});

test("2. the start route requires a real authenticated session and a real organization membership before generating any state or redirecting to Google", () => {
  const userCheckIndex = START_SOURCE.indexOf("supabase.auth.getUser()");
  const membershipIndex = START_SOURCE.indexOf("getUserOrganization(supabase, user.id)");
  const stateIndex = START_SOURCE.indexOf("randomBytes(32)");
  assert.ok(userCheckIndex !== -1 && membershipIndex !== -1 && stateIndex !== -1);
  assert.ok(userCheckIndex < membershipIndex && membershipIndex < stateIndex, "auth and organization resolution must both happen before state is ever generated");
});

test("3. the start route requires owner/admin - a bare member cannot connect a calendar", () => {
  assert.match(START_SOURCE, /membership\.role !== "owner" && membership\.role !== "admin"/);
});

test("4. the state value is generated with node:crypto's randomBytes, not Math.random or any other non-cryptographic source", () => {
  assert.match(START_SOURCE, /import \{ randomBytes \} from "node:crypto";/);
  assert.match(START_SOURCE, /randomBytes\(32\)\.toString\("base64url"\)/);
  assert.doesNotMatch(START_SOURCE, /Math\.random/);
});

test("5. organization_id is never written into the state value, the authorization URL, or any query parameter sent to Google - the callback re-resolves organization fresh from the session instead", () => {
  assert.doesNotMatch(START_SOURCE, /searchParams\.set\("state", .*organizationId/);
  assert.doesNotMatch(START_SOURCE, /organizationId/);
});

test("6. the state cookie is httpOnly, sameSite, and scoped to only the OAuth routes themselves - never readable by client-side JavaScript", () => {
  assert.match(START_SOURCE, /httpOnly: true/);
  assert.match(START_SOURCE, /sameSite: "lax"/);
  assert.match(START_SOURCE, /path: OAUTH_STATE_COOKIE_PATH/);
});

test("7. the authorization request asks for access_type=offline and prompt=consent - required to reliably receive a refresh_token, including on a reconnect", () => {
  assert.match(START_SOURCE, /searchParams\.set\("access_type", "offline"\)/);
  assert.match(START_SOURCE, /searchParams\.set\("prompt", "consent"\)/);
});

test("8. the callback route validates the returned state against the cookie using a timing-safe comparison, not a plain ===", () => {
  assert.match(CALLBACK_SOURCE, /import \{ timingSafeEqual \} from "node:crypto";/);
  assert.match(CALLBACK_SOURCE, /timingSafeEqual\(returnedStateBuffer, cookieStateBuffer\)/);
  // Length is checked before timingSafeEqual is ever called - that function throws on mismatched buffer lengths rather than returning false.
  assert.match(CALLBACK_SOURCE, /returnedStateBuffer\.length === cookieStateBuffer\.length && timingSafeEqual/);
});

test("9. the state cookie is cleared on every outcome (maxAge: 0), not only on success - a one-time-use value is never left behind for reuse", () => {
  const responseHelperMatch = CALLBACK_SOURCE.match(/const response = \(redirectTarget: URL\) => \{[\s\S]*?\};/);
  assert.ok(responseHelperMatch, "expected a single shared response()  helper used for every redirect in this route");
  assert.match(responseHelperMatch![0], /maxAge: 0/);
});

test("10. the callback route re-verifies session and owner/admin role independently, after state validation, never trusting the OAuth round-trip itself for authorization", () => {
  const stateCheckIndex = CALLBACK_SOURCE.indexOf("stateMatches");
  const userCheckIndex = CALLBACK_SOURCE.indexOf("supabase.auth.getUser()");
  const roleCheckIndex = CALLBACK_SOURCE.indexOf('membership.role !== "owner" && membership.role !== "admin"');
  assert.ok(stateCheckIndex !== -1 && userCheckIndex !== -1 && roleCheckIndex !== -1);
  assert.ok(stateCheckIndex < userCheckIndex && userCheckIndex < roleCheckIndex);
});

test("11. a code exchange failure and a storage failure are both logged WITHOUT the authorization code or any token value ever appearing in the logged object - only organizationId and the already-safe .error string", () => {
  const errorLogLines = CALLBACK_SOURCE.split("\n").filter((line) => line.includes("console.error"));
  assert.ok(errorLogLines.length >= 2);
  for (const line of errorLogLines) {
    assert.match(line, /console\.error\("\[calendar\]\[oauth\][^"]*", \{ organizationId: membership\.organizationId, error: \w+\.error \}\);/, `console.error call must log only organizationId and a safe .error field, nothing else: ${line}`);
    assert.doesNotMatch(line, /\bcode,|:\s*code\b|accessToken|refreshToken/, `console.error call must never include the raw authorization code or a token value: ${line}`);
  }
});

test("12. every redirect back to Settings carries only a fixed, safe query parameter shape (calendar=connected|error&reason=...) - never the code, a token, or any raw provider error text", () => {
  assert.doesNotMatch(CALLBACK_SOURCE, /searchParams\.set\("[^"]*", *(code|accessToken|refreshToken|exchangeResult\.value)/);
  assert.match(CALLBACK_SOURCE, /calendar: "connected"/);
  assert.match(CALLBACK_SOURCE, /calendar: "error", reason: "invalid_state"/);
});

test("13. the redirect_uri sent to Google's authorization endpoint and the one used for the token exchange both come from the exact same shared helper - they can never independently drift apart", () => {
  assert.match(START_SOURCE, /import \{ resolveCalendarOAuthRedirectUri.*\} from "@\/lib\/calendar\/oauth";/);
  assert.match(START_SOURCE, /resolveCalendarOAuthRedirectUri\(request\)/);
  assert.match(CALLBACK_SOURCE, /import \{ resolveCalendarOAuthRedirectUri.*\} from "@\/lib\/calendar\/oauth";/);
  assert.match(CALLBACK_SOURCE, /resolveCalendarOAuthRedirectUri\(request\)/);
});

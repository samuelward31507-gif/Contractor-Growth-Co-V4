/**
 * Structural test for app/auth/confirm/route.ts, covering both verification
 * paths it supports:
 *  - the original token_hash + type path (verifyOtp) - Launch Blocker #4's
 *    recovery branch, unchanged in behavior.
 *  - the PKCE `code` path (exchangeCodeForSession) added for the production
 *    signup-confirmation fix: Supabase's Free-tier locked default
 *    {{ .ConfirmationURL }} template routes through Supabase's hosted
 *    /verify endpoint, which - because @supabase/ssr defaults every client
 *    to PKCE flow - redirects back to this route with a `code` query
 *    parameter instead of `token_hash`/`type`.
 *
 * The route calls createClient() from lib/supabase/server.ts (cookies()),
 * so - like every other cookie-bound Route Handler/Server Action in this
 * codebase - it can't be invoked directly from a bare node:test script.
 * Verified against the real source instead.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/auth/confirm/route.recovery.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const ROUTE_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "app/auth/confirm/route.ts"), "utf8");

test("1. a successful recovery verification (either path) redirects to /auth/reset-password, via the single shared redirectAfterConfirmation helper", () => {
  assert.match(ROUTE_SOURCE, /if \(isRecovery\) \{\s*\n\s*redirect\("\/auth\/reset-password"\);\s*\n\s*\}/);
});

test("2. the token_hash/type path's recovery check runs strictly after verifyOtp has already succeeded (inside the `if (!error && data.user)` block), never before verification", () => {
  const successBlockMatch = ROUTE_SOURCE.match(/if \(!error && data\.user\) \{[\s\S]*?\n {4}\}/);
  assert.ok(successBlockMatch, "expected to find the `if (!error && data.user) { ... }` block");
  assert.match(successBlockMatch![0], /type === "recovery"/);
});

test("3. within the shared redirectAfterConfirmation helper, the recovery redirect happens BEFORE the membership lookup - a recovery session's org isn't resolved or trusted at this point", () => {
  const helperMatch = ROUTE_SOURCE.match(/async function redirectAfterConfirmation\([\s\S]*?\n\}/);
  assert.ok(helperMatch, "expected to find the redirectAfterConfirmation function");
  const isRecoveryIndex = helperMatch![0].indexOf("if (isRecovery)");
  const membershipIndex = helperMatch![0].indexOf("getUserOrganization(supabase, userId)");
  assert.ok(isRecoveryIndex !== -1 && membershipIndex !== -1 && isRecoveryIndex < membershipIndex);
});

test("4. normal signup confirmation (either path, isRecovery false) still redirects based on membership, exactly as before - the destination logic exists exactly once, never duplicated between the two verification paths", () => {
  assert.match(ROUTE_SOURCE, /const membership = await getUserOrganization\(supabase, userId\);\s*\n\s*redirect\(membership \? "\/dashboard" : "\/onboarding"\);/);
  // Only one such block exists in the whole file - both verification paths
  // above call the same shared helper rather than each having their own copy.
  const matches = ROUTE_SOURCE.match(/redirect\(membership \? "\/dashboard" : "\/onboarding"\);/g) ?? [];
  assert.equal(matches.length, 1);
});

test("5. the fallback for a missing/invalid token_hash+type and no code, or a failed verifyOtp/exchangeCodeForSession, is unchanged (still redirects to /login?error=confirmation_failed)", () => {
  assert.match(ROUTE_SOURCE, /redirect\("\/login\?error=confirmation_failed"\);/);
});

test("6. verifyOtp itself is still called exactly once, with the same { type, token_hash } shape - the original verification mechanism was not touched", () => {
  const matches = ROUTE_SOURCE.match(/verifyOtp\(/g) ?? [];
  assert.equal(matches.length, 1);
  assert.match(ROUTE_SOURCE, /verifyOtp\(\{\s*\n\s*type,\s*\n\s*token_hash: tokenHash,\s*\n\s*\}\);/);
});

test("7. the token_hash/type branch is checked first (an unmodified/customized-template email keeps working exactly as before), with the PKCE code branch only reached as an `else if` when token_hash+type are absent", () => {
  assert.match(ROUTE_SOURCE, /if \(tokenHash && type\) \{[\s\S]*?\} else if \(code\) \{/);
});

test("8. the code branch exists and calls exchangeCodeForSession(code) exactly once", () => {
  const matches = ROUTE_SOURCE.match(/exchangeCodeForSession\(/g) ?? [];
  assert.equal(matches.length, 1);
  assert.match(ROUTE_SOURCE, /exchangeCodeForSession\(code\)/);
});

test("9. a successful code exchange resolves recovery vs. signup from the SDK's own redirectType signal (data.redirectType === \"recovery\"), never from the code value itself or an invented heuristic, and reaches the exact same shared redirectAfterConfirmation destination logic as the token_hash path", () => {
  assert.match(ROUTE_SOURCE, /redirectType === "recovery"/);
  assert.match(ROUTE_SOURCE, /redirectAfterConfirmation\(supabase, data\.user\.id, redirectType === "recovery"\)/);
  // Same call shape (same helper, same signature) as the token_hash path -
  // proving the two paths share one destination implementation, not two.
  assert.match(ROUTE_SOURCE, /redirectAfterConfirmation\(supabase, data\.user\.id, type === "recovery"\)/);
});

test("10. a failed code exchange (error, or no data.user) falls through to the same confirmation_failed redirect as a failed verifyOtp - no separate/divergent failure path for the PKCE branch", () => {
  const codeBranchMatch = ROUTE_SOURCE.match(/\} else if \(code\) \{[\s\S]*?\n {2}\}/);
  assert.ok(codeBranchMatch, "expected to find the `else if (code) { ... }` block");
  // The branch itself contains no redirect of its own on failure - it only
  // conditionally redirects on success and otherwise falls out of the
  // if/else if entirely, reaching the single shared confirmation_failed
  // redirect at the end of GET (proven by test 5).
  assert.doesNotMatch(codeBranchMatch![0], /confirmation_failed/);
});

test("11. no service-role client is introduced anywhere in this route - only the session-scoped createClient() from lib/supabase/server.ts", () => {
  assert.doesNotMatch(ROUTE_SOURCE, /createServiceRoleClient/);
  assert.doesNotMatch(ROUTE_SOURCE, /service-role|serviceRole/i);
  const matches = ROUTE_SOURCE.match(/createClient\(/g) ?? [];
  assert.equal(matches.length, 1, "createClient() must be called exactly once, shared by both verification paths");
});

test("12. no cookies are manually constructed - session handling is left entirely to createClient()'s existing @supabase/ssr cookie adapter", () => {
  assert.doesNotMatch(ROUTE_SOURCE, /cookies\(\)\.set|\.cookies\.set\(/);
});

test("13. the code value, the token_hash value, and any session/token data are never logged - no console.* call exists anywhere in this route", () => {
  assert.doesNotMatch(ROUTE_SOURCE, /console\./);
});

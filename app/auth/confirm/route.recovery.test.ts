/**
 * Structural test for the recovery branch added to app/auth/confirm/route.ts
 * for Launch Blocker #4. The route calls createClient() from
 * lib/supabase/server.ts (cookies()), so - like every other cookie-bound
 * Route Handler/Server Action in this codebase - it can't be invoked
 * directly from a bare node:test script. Verified against the real source
 * instead: the recovery branch exists, runs only after verifyOtp already
 * succeeded, and the pre-existing signup-confirmation behavior (the only
 * other EmailOtpType this app currently sends) is textually unchanged.
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

test("1. a successful recovery verification redirects to /auth/reset-password", () => {
  assert.match(ROUTE_SOURCE, /if \(type === "recovery"\) \{\s*\n\s*redirect\("\/auth\/reset-password"\);\s*\n\s*\}/);
});

test("2. the recovery check runs strictly after verifyOtp has already succeeded (inside the `if (!error && data.user)` block), never before verification", () => {
  const successBlockMatch = ROUTE_SOURCE.match(/if \(!error && data\.user\) \{[\s\S]*?\n {4}\}/);
  assert.ok(successBlockMatch, "expected to find the `if (!error && data.user) { ... }` block");
  assert.match(successBlockMatch![0], /type === "recovery"/);
});

test("3. the recovery redirect happens BEFORE the membership lookup - a recovery session's org isn't resolved or trusted at this point", () => {
  const recoveryIndex = ROUTE_SOURCE.indexOf('type === "recovery"');
  const membershipIndex = ROUTE_SOURCE.indexOf("getUserOrganization(supabase, data.user.id)");
  assert.ok(recoveryIndex !== -1 && membershipIndex !== -1 && recoveryIndex < membershipIndex);
});

test("4. normal signup confirmation (any type other than recovery) still redirects based on membership, exactly as before - this line is unchanged", () => {
  assert.match(ROUTE_SOURCE, /const membership = await getUserOrganization\(supabase, data\.user\.id\);\s*\n\s*redirect\(membership \? "\/dashboard" : "\/onboarding"\);/);
});

test("5. the fallback for a missing/invalid token_hash+type, or a failed verifyOtp, is unchanged (still redirects to /login?error=confirmation_failed)", () => {
  assert.match(ROUTE_SOURCE, /redirect\("\/login\?error=confirmation_failed"\);/);
});

test("6. verifyOtp itself is still called exactly once, with the same { type, token_hash } shape - the verification mechanism itself was not touched", () => {
  const matches = ROUTE_SOURCE.match(/verifyOtp\(/g) ?? [];
  assert.equal(matches.length, 1);
  assert.match(ROUTE_SOURCE, /verifyOtp\(\{\s*\n\s*type,\s*\n\s*token_hash: tokenHash,\s*\n\s*\}\);/);
});

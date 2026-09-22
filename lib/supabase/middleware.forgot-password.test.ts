/**
 * Structural test for the /forgot-password addition to AUTH_PATHS in
 * lib/supabase/middleware.ts (Launch Blocker #4). updateSession() takes a
 * real NextRequest and can't be meaningfully exercised from a bare
 * node:test script without a full Next.js request context, so this is
 * verified against the real source - the same convention already used for
 * this file's earlier /privacy and /terms addition.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "lib/supabase/middleware.forgot-password.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const SOURCE = fs.readFileSync(path.join(REPO_ROOT, "lib/supabase/middleware.ts"), "utf8");

test("1. /forgot-password is now reachable while logged out - added to AUTH_PATHS alongside /login and /signup", () => {
  assert.match(SOURCE, /const AUTH_PATHS = new Set\(\["\/login", "\/signup", "\/forgot-password"\]\);/);
});

test("2. /login and /signup remain in AUTH_PATHS, unchanged - existing behavior for both is preserved, not replaced", () => {
  assert.match(SOURCE, /"\/login"/);
  assert.match(SOURCE, /"\/signup"/);
});

test("3. the /auth/* prefix exemption is untouched - reset-password (and confirm) stay reachable regardless of auth state, unaffected by this change", () => {
  assert.match(SOURCE, /pathname\.startsWith\("\/auth"\)/);
});

test("4. PUBLIC_MARKETING_PATHS is untouched by this change (still exactly the 6 paths from the legal-pages work, no /forgot-password added here by mistake)", () => {
  assert.match(SOURCE, /const PUBLIC_MARKETING_PATHS = new Set\(\["\/", "\/how-it-works", "\/services", "\/get-started", "\/privacy", "\/terms"\]\);/);
});

test("5. AUTH_PATHS still redirects an authenticated user away to dashboard/onboarding (unchanged) - the same bounce /login and /signup already had now also applies correctly to /forgot-password", () => {
  const occurrences = (SOURCE.match(/AUTH_PATHS\.has\(pathname\)/g) ?? []).length;
  assert.equal(occurrences, 2, "expected two AUTH_PATHS.has(pathname) checks - one for the unauthenticated branch, one for the authenticated branch");
  assert.match(SOURCE, /url\.pathname = membership \? "\/dashboard" : "\/onboarding";/);
});

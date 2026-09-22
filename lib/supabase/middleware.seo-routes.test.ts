/**
 * Structural test for the /robots.txt and /sitemap.xml addition to
 * PUBLIC_MARKETING_PATHS in lib/supabase/middleware.ts (production-readiness
 * fix: these were previously falling through to the unauthenticated ->
 * /login redirect, making them unreachable by anonymous crawlers).
 * updateSession() takes a real NextRequest and can't be meaningfully
 * exercised from a bare node:test script without a full Next.js request
 * context, so this is verified against the real source - the same
 * convention already used for this file's earlier /privacy, /terms, and
 * /forgot-password additions (see middleware.forgot-password.test.ts).
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "lib/supabase/middleware.seo-routes.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const SOURCE = fs.readFileSync(path.join(REPO_ROOT, "lib/supabase/middleware.ts"), "utf8");

test("1. /robots.txt and /sitemap.xml are now reachable while logged out - added to PUBLIC_MARKETING_PATHS alongside the existing marketing/legal paths", () => {
  assert.match(
    SOURCE,
    /const PUBLIC_MARKETING_PATHS = new Set\(\["\/", "\/how-it-works", "\/services", "\/get-started", "\/privacy", "\/terms", "\/robots\.txt", "\/sitemap\.xml"\]\);/,
  );
});

test("2. every path PUBLIC_MARKETING_PATHS already had is still present, unchanged - this only adds the two new entries, never replaces the set", () => {
  for (const path of ["/", "/how-it-works", "/services", "/get-started", "/privacy", "/terms"]) {
    assert.ok(SOURCE.includes(`"${path}"`), `expected "${path}" to remain in PUBLIC_MARKETING_PATHS`);
  }
});

test("3. AUTH_PATHS is untouched by this change - /robots.txt and /sitemap.xml are unconditionally public, not merely exempted from the logged-out redirect", () => {
  assert.match(SOURCE, /const AUTH_PATHS = new Set\(\["\/login", "\/signup", "\/forgot-password"\]\);/);
});

test("4. the PUBLIC_MARKETING_PATHS check itself is unchanged in shape - still a single .has(pathname) short-circuit before any auth check runs, so an authenticated user hitting these routes is never redirected away either", () => {
  assert.match(SOURCE, /if \(PUBLIC_MARKETING_PATHS\.has\(pathname\) \|\| pathname\.startsWith\("\/auth"\) \|\| pathname\.startsWith\("\/api\/"\)\) \{\s*\n\s*return supabaseResponse;\s*\n\s*\}/);
});

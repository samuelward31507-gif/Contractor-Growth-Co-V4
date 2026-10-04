/**
 * Structural test for the /demo route addition to lib/supabase/middleware.ts
 * (interactive sales demo: without this, an unauthenticated visitor hitting
 * /demo would silently redirect to /login, making the public demo
 * unreachable by design). Mirrors middleware.seo-routes.test.ts's own
 * verified-against-real-source convention exactly - updateSession() takes a
 * real NextRequest and can't be meaningfully exercised from a bare
 * node:test script without a full Next.js request context.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "lib/supabase/middleware.demo-route.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const SOURCE = fs.readFileSync(path.join(REPO_ROOT, "lib/supabase/middleware.ts"), "utf8");

test("1. /demo is reachable while logged out - added as its own startsWith condition, not a PUBLIC_MARKETING_PATHS entry", () => {
  assert.match(
    SOURCE,
    /PUBLIC_MARKETING_PATHS\.has\(pathname\) \|\| pathname\.startsWith\("\/auth"\) \|\| pathname\.startsWith\("\/api\/"\) \|\| pathname\.startsWith\("\/demo"\)/,
  );
});

test("2. PUBLIC_MARKETING_PATHS is unchanged by this addition - the marketing/legal/SEO paths (Cinder website pass: plus /trackpr, where the Trackpr marketing home moved), /demo is never added to this set", () => {
  assert.match(
    SOURCE,
    /const PUBLIC_MARKETING_PATHS = new Set\(\["\/", "\/trackpr", "\/how-it-works", "\/services", "\/get-started", "\/privacy", "\/terms", "\/robots\.txt", "\/sitemap\.xml"\]\);/,
  );
  const setDeclaration = SOURCE.match(/const PUBLIC_MARKETING_PATHS = new Set\(\[[^\]]*\]\);/)?.[0] ?? "";
  assert.ok(!setDeclaration.includes("/demo"), "/demo must never be added to the PUBLIC_MARKETING_PATHS set itself");
});

test("3. AUTH_PATHS is untouched by this change - /demo is unconditionally public, not an auth path", () => {
  assert.match(SOURCE, /const AUTH_PATHS = new Set\(\["\/login", "\/signup", "\/forgot-password"\]\);/);
});

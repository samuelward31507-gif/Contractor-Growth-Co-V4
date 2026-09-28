/**
 * Structural test for the /quote route addition to lib/supabase/middleware.ts
 * (public estimate-approval links: without this, the customer tapping an
 * approval link from a follow-up text - who by definition has no session -
 * would silently redirect to /login, making every approval link dead on
 * arrival). Mirrors middleware.demo-route.test.ts's verified-against-real-
 * source convention exactly - updateSession() takes a real NextRequest and
 * can't be meaningfully exercised from a bare node:test script without a
 * full Next.js request context.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "lib/supabase/middleware.quote-route.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const SOURCE = fs.readFileSync(path.join(REPO_ROOT, "lib/supabase/middleware.ts"), "utf8");

test("1. /quote is reachable while logged out - added as its own startsWith condition alongside /demo", () => {
  assert.match(
    SOURCE,
    /PUBLIC_MARKETING_PATHS\.has\(pathname\) \|\| pathname\.startsWith\("\/auth"\) \|\| pathname\.startsWith\("\/api\/"\) \|\| pathname\.startsWith\("\/demo"\) \|\| pathname\.startsWith\("\/quote"\)/,
  );
});

test("2. /quote is not a PUBLIC_MARKETING_PATHS entry (it is a route family with a dynamic token segment, not one path)", () => {
  const marketingSet = SOURCE.match(/PUBLIC_MARKETING_PATHS = new Set\(\[([^\]]*)\]\)/)?.[1] ?? "";
  assert.ok(!marketingSet.includes("/quote"));
});

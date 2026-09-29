/**
 * Performance Pass B: the proof behind removing the middleware's membership
 * lookup for (app) routes. The middleware no longer sends an authenticated
 * user without an organization to /onboarding on (app) routes, so every
 * (app) route must do it itself - on a full load (the (app) layout) AND on
 * every client-side navigation (where the shared layout is not re-rendered,
 * so the page or its own segment layout must). This test enforces that for
 * every current and future (app) page.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/supabase/middleware.membership.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

function walk(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${dir}/${entry.name}`;
    return entry.isDirectory() ? walk(relative) : [relative];
  });
}

const APP_PAGES = walk("app/(app)").filter((file) => file.endsWith("/page.tsx"));

/** The membership gate, in either of the two forms the codebase uses. */
function gatesMembership(source: string): boolean {
  const resolves = /await getRequestMembership\(\)/.test(source) || /await getUserOrganization\(supabase, user\.id\)/.test(source);
  return resolves && /if \(!user\) \{?\s*redirect\("\/login"\)/.test(source) && /if \(!membership\) \{?\s*redirect\("\/onboarding"\)/.test(source);
}

function segmentLayoutsGate(page: string): boolean {
  // A page's own segment layouts (below the shared (app) layout) also run on client navigation into that segment.
  let dir = path.dirname(page);
  while (dir !== "app/(app)") {
    const layout = `${dir}/layout.tsx`;
    if (fs.existsSync(path.join(ROOT, layout)) && gatesMembership(read(layout))) return true;
    dir = path.dirname(dir);
  }
  return false;
}

function isRedirectOnly(source: string): boolean {
  return /\bredirect\(/.test(source) && !/return \(|return </.test(source);
}

function dispatchTargets(source: string): string[] {
  return [...source.matchAll(/^import \w+ from "\.\.\/([a-z-]+)\/page";/gm)].map((m) => `app/(app)/${m[1]}/page.tsx`);
}

test("the (app) layout still resolves the user and membership and still sends no-org users to /onboarding and unpaid organizations to /onboarding", () => {
  const layout = read("app/(app)/layout.tsx");
  assert.ok(gatesMembership(layout));
  assert.match(layout, /if \(membership\.paymentStatus !== "active"\) \{\s*redirect\("\/onboarding"\);\s*\}/, "payment gate unchanged");
});

test("every (app) page gates membership itself (or through its segment layout), is a redirect-only compatibility page, or dispatches to pages that do", () => {
  assert.ok(APP_PAGES.length > 30, "sanity: found the (app) pages");
  const failures: string[] = [];
  for (const page of APP_PAGES) {
    const source = read(page);
    if (gatesMembership(source) || segmentLayoutsGate(page) || isRedirectOnly(source)) continue;
    const targets = dispatchTargets(source);
    if (targets.length > 0 && targets.every((target) => gatesMembership(read(target)))) continue;
    // The one special case: /customers/[id] redirects, but resolves membership first for its lead lookup.
    if (page === "app/(app)/customers/[id]/page.tsx" && /redirect\("\/people"\)/.test(source)) continue;
    failures.push(page);
  }
  assert.deepEqual(failures, [], "these (app) pages would let an authenticated user without an organization render");
});

test("redirect-only (app) pages only ever redirect into other (app) routes, which gate membership themselves", () => {
  for (const page of APP_PAGES) {
    const source = read(page);
    if (!isRedirectOnly(source) || gatesMembership(source)) continue;
    for (const target of source.matchAll(/redirect\((?:[^"`]*?\?\s*)?[`"](\/[a-z-]+)/g)) {
      assert.ok(["/insights", "/automations", "/people", "/today", "/conversations", "/money"].includes(target[1]), `${page} -> ${target[1]}`);
    }
  }
});

test("the middleware keeps getUser on every request and the membership lookup exactly where it still decides something", () => {
  const middleware = read("lib/supabase/middleware.ts");
  assert.match(middleware, /\} = await supabase\.auth\.getUser\(\);/, "session verification/refresh on every request");
  assert.equal((middleware.match(/await getUserOrganization\(supabase, user\.id\)/g) ?? []).length, 2, "auth pages + /agency only");
  assert.match(middleware, /if \(AUTH_PATHS\.has\(pathname\)\) \{\n\s*const membership = await getUserOrganization\(supabase, user\.id\);/);
  assert.match(middleware, /if \(pathname === "\/agency" \|\| pathname\.startsWith\("\/agency\/"\)\) \{\n\s*const membership = await getUserOrganization\(supabase, user\.id\);\n\s*if \(!membership\) \{/);
  assert.doesNotMatch(read("app/agency/layout.tsx"), /getUserOrganization|getRequestMembership/, "if the agency layout ever gates membership itself, the middleware branch can go too - revisit then");
});

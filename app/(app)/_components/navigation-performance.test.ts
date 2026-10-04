/**
 * Performance Pass A (navigation / perceived performance) regression tests:
 *
 *   1. every primary navigation destination has a route-level loading state,
 *      and skeletons render no data or text;
 *   2. no list toolbar navigates on mount (the duplicate server render);
 *   3. navigation links point at their final destination, never at a
 *      compatibility redirect.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/(app)/_components/navigation-performance.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { NAV_GROUPS, AGENCY_NAV_ITEM }: typeof import("./nav-items") = require("./nav-items.ts");
const { hasSearchChanged }: typeof import("../../../lib/ui/search-sync") = require("../../../lib/ui/search-sync.ts");
const { buildCalendarHref }: typeof import("../calendar/_lib/date-range") = require("../calendar/_lib/date-range.ts");
const nextConfig: typeof import("../../../next.config") = require("../../../next.config.ts");

const ROOT = process.cwd();
const exists = (relative: string) => fs.existsSync(path.join(ROOT, relative));
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// Trackpr 2.0 (step 2C): some nav entries are two views of one route
// (/people?temperature=hot, /schedule?view=list, /today?view=by-type,
// /growth#referrals), so the route checks below run on each href's path -
// every one of those paths must still be a real page with its own loading
// state and must never be a redirect.
const NAV_HREFS = [...new Set([...NAV_GROUPS.flatMap((group) => group.items.map((item) => item.href)), AGENCY_NAV_ITEM.href].map((href) => href.split(/[?#]/)[0]))];
const segmentDir = (href: string) => (href === "/agency" ? "app/agency" : `app/(app)${href}`);

// ---------------------------------------------------------------------------
// 1. Loading states
// ---------------------------------------------------------------------------

test("every primary navigation destination has its own loading.tsx, so a click answers before the server render finishes", () => {
  for (const href of NAV_HREFS) {
    assert.ok(exists(`${segmentDir(href)}/page.tsx`), `${href} is a real page`);
    assert.ok(exists(`${segmentDir(href)}/loading.tsx`), `${href} has a loading state`);
  }
});

test("nested routes under a new loading boundary have their own skeleton, never the parent list's", () => {
  for (const file of ["app/(app)/people/[id]/loading.tsx", "app/(app)/settings/sms/loading.tsx"]) assert.ok(exists(file), file);
});

const NEW_SKELETONS = ["today", "people", "schedule", "growth", "insights", "settings", "people/[id]", "settings/sms"].map((route) => `app/(app)/${route}/loading.tsx`);

test("the new skeletons render no data, no text and no data access - only pulse blocks and an accessible loading status", () => {
  for (const file of NEW_SKELETONS) {
    const source = read(file);
    assert.doesNotMatch(source, /supabase|createClient|createServiceRoleClient|await |fetch\(|searchParams|params\b|"use client"/, `${file} does no data access`);
    // The only text node a skeleton renders is the screen-reader status.
    const texts = [...source.replace(/=>/g, "").matchAll(/>([^<>{}]+)</g)].map((m) => m[1].trim()).filter(Boolean);
    assert.deepEqual([...new Set(texts)].filter((text) => text !== "Loading…"), [], `${file} renders no visible text`);
  }
  const skeleton = read("lib/ui/skeleton.tsx");
  assert.match(skeleton, /role="status" aria-busy="true" aria-live="polite"/);
  assert.match(skeleton, /<span className="sr-only">Loading…<\/span>/);
  // Trackpr 2.0 (step 2A): the pulse block's fill moved onto the --inset token.
  assert.match(skeleton, /aria-hidden className=\{`animate-pulse rounded bg-inset/);
});

test("skeletons use the real page container so the swap to content doesn't shift the layout", () => {
  // Trackpr 2.0 (step 2A): the skeleton container is the shared page
  // container constant (lib/ui/page.tsx), whose value is still the literal
  // the pages below use - so the guarantee is unchanged.
  assert.match(read("lib/ui/skeleton.tsx"), /SKELETON_PAGE_CLASS = PAGE_CONTAINER_CLASS;/);
  assert.match(read("lib/ui/page.tsx"), /PAGE_CONTAINER_CLASS = "flex flex-1 flex-col px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-9"/);
  // Trackpr 2.0 (step 2G): every page is on the shared container constants
  // now, and each page and its skeleton agree on the content width - so the
  // skeleton-to-content swap still never shifts the layout.
  for (const route of ["people", "growth", "insights", "settings", "money"]) {
    assert.match(read(`app/(app)/${route}/page.tsx`), /className=\{`\$\{PAGE_CONTAINER_CLASS\} gap-8 \$\{PAGE_MAX_WIDTH_CLASS\}`\}/, `${route} page uses the shared container at the content width`);
    assert.match(read(`app/(app)/${route}/loading.tsx`), /<SkeletonPage[^>]*width="content"/, `${route} skeleton mirrors the page's content width`);
  }
  // Trackpr 2.0 (step 2E): the Dashboard moved onto PageContainer at the
  // shared content width; its skeleton uses the same container at the same
  // width, so the guarantee holds for it too.
  assert.match(read("app/(app)/today/page.tsx"), /<PageContainer>/);
  assert.match(read("lib/ui/page.tsx"), /width = "content"/);
  assert.match(read("app/(app)/today/loading.tsx"), /<SkeletonPage width="content">/);
  assert.match(read("lib/ui/skeleton.tsx"), /\$\{width === "content" \? PAGE_MAX_WIDTH_CLASS : ""\}/);
});

// ---------------------------------------------------------------------------
// 2. No mount-time duplicate render
// ---------------------------------------------------------------------------

test("hasSearchChanged: only a real change to the search text counts; whitespace-only differences don't", () => {
  assert.equal(hasSearchChanged("", ""), false);
  assert.equal(hasSearchChanged("smith", "smith"), false);
  assert.equal(hasSearchChanged("  smith ", "smith"), false);
  assert.equal(hasSearchChanged("smith", "  smith"), false);
  assert.equal(hasSearchChanged("smit", "smith"), true);
  assert.equal(hasSearchChanged("", "smith"), true);
  assert.equal(hasSearchChanged("smith", ""), true);
});

const TOOLBARS: [string, string][] = [
  ["app/(app)/people/_components/people-search.tsx", "value"],
  ["app/(app)/contacts/_components/contacts-search.tsx", "value"],
  ["app/(app)/leads/_components/leads-toolbar.tsx", "query"],
  ["app/(app)/jobs/_components/jobs-toolbar.tsx", "query"],
  ["app/(app)/estimates/_components/estimates-toolbar.tsx", "query"],
  ["app/(app)/appointments/_components/appointments-toolbar.tsx", "query"],
  ["app/(app)/invoices/_components/invoices-toolbar.tsx", "query"],
  ["app/(app)/insights/_components/activity-toolbar.tsx", "query"],
  ["app/agency/_components/agency-toolbar.tsx", "query"],
];

test("regression: none of the nine list toolbars navigates on mount - the debounced search sync only fires on a real change", () => {
  for (const [file, stateVar] of TOOLBARS) {
    const source = read(file);
    assert.match(source, /const lastSyncedQuery = useRef\(initialQuery\.trim\(\)\);/, `${file}: starts from the text the page rendered with`);
    assert.match(source, /function navigate\(nextQuery: string[^\n]*\{\n\s*lastSyncedQuery\.current = nextQuery\.trim\(\);/, `${file}: every navigation records what it synced`);
    assert.match(source, new RegExp(`useEffect\\(\\(\\) => \\{\\n\\s*if \\(!hasSearchChanged\\(${stateVar}, lastSyncedQuery\\.current\\)\\) return;\\n\\s*const handle = setTimeout\\(\\(\\) => navigate\\(${stateVar}\\b`), `${file}: the debounced effect is guarded`);
    // A clear that bypasses navigate() must record the cleared value too.
    for (const clear of source.matchAll(/function clear\w*\(\) \{([\s\S]*?)\n {2}\}/g)) {
      if (/router\.replace/.test(clear[1])) assert.match(clear[1], /lastSyncedQuery\.current = "";/, `${file}: a direct-replace clear records the cleared search`);
    }
  }
});

test("every toolbar still debounces typing into the URL (300ms) and still navigates on filter/sort/clear - behavior preserved", () => {
  for (const [file] of TOOLBARS) {
    const source = read(file);
    assert.match(source, /setTimeout\(\(\) => navigate\([^)]*\), 300\)/, file);
    assert.match(source, /router\.replace\(/, file);
  }
});

// ---------------------------------------------------------------------------
// 3. No redirect hops in navigation
// ---------------------------------------------------------------------------

async function redirectSources(): Promise<string[]> {
  const rules = await nextConfig.default.redirects!();
  return rules.map((rule) => rule.source);
}

function isPageRedirect(href: string): boolean {
  const file = `${segmentDir(href.split("?")[0])}/page.tsx`;
  if (!exists(file)) return false;
  const source = read(file);
  // A thin page whose default export is a redirect (e.g. /inbox, /automation-health).
  return /export default (async )?function \w*Redirect|redirect\((query \? `\/|"\/)/.test(source) && !/return \(/.test(source);
}

test("no navigation link points at a next.config redirect source or a redirect-only page", async () => {
  const sources = await redirectSources();
  for (const href of NAV_HREFS) {
    assert.ok(!sources.some((source) => source === href), `${href} is a next.config redirect source`);
    assert.ok(!isPageRedirect(href), `${href} is a redirect-only page`);
  }
});

test("Inbox and the automation-health indicator link to their destinations directly", () => {
  assert.ok(isPageRedirect("/inbox"), "/inbox stays as a compatibility redirect for old links");
  assert.ok(isPageRedirect("/automation-health"), "/automation-health stays as a compatibility redirect for old links");
  // Trackpr 2.0 (step 2D): the status indicator now opens a short
  // explanation whose "View details" link carries the destination.
  assert.match(read("app/(app)/_components/system-status-model.ts"), /const detailsHref = "\/automations";/);
  assert.match(read("app/(app)/_components/system-status.tsx"), /href=\{view\.detailsHref\}/);
  for (const file of ["app/(app)/_components/top-bar.tsx", "app/(app)/_components/system-status.tsx", "app/(app)/_components/system-status-model.ts"]) {
    assert.doesNotMatch(read(file), /["'`]\/automation-health/, `${file} must not link to the compatibility redirect`);
  }
  assert.doesNotMatch(read("app/(app)/_components/breadcrumb.tsx"), /BREADCRUMB_PATH_ALIASES/);
});

test("calendar links build /schedule URLs directly - the same URL the /calendar redirect used to land on", async () => {
  assert.equal(buildCalendarHref("week", "2026-09-28"), "/schedule?view=week&date=2026-09-28");
  assert.equal(buildCalendarHref("day", "2026-10-01"), "/schedule?view=day&date=2026-10-01");
  const calendarRule = (await nextConfig.default.redirects!()).find((rule) => rule.source === "/calendar");
  assert.equal(calendarRule?.destination, "/schedule", "the compatibility redirect still exists and passes view/date through to /schedule");
});

test("appointment detail and a person's own lead list link to their final destinations", () => {
  const appointment = read("app/(app)/appointments/[id]/page.tsx");
  assert.doesNotMatch(appointment, /href="\/appointments"|backHref="\/appointments"/);
  assert.match(appointment, /backHref="\/schedule\?view=list"/);
  assert.match(read("app/(app)/people/[id]/page.tsx"), /href=\{lead\.contact_id \? `\/people\/\$\{lead\.contact_id\}` : `\/leads\/\$\{lead\.id\}`\}/);
});

/**
 * The Agency Command Center overview (app/agency/page.tsx) after its move
 * onto the client app's design system: the page must keep every state -
 * permission, error, partial data, loading, empty - and its search/filter,
 * while laying out in the shared container and primitives. This repository
 * has no DOM test environment, so the page is verified against its source,
 * the convention the app's other UI tests use (app/quote/quote-page.test.ts).
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test app/agency/agency-overview.structural.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8");
const PAGE = read("app/agency/page.tsx");
const LOADING = read("app/agency/loading.tsx");
const ERROR_BOUNDARY = read("app/agency/error.tsx");
const CLIENTS = read("app/agency/_components/client-operations.tsx");
const ATTENTION = read("app/agency/_components/needs-attention.tsx");
const ACTIVITY = read("app/agency/_components/agency-activity.tsx");
const PIPELINE = read("app/agency/_components/onboarding-pipeline.tsx");
const TOOLBAR = read("app/agency/_components/agency-toolbar.tsx");
const ERROR_STATE = read("app/agency/_components/error-state.tsx");
const UNAUTHORIZED = read("app/agency/_components/unauthorized-state.tsx");
const withoutComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const PAGE_CODE = withoutComments(PAGE);

test("layout: every render path uses the shared page container and width, never the old hand-rolled wrapper", () => {
  assert.match(PAGE, /import \{ PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS \} from "@\/lib\/ui\/page";/);
  const containers = PAGE_CODE.match(/<div className=\{`\$\{PAGE_CONTAINER_CLASS\} gap-8 \$\{PAGE_MAX_WIDTH_CLASS\}`\}>/g) ?? [];
  assert.equal(containers.length, 3, "error, unauthorized and the full page each use the shared container");
  assert.doesNotMatch(PAGE_CODE, /max-w-\[1200px\]/);
  assert.match(PAGE_CODE, /<PageHeader\s+eyebrow=\{OVERVIEW_EYEBROW\}\s+title=\{OVERVIEW_TITLE\}/);
  assert.match(PAGE_CODE, /<StatGrid columns=\{5\}>/);
  assert.equal((PAGE_CODE.match(/<StatCard\b/g) ?? []).length, 5);
});

test("permission and error: a thrown read renders ErrorState, any failed authorization renders UnauthorizedState - with no agency data", () => {
  const tryBlock = PAGE_CODE.slice(PAGE_CODE.indexOf("try {"), PAGE_CODE.indexOf("if (!metrics.ok"));
  assert.match(tryBlock, /\} catch \{\s*return \(\s*<div[^>]*>\s*<PageHeader eyebrow=\{OVERVIEW_EYEBROW\} title=\{OVERVIEW_TITLE\} \/>\s*<ErrorState retryHref="\/agency" \/>/);
  assert.match(
    PAGE_CODE,
    /if \(!metrics\.ok \|\| !health\.ok \|\| !stages\.ok \|\| !activity\.ok \|\| !today\.ok \|\| !escalations\.ok \|\| !needsAttention\.ok\) \{\s*return \(\s*<div[^>]*>\s*<PageHeader eyebrow=\{OVERVIEW_EYEBROW\} title=\{OVERVIEW_TITLE\} \/>\s*<UnauthorizedState \/>/,
  );
  // Both states are static: no props that could carry organization data.
  assert.match(UNAUTHORIZED, /export function UnauthorizedState\(\) \{/);
  assert.match(UNAUTHORIZED, /You don't have access to the Agency Command Center\./);
  assert.match(ERROR_STATE, /export function ErrorState\(\{ retryHref \}: \{ retryHref\?: string \} = \{\}\)/);
  assert.match(ERROR_STATE, /retryHref \? \(\s*<Link href=\{retryHref\}/, "Try again is a real link, shown only with a destination");
  assert.doesNotMatch(ERROR_STATE, /error\.message|\.stack/);
  // The route error boundary stays on the shared RouteError, pointed back at the overview.
  assert.match(ERROR_BOUNDARY, /<RouteError error=\{error\} reset=\{reset\} homeHref="\/agency"/);
});

test("partial data: the banner and the honest attention/empty wording are kept", () => {
  assert.match(PAGE, /const pagePartialData = health\.partialData \|\| escalations\.failed \|\| needsAttention\.partialData \|\| snapshotPartialData;/);
  assert.match(PAGE_CODE, /\{pagePartialData \? \(\s*<div role="status"[^>]*>[\s\S]*?Some information is temporarily unavailable/);
  assert.match(PAGE_CODE, /pagePartialData \? "Some data is unavailable" : "All clients operating normally"/);
  assert.match(PAGE_CODE, /<NeedsAttention items=\{needsAttention\.items\} partialData=\{pagePartialData\} \/>/);
  // An empty feed after a failed read never claims "all clear".
  assert.match(ATTENTION, /\{partialData \? \(\s*<EmptyState[\s\S]*?this list may be incomplete/);
  // Unavailable is never shown as zero.
  assert.match(PAGE_CODE, /escalationCount: escalations\.failed \? null :/);
  assert.match(PAGE_CODE, /aiEscalationCount=\{escalations\.failed \? null : escalations\.conversations\.length\}/);
  assert.match(CLIENTS, /row\.escalationCount === null \? \(\s*<span[^>]*> · escalations unavailable<\/span>/);
});

test("search and filter: q and filter are read from searchParams, applied to the rows, and driven by AgencyToolbar", () => {
  assert.match(PAGE_CODE, /const query = typeof params\.q === "string" \? params\.q : "";/);
  assert.match(PAGE_CODE, /const filter = normalizeFilter\(typeof params\.filter === "string" \? params\.filter : undefined\);/);
  assert.match(PAGE_CODE, /\.filter\(\(row\) => \(term \? row\.organization\.organizationName\.toLowerCase\(\)\.includes\(term\) : true\)\)\s*\.filter\(\(row\) => matchesFilter\(row, filter\)\);/);
  assert.match(PAGE_CODE, /<AgencyToolbar initialQuery=\{query\} initialFilter=\{filter\} \/>/);
  assert.match(PAGE_CODE, /<ClientOperations rows=\{rows\} totalCount=\{allRows\.length\} \/>/);
  assert.match(TOOLBAR, /if \(trimmed\) params\.set\("q", trimmed\);/);
  assert.match(TOOLBAR, /if \(nextFilter !== "all"\) params\.set\("filter", nextFilter\);/);
  assert.match(TOOLBAR, /aria-label="Search clients"/);
  assert.match(TOOLBAR, /aria-label="Filter clients"/);
});

test("links: client rows and deeper-intelligence pages all point at real routes", () => {
  assert.match(CLIENTS, /href=\{`\/agency\/organizations\/\$\{organization\.organizationId\}`\}/);
  assert.match(ACTIVITY, /href=\{`\/agency\/organizations\/\$\{item\.organizationId\}`\}/);
  assert.match(PIPELINE, /href=\{`\/agency\/organizations\/\$\{client\.organizationId\}`\}/);
  for (const href of ["/agency/expansion", "/agency/usage", "/agency/revenue", "/agency/costs"]) {
    assert.ok(PAGE_CODE.includes(`href: "${href}"`), href);
    assert.ok(fs.existsSync(path.join(process.cwd(), `app${href}/page.tsx`)), `${href} is a real route`);
  }
  // Search/filter state lives in AgencyToolbar; nothing outside it rewrites q or filter.
  assert.doesNotMatch(PAGE_CODE, /\?filter=/);
});

test("empty states: no clients, no matches, no attention items, no onboarding, no activity each say what to expect", () => {
  assert.match(CLIENTS, /totalCount === 0 \? \(\s*<EmptyState[\s\S]*?No client organizations are connected yet\./);
  assert.match(CLIENTS, /No clients match your search or filter\.[\s\S]*?Clear filters/);
  assert.match(ATTENTION, /All clients are operating normally\./);
  assert.match(PIPELINE, /No clients in onboarding\./);
  assert.match(PIPELINE, /No clients currently in onboarding\./);
  assert.match(ACTIVITY, /items\.length === 0 \? \(\s*<div[^>]*>\s*<EmptyState[\s\S]*?No client activity yet\./);
});

test("loading: the skeleton mirrors the new layout in the shared container", () => {
  assert.match(LOADING, /<SkeletonPage width="content">/);
  assert.match(LOADING, /<SkeletonPageHeader \/>/);
  assert.match(LOADING, /Array\.from\(\{ length: 5 \}\)[\s\S]*?<SkeletonStatCard/);
  assert.doesNotMatch(LOADING, /max-w-\[1200px\]/);
});

test("accessibility: one h1 via PageHeader, h2 per section, focus rings on row links", () => {
  assert.doesNotMatch(PAGE_CODE, /<h1\b/, "the h1 comes from PageHeader");
  assert.match(read("app/agency/_components/section.tsx"), /<section aria-labelledby=\{id\}[\s\S]*?<h2 id=\{id\}/);
  for (const source of [CLIENTS, ATTENTION]) assert.match(source, /focus-visible:inset-ring-2 focus-visible:inset-ring-accent\/40/);
});

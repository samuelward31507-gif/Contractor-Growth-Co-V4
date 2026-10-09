/**
 * Agency intelligence pages (Revenue, Costs, Usage, Expansion): the redesign
 * onto the client app's design system must keep every state each page had -
 * the unauthorized path, the error path, the partial-data disclosure, the
 * empty states - and add a route-level loading state to each. This
 * repository has no DOM test environment, so the pages are verified against
 * their source, the convention app/quote/quote-page.test.ts and
 * lib/agency/agency-consistency.test.ts use.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test app/agency/agency-intelligence.structural.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const exists = (relative: string) => fs.existsSync(path.join(ROOT, relative));
/** Every source file under a route folder (page, loading, _components). */
function routeSource(route: string): string {
  const dir = path.join(ROOT, "app/agency", route);
  const files: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) files.push(full);
    }
  };
  walk(dir);
  return files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
}

const ROUTES = ["revenue", "costs", "usage", "expansion"] as const;

for (const route of ROUTES) {
  const page = read(`app/agency/${route}/page.tsx`);

  test(`${route}: the page sits in the standard page container at the shared max width`, () => {
    assert.match(page, /import \{ PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS \} from "@\/lib\/ui\/page";/);
    assert.match(page, /const PAGE_CLASS = `\$\{PAGE_CONTAINER_CLASS\} gap-8 \$\{PAGE_MAX_WIDTH_CLASS\}`;/);
    // Every return path (content, error, unauthorized) uses it - no hand-rolled max-w container left.
    assert.equal((page.match(/<div className=\{PAGE_CLASS\}>/g) ?? []).length, 3, "content, error and unauthorized paths");
    assert.doesNotMatch(page, /max-w-\[11\d\dpx\]/);
  });

  test(`${route}: the shared PageHeader with the Agency eyebrow`, () => {
    assert.match(page, /<PageHeader\s+eyebrow="Agency"/);
  });

  test(`${route}: a loading.tsx on the shared skeleton primitives`, () => {
    assert.ok(exists(`app/agency/${route}/loading.tsx`), "loading.tsx exists");
    const loading = read(`app/agency/${route}/loading.tsx`);
    assert.match(loading, /from "@\/lib\/ui\/skeleton"/);
    assert.match(loading, /<SkeletonPage width="content">/);
    assert.match(loading, /export default function/);
  });

  test(`${route}: the unauthorized and error paths are kept`, () => {
    assert.match(page, /import \{ UnauthorizedState \} from "\.\.\/_components\/unauthorized-state";/);
    assert.match(page, /import \{ ErrorState \} from "\.\.\/_components\/error-state";/);
    // A thrown read renders the generic ErrorState - never the raw error.
    assert.match(page, /\} catch \{\s*return \(\s*<div className=\{PAGE_CLASS\}>\s*<ErrorState \/>/);
    // A failed authorization renders UnauthorizedState and nothing else.
    assert.match(page, /if \(![^)]*\.ok[^)]*\) \{\s*return \(\s*<div className=\{PAGE_CLASS\}>\s*<UnauthorizedState \/>\s*<\/div>\s*\);\s*\}/);
  });

  test(`${route}: empty states use the shared EmptyState`, () => {
    const source = routeSource(route);
    assert.match(source, /from "@\/lib\/ui\/empty-state"/);
    assert.match(source, /<EmptyState\b/);
  });

  test(`${route}: a read failure is still disclosed in a banner`, () => {
    assert.match(page, /\{partialData(?: \|\| smsPartialData)? \? \(\s*<div role="status"/);
  });
}

test("revenue: the Stripe-only labeling, range presets and the — for a failed read are kept", () => {
  const page = read("app/agency/revenue/page.tsx");
  assert.match(page, /result = await getAgencyRevenue\(supabase, service, RANGE_PARAM_TO_INPUT\[rangeKey\]\);/);
  assert.match(page, /if \(value === "today" \|\| value === "month" \|\| value === "lastMonth"\) return value;\s*return "lifetime";/);
  assert.match(page, /recorded from real Stripe payment events/);
  assert.match(page, /not contractor\/customer job revenue/);
  for (const component of ["RevenueHeadline", "CollectedByCategory", "ClientRevenueTable", "RecentRevenueEvents"]) {
    assert.match(page, new RegExp(`<${component}[^>]*unavailable=\\{partialData\\}`), component);
  }
  const summary = read("app/agency/revenue/_components/revenue-summary.tsx");
  assert.match(summary, /return unavailable \? UNAVAILABLE : formatCurrencyAmounts\(amounts\);/);
  assert.match(summary, /export const UNAVAILABLE = "—";/);
  // A failed payment stays its own figure, never part of collected or net.
  assert.match(summary, /label="Failed payment attempts"/);
  const events = read("app/agency/revenue/_components/recent-revenue-events.tsx");
  assert.match(events, /\{unavailable \? \(\s*<EmptyState icon=\{AlertCircle\} title="Revenue events couldn't be loaded"/);
  assert.match(read("app/agency/revenue/_components/client-revenue-table.tsx"), /title="No managed clients yet"/);
});

test("costs: AI and SMS stay separate reads with their own — on failure; unsupported providers are kept", () => {
  const page = read("app/agency/costs/page.tsx");
  assert.match(page, /getAgencyAiCosts\(supabase, service, RANGE_PARAM_TO_INPUT\[rangeKey\]\),\s*getAgencySmsCosts\(supabase, service, RANGE_PARAM_TO_INPUT\[rangeKey\]\),/);
  assert.match(page, /if \(!result\.ok \|\| !smsResult\.ok\) \{/);
  assert.match(page, /<CostHeadline ai=\{totals\} aiUnavailable=\{partialData\} sms=\{smsTotals\} smsUnavailable=\{smsPartialData\} \/>/);
  assert.match(page, /<ClientCostTable clients=\{clients\} unavailable=\{partialData\} \/>/);
  assert.match(page, /<SmsCostSummary clients=\{smsClients\} unavailable=\{smsPartialData\} \/>/);
  assert.match(page, /<UnsupportedProviders \/>/);
  const format = read("app/agency/costs/_components/format.ts");
  assert.match(format, /return unavailable \? UNAVAILABLE : formatCostAmounts\(amounts\);/);
  assert.match(format, /return unavailable \? UNAVAILABLE : new Intl\.NumberFormat/);
  // Unpriced/Unknown are counts, never dollar figures.
  const headline = read("app/agency/costs/_components/ai-cost-summary.tsx");
  assert.match(headline, /label="Unpriced AI interactions"\s*value=\{countValue\(/);
  assert.match(headline, /label="Unknown AI interactions"\s*value=\{countValue\(/);
  assert.match(headline, /label="Unknown SMS messages"\s*value=\{countValue\(/);
  for (const name of ["Voice", "n8n", "Vercel", "Supabase", "Email"]) assert.ok(read("app/agency/costs/_components/unsupported-providers.tsx").includes(`name: "${name}"`), name);
});

test("usage: the one read, the busiest-first sort, Unavailable for a failed AI or missed-call read", () => {
  const page = read("app/agency/usage/page.tsx");
  assert.match(page, /result = await getAgencyCostReadiness\(supabase, service\);/);
  assert.match(page, /const sortedClients = \[\.\.\.clients\]\.sort\(\(a, b\) => totalActivity\(b\) - totalActivity\(a\)\);/);
  assert.match(page, /value=\{totals\.totalMissedCalls === null \? "—" : formatCount\(totals\.totalMissedCalls\)\}/);
  assert.match(page, /<CostReadinessSection clients=\{result\.costReadiness\.clients\} \/>/);
  const rows = read("app/agency/usage/_components/client-usage-rows.tsx");
  assert.match(rows, /if \(clients\.length === 0\) \{\s*return <NoClientsState \/>;/);
  assert.match(rows, /client\.ai\.unavailable \? \(\s*<span className="text-ink-3">Unavailable<\/span>/);
  assert.match(rows, /client\.voice\.missedCalls === null \? <span className="text-ink-3">Unavailable<\/span>/);
  assert.match(rows, /from "@\/lib\/ui\/table"/);
});

test("expansion: both reads, the known-value sort, and an empty state that never claims 'nothing found' after a failed read", () => {
  const page = read("app/agency/expansion/page.tsx");
  assert.match(page, /getAgencyExpansionOpportunities\(supabase, service\),\s*getAgencyExpansionReadiness\(supabase, service\),/);
  assert.match(page, /if \(!opportunitiesResult\.ok \|\| !readinessResult\.ok\) \{/);
  assert.match(page, /const knownDiff = knownValueFor\(b\.items\) - knownValueFor\(a\.items\);/);
  assert.match(page, /\{opportunities\.length === 0 \? \(\s*partialData \? \(\s*<EmptyState[\s\S]*?\) : \(\s*<NoOpportunitiesState \/>/);
  assert.match(page, /\{clients\.length === 0 \? \(\s*<EmptyState/);
});

test("no page fabricates a chart or demo figure", () => {
  for (const route of ROUTES) {
    const source = routeSource(route);
    assert.doesNotMatch(source, /lib\/ui\/chart/, `${route}: no chart without a real series`);
    assert.doesNotMatch(source, /\b(demo|sample|placeholder)Data\b|Math\.random/i, route);
  }
});

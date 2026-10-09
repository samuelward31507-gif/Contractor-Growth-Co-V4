/**
 * Structural tests for the Agency client detail page
 * (app/agency/organizations/[id]) after its move onto the client app's
 * design system. This repository has no DOM test environment, so - like
 * app/quote/quote-page.test.ts and ./automation-pause-control.test.ts - the
 * page is verified against its source.
 *
 * Lives here, not inside [id]/, because Node's test runner treats "[id]" in
 * a path as a glob character class and would silently skip the file.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test app/agency/organizations/organization-detail.structural.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8");
const DIR = "app/agency/organizations/[id]";
const PAGE = read(`${DIR}/page.tsx`);
const LOADING = read(`${DIR}/loading.tsx`);
const STATES = read(`${DIR}/_components/page-states.tsx`);
const INCIDENTS = read(`${DIR}/_components/incidents-table.tsx`);
const AUTOMATIONS = read(`${DIR}/_components/automations-table.tsx`);
const withoutComments = (code: string) => code.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("layout: DetailHeader back to /agency with the organization name, then the standard page container", () => {
  assert.match(PAGE, /import \{ DetailHeader \} from "@\/lib\/ui\/detail-header";/);
  assert.match(PAGE, /import \{ PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS \} from "@\/lib\/ui\/page";/);
  assert.match(PAGE, /<DetailHeader\s+eyebrow="Client"\s+backHref="\/agency"\s+backLabel="Back to Agency Command Center"\s+title=\{org\.organizationName\}/);
  assert.match(PAGE, /className=\{`\$\{PAGE_CONTAINER_CLASS\} gap-6 \$\{PAGE_MAX_WIDTH_CLASS\}`\}/);
  assert.doesNotMatch(PAGE, /max-w-\[1100px\]/, "the old one-off page width is gone");
  assert.doesNotMatch(PAGE, /PageHeader/, "the detail page uses DetailHeader, not the list-page header");
  // Status badges stay in the header.
  assert.match(PAGE, /badges=\{[\s\S]*?<Badge tone=\{STAGE_TONE\[checklist\.stage\]\}>\{ONBOARDING_STAGE_LABEL\[checklist\.stage\]\}<\/Badge>[\s\S]*?Needs attention[\s\S]*?Healthy/);
});

test("layout: key metrics in a StatGrid, grouped sections in SectionCards, lists on the shared table primitives", () => {
  assert.match(PAGE, /<StatGrid columns=\{4\}>/);
  assert.equal((PAGE.match(/<StatCard\b/g) ?? []).length, 4);
  for (const title of ["Live activity", "Automation", "Communication", "Automations", "Active incidents", "Business performance", "AI activity", "Client", "Setup", "Readiness", "Test lead"]) {
    assert.match(PAGE, new RegExp(`<SectionCard\\s+title="${title}"`), title);
  }
  for (const source of [INCIDENTS, AUTOMATIONS]) {
    assert.match(source, /import \{ Table, TableHeadCell, TableBody, TableCell \} from "@\/lib\/ui\/table";/);
    assert.match(source, /lg:hidden/, "a stacked list below lg, since the shared table is desktop-only");
  }
  assert.doesNotMatch(PAGE, /recharts|<svg|<canvas/i, "no charts on this page");
});

test("authorization: a thrown read, a non-admin caller, and an unknown or foreign organization each render their own state, in the original order", () => {
  const code = withoutComments(PAGE);
  const catchIdx = code.indexOf("} catch {");
  const loadErrorIdx = code.indexOf("<ClientLoadErrorState />");
  const adminGuardIdx = code.indexOf("if (!metrics.ok || !health.ok || !today.ok || !escalations.ok || !needsAttention.ok) {");
  const unauthorizedIdx = code.indexOf("<UnauthorizedState />");
  const orgGuardIdx = code.indexOf("if (!org || !orgHealth || !automations.ok) {");
  const unavailableIdx = code.indexOf("<ClientUnavailableState />");
  const secondReadsIdx = code.indexOf("listIncidents(service, id,");
  for (const [name, idx] of Object.entries({ catchIdx, loadErrorIdx, adminGuardIdx, unauthorizedIdx, orgGuardIdx, unavailableIdx, secondReadsIdx })) {
    assert.ok(idx !== -1, `${name} present`);
  }
  assert.ok(catchIdx < loadErrorIdx && loadErrorIdx < adminGuardIdx, "a thrown read renders the load-error state");
  assert.ok(adminGuardIdx < unauthorizedIdx && unauthorizedIdx < orgGuardIdx, "a non-admin caller renders UnauthorizedState");
  assert.ok(orgGuardIdx < unavailableIdx && unavailableIdx < secondReadsIdx, "an unknown organization renders the unavailable state before any org-scoped read");
  // Each state sits in the standard page container.
  assert.match(STATES, /export function StatePage[\s\S]*?\$\{PAGE_CONTAINER_CLASS\} gap-6 \$\{PAGE_MAX_WIDTH_CLASS\}/);
  assert.equal((code.match(/<StatePage>/g) ?? []).length, 3);
});

test("authorization: the not-found state never confirms an organization exists and renders no organization data", () => {
  assert.match(STATES, /export function ClientUnavailableState\(\) \{/, "takes no props, so no organization data can reach it");
  assert.match(STATES, /export function ClientLoadErrorState\(\) \{/);
  assert.match(STATES, /It may not exist, or it isn't one of the clients your agency manages\./);
  assert.match(STATES, /href="\/agency"/, "every state has a real way back");
  assert.doesNotMatch(STATES, /error\.message|\.stack/);
});

test("automation pause control is still rendered in the header with the real id and the fail-closed persisted state", () => {
  assert.match(PAGE, /action=\{<AutomationPauseControl organizationId=\{id\} isPaused=\{isAutomationPaused\} \/>\}/);
  assert.match(PAGE, /const isAutomationPaused = automationPauseRow\.error \? true : Boolean\(automationPauseRow\.data\?\.automation_paused\);/);
  assert.match(PAGE, /import \{ AutomationPauseControl \} from "\.\/_components\/automation-pause-control";/);
});

test("empty states: every list section says what is empty and why, instead of rendering nothing", () => {
  assert.match(PAGE, /dashboardData\.recentActivity\.length === 0 \? \(\s*<SectionEmpty\s+title="No activity yet for this client\."/);
  assert.match(PAGE, /<SectionEmpty title="No AI activity recorded for this client yet\."/);
  assert.match(PAGE, /<SectionEmpty title="No test has been attempted yet\."/);
  assert.match(PAGE, /Everything required is complete\./);
  assert.match(AUTOMATIONS, /automations\.length === 0[\s\S]*?<SectionEmpty title="No automations are configured for this client yet\."/);
  assert.match(INCIDENTS, /title="No active operational incidents for this organization\."/);
  // An unreadable incident list is not presented as a confirmed zero.
  assert.match(INCIDENTS, /unavailable \? \(\s*<SectionEmpty title="Incidents couldn't be read for this client\."/);
  assert.match(PAGE, /<IncidentsTable incidents=\{incidents\} unavailable=\{orgHealth\.incidentsUnavailable\} \/>/);
});

test("unavailable values: a figure that could not be read shows '—' or Unavailable, never 0", () => {
  assert.doesNotMatch(PAGE, /orgToday\?\.leadsToday \?\? 0|orgToday\?\.appointmentsToday \?\? 0/);
  assert.match(PAGE, /value=\{orgToday \? formatCount\(orgToday\.leadsToday\) : "—"\}/);
  assert.match(PAGE, /value=\{orgToday \? formatCount\(orgToday\.appointmentsToday\) : "—"\}/);
  assert.match(PAGE, /value=\{escalationCount === null \? "—" : formatCount\(escalationCount\)\}/);
  assert.match(PAGE, /value=\{incidentsUnreadable \? "—" : formatCount\(incidents\.length\)\}/);
  assert.match(PAGE, /\{clientPartialData \? \(\s*<div role="status"/);
  assert.match(PAGE, /org\.automationFailed \? \([\s\S]*?value="Unavailable"/);
  assert.match(PAGE, /org\.communicationFailed \? \([\s\S]*?value="Unavailable"/);
});

test("loading: a skeleton of the new layout - header band, StatGrid, two columns - in the standard container, with no data", () => {
  assert.match(LOADING, /role="status" aria-busy="true"/);
  assert.match(LOADING, /<span className="sr-only">Loading client…<\/span>/);
  assert.match(LOADING, /\$\{PAGE_CONTAINER_CLASS\} gap-6 \$\{PAGE_MAX_WIDTH_CLASS\}/);
  assert.match(LOADING, /border-b border-line bg-surface/, "mirrors the DetailHeader band");
  assert.match(LOADING, /<StatGrid columns=\{4\}>[\s\S]*?<SkeletonStatCard/);
  assert.match(LOADING, /lg:grid-cols-3[\s\S]*?lg:col-span-2/);
  assert.doesNotMatch(LOADING, /max-w-\[1100px\]/);
});

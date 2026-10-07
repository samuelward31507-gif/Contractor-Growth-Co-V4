/**
 * Pure, dependency-free tests of the nav foundation. Rewritten for Batch 2
 * (navigation, shell & information architecture): the sidebar is YOU
 * (Today, People, Inbox, Schedule, Money, Insights), TRACKPR (Trackpr), and
 * a pinned Settings / Agency Command Center foot; the mobile bar is Today,
 * People, Inbox, Money, More. See nav-items.ts's header comment. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test "app/(app)/_components/nav-items.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { NAV_GROUPS, AGENCY_NAV_ITEM, TRACKPR_HREF, getNavGroupsForVertical, resolveActiveNavItem }: typeof import("./nav-items") = require("./nav-items.ts");
const { legacyRedirectTarget }: typeof import("../../../lib/navigation/legacy-redirect") = require("../../../lib/navigation/legacy-redirect.ts");
const { normalizeBrowse, MONEY_TABS }: typeof import("../money/_components/money-views") = require("../money/_components/money-views.ts");
const nextConfig: typeof import("../../../next.config") = require("../../../next.config.ts");

const hrefsOf = (groups: ReturnType<typeof getNavGroupsForVertical>) => groups.flatMap((g) => g.items.map((i) => i.href));
const pathOf = (href: string) => href.split(/[?#]/)[0];
const read = (file: string) => fs.readFileSync(file, "utf8");

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

test("the sidebar is exactly YOU, TRACKPR, then the pinned system foot", () => {
  assert.deepEqual(
    NAV_GROUPS.map((g) => [g.id, g.label]),
    [
      ["you", "You"],
      ["trackpr", "Trackpr"],
      ["system", null],
    ],
  );
});

test("YOU contains exactly Today, People, Inbox, Schedule, Money, Insights - in that order", () => {
  const you = getNavGroupsForVertical("contractor", false).find((g) => g.id === "you");
  assert.deepEqual(
    you?.items.map((i) => [i.label, i.href, i.icon]),
    [
      ["Today", "/today", "House"],
      ["People", "/people", "Users"],
      ["Inbox", "/conversations", "Inbox"],
      ["Schedule", "/schedule", "CalendarDays"],
      ["Money", "/money", "Wallet"],
      ["Insights", "/insights", "ChartColumn"],
    ],
  );
});

test("TRACKPR is one destination, Trackpr, at /autopilot - not /trackpr (the public product page) and not /automations", () => {
  const trackpr = NAV_GROUPS.find((g) => g.id === "trackpr");
  assert.deepEqual(trackpr?.items.map((i) => [i.label, i.href]), [["Trackpr", "/autopilot"]]);
  assert.equal(TRACKPR_HREF, "/autopilot");
  assert.ok(fs.existsSync("app/(cinder)/trackpr/page.tsx"), "/trackpr stays the public Cinder page");
  assert.ok(fs.existsSync("app/(app)/autopilot/page.tsx") && fs.existsSync("app/(app)/autopilot/loading.tsx"));
});

test("the foot holds Settings, and Agency Command Center only for a verified agency admin", () => {
  assert.deepEqual(getNavGroupsForVertical("contractor", false).find((g) => g.id === "system")!.items.map((i) => i.href), ["/settings"]);
  assert.deepEqual(getNavGroupsForVertical("contractor", true).find((g) => g.id === "system")!.items.map((i) => i.href), ["/settings", "/agency"]);
  assert.equal(AGENCY_NAV_ITEM.label, "Agency Command Center");
  for (const group of getNavGroupsForVertical("contractor", true).filter((g) => g.id !== "system")) {
    assert.ok(!group.items.some((i) => i.href === "/agency"), `${group.id} must not contain /agency`);
  }
});

test("no retired destination is a primary nav entry, for either vertical, with or without the agency link", () => {
  const retired = ["/dashboard", "/customers", "/leads", "/contacts", "/work", "/estimates", "/jobs", "/invoices", "/opportunities", "/analytics", "/automations", "/automation-health", "/activity", "/growth", "/inbox", "/calendar", "/appointments"];
  const retiredLabels = ["Dashboard", "Customers", "Leads", "Contacts", "Work", "Estimates", "Jobs", "Opportunities", "Analytics", "Automations", "Activity", "Reviews", "Referrals"];
  for (const vertical of ["contractor", "gym"] as const) {
    for (const showAgencyLink of [true, false]) {
      const groups = getNavGroupsForVertical(vertical, showAgencyLink);
      const paths = hrefsOf(groups).map(pathOf);
      for (const href of retired) assert.ok(!paths.includes(href), `${href} (vertical=${vertical}, agency=${showAgencyLink})`);
      const labels = groups.flatMap((g) => g.items.map((i) => i.label));
      for (const label of retiredLabels) assert.ok(!labels.includes(label), `${label} (vertical=${vertical})`);
    }
  }
});

test("user-facing nav labels are plain language - no CRM/pipeline/workflow/automation/system jargon", () => {
  const labels = [...NAV_GROUPS.flatMap((g) => [g.label ?? "", ...g.items.map((i) => i.label)])].join(" ");
  assert.doesNotMatch(labels, /\b(CRM|Pipeline|Workflow|Automation|Execution|AI Agent|Operations|System)\b/i);
});

test("a gym sees Members for People and no Money; a contractor sees People and Money", () => {
  const gym = getNavGroupsForVertical("gym", false).flatMap((g) => g.items.map((i) => `${i.href}:${i.label}`));
  const contractor = getNavGroupsForVertical("contractor", false).flatMap((g) => g.items.map((i) => `${i.href}:${i.label}`));
  assert.ok(gym.includes("/people:Members"));
  assert.ok(!gym.some((e) => e.startsWith("/money")));
  assert.ok(contractor.includes("/people:People"));
  assert.ok(contractor.includes("/money:Money"));
});

test("no href or label appears twice, and group ids are unique", () => {
  for (const vertical of ["contractor", "gym"] as const) {
    for (const showAgencyLink of [true, false]) {
      const groups = getNavGroupsForVertical(vertical, showAgencyLink);
      const hrefs = hrefsOf(groups);
      const labels = groups.flatMap((g) => g.items.map((i) => i.label));
      assert.equal(hrefs.length, new Set(hrefs).size, hrefs.join(", "));
      assert.equal(labels.length, new Set(labels).size, labels.join(", "));
    }
  }
  assert.equal(new Set(NAV_GROUPS.map((g) => g.id)).size, NAV_GROUPS.length);
});

// ---------------------------------------------------------------------------
// Active state - exact, nested, query views, detail pages, legacy aliases
// ---------------------------------------------------------------------------

const ITEMS = [...NAV_GROUPS.flatMap((g) => g.items), AGENCY_NAV_ITEM];
const activeLabel = (pathname: string, search = "", hash = "") => resolveActiveNavItem(ITEMS, { pathname, search, hash })?.label ?? null;

test("each destination is active on its own route", () => {
  assert.equal(activeLabel("/today"), "Today");
  assert.equal(activeLabel("/people"), "People");
  assert.equal(activeLabel("/conversations"), "Inbox");
  assert.equal(activeLabel("/schedule"), "Schedule");
  assert.equal(activeLabel("/money"), "Money");
  assert.equal(activeLabel("/insights"), "Insights");
  assert.equal(activeLabel("/autopilot"), "Trackpr");
  assert.equal(activeLabel("/settings"), "Settings");
});

test("views inside a destination keep it active", () => {
  assert.equal(activeLabel("/people", "view=leads"), "People");
  assert.equal(activeLabel("/people", "view=leads&temperature=hot"), "People");
  for (const browse of ["estimates", "jobs", "invoices", "payments"]) {
    assert.equal(activeLabel("/money", `browse=${browse}`), "Money");
    assert.equal(activeLabel("/money", `view=${browse}`), "Money");
  }
  assert.equal(activeLabel("/money", "browse=invoices&status=overdue"), "Money");
  assert.equal(activeLabel("/schedule", "view=list&apptView=past"), "Schedule");
  assert.equal(activeLabel("/schedule", "view=week&date=2026-09-28"), "Schedule");
  assert.equal(activeLabel("/today", "view=by-type", "#opportunities"), "Today");
  assert.equal(activeLabel("/conversations", "filter=needs-you"), "Inbox");
});

test("deep pages name the destination they belong to", () => {
  assert.equal(activeLabel("/people/abc"), "People");
  assert.equal(activeLabel("/customers/abc"), "People");
  assert.equal(activeLabel("/leads/abc"), "People");
  assert.equal(activeLabel("/contacts/duplicates"), "People");
  assert.equal(activeLabel("/conversations/abc"), "Inbox");
  assert.equal(activeLabel("/inbox/abc"), "Inbox");
  assert.equal(activeLabel("/appointments/abc"), "Schedule");
  assert.equal(activeLabel("/estimates/abc"), "Money");
  assert.equal(activeLabel("/jobs/abc"), "Money");
  assert.equal(activeLabel("/invoices/abc"), "Money");
  assert.equal(activeLabel("/automations"), "Trackpr");
  assert.equal(activeLabel("/automations/lead-followup"), "Trackpr");
  assert.equal(activeLabel("/growth", "", "#referrals"), "Trackpr");
  assert.equal(activeLabel("/settings/sms"), "Settings");
  assert.equal(activeLabel("/agency/usage"), "Agency Command Center");
});

test("legacy list routes resolve to their new home", () => {
  assert.equal(activeLabel("/dashboard"), "Today");
  assert.equal(activeLabel("/opportunities"), "Today");
  assert.equal(activeLabel("/contacts"), "People");
  assert.equal(activeLabel("/leads"), "People");
  assert.equal(activeLabel("/customers"), "People");
  assert.equal(activeLabel("/inbox"), "Inbox");
  assert.equal(activeLabel("/calendar"), "Schedule");
  assert.equal(activeLabel("/appointments"), "Schedule");
  assert.equal(activeLabel("/work"), "Money");
  assert.equal(activeLabel("/estimates"), "Money");
  assert.equal(activeLabel("/jobs"), "Money");
  assert.equal(activeLabel("/invoices"), "Money");
  assert.equal(activeLabel("/analytics"), "Insights");
  assert.equal(activeLabel("/activity"), "Insights");
  assert.equal(activeLabel("/automation-health"), "Trackpr");
});

test("an unrelated route resolves to nothing, and a path prefix is never a false match", () => {
  assert.equal(activeLabel("/onboarding"), null);
  assert.equal(activeLabel("/peoplex"), null);
  assert.equal(activeLabel("/todayish"), null);
  assert.equal(activeLabel("/moneybags"), null);
  assert.equal(activeLabel("/trackpr"), null, "the public product page is not the app's Trackpr");
});

// ---------------------------------------------------------------------------
// Mobile
// ---------------------------------------------------------------------------

test("mobile: five slots - Today, People, Inbox, Money (Schedule for a gym), More - every tab a real nav destination", () => {
  const source = read("app/(app)/_components/mobile-tab-bar.tsx");
  const tabs = [...source.matchAll(/\{ label: "([^"]+)", icon: \w+, href: "([^"]+)" \}/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(tabs, [
    ["Today", "/today"],
    ["People", "/people"],
    ["Inbox", "/conversations"],
    ["Money", "/money"],
    ["Schedule", "/schedule"],
  ]);
  const navHrefs = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href));
  for (const [, href] of tabs) assert.ok(navHrefs.includes(href), href);
  assert.match(source, /<span>More<\/span>/);
  assert.match(source, /vertical === "contractor" \? \{ label: "Money"[^}]+\} : \{ label: "Schedule"/);
});

test("mobile: the More sheet holds everything the tabs don't - Schedule, Insights, Trackpr, then Settings", () => {
  const source = read("app/(app)/_components/mobile-tab-bar.tsx");
  assert.match(source, /const sheetGroups = groups\s*\.filter\(\(group\) => group\.id !== "system"\)\s*\.map\(\(group\) => \(\{ \.\.\.group, items: group\.items\.filter\(\(item\) => !tabHrefs\.has\(item\.href\)\) \}\)\)/);
  const tabHrefs = new Set(["/today", "/people", "/conversations", "/money"]);
  const sheet = getNavGroupsForVertical("contractor", false)
    .filter((g) => g.id !== "system")
    .flatMap((g) => g.items.filter((i) => !tabHrefs.has(i.href)).map((i) => i.label));
  assert.deepEqual(sheet, ["Schedule", "Insights", "Trackpr"]);
  assert.match(source, /systemGroup\.items\.map/);
});

// ---------------------------------------------------------------------------
// Legacy redirects
// ---------------------------------------------------------------------------

test("legacyRedirectTarget keeps every incoming param, takes the first of a repeated one, and lets the destination's own view win", () => {
  assert.equal(legacyRedirectTarget("/money", {}, { browse: "estimates" }), "/money?browse=estimates");
  assert.equal(legacyRedirectTarget("/money", { q: "smith", status: "sent" }, { browse: "estimates" }), "/money?q=smith&status=sent&browse=estimates");
  assert.equal(legacyRedirectTarget("/money", { new: "estimate", contactId: "c1" }, { browse: "estimates" }), "/money?new=estimate&contactId=c1&browse=estimates");
  assert.equal(legacyRedirectTarget("/money", { browse: "jobs", status: ["overdue", "x"] }, { browse: "invoices" }), "/money?status=overdue&browse=invoices");
  assert.equal(legacyRedirectTarget("/today", {}), "/today");
  assert.equal(legacyRedirectTarget("/today", { skipped: undefined }), "/today");
});

test("/estimates, /jobs and /invoices are redirect-only pages into Money's views - /invoices no longer 404s", () => {
  for (const [route, browse] of [["estimates", "estimates"], ["jobs", "jobs"], ["invoices", "invoices"]] as const) {
    const file = `app/(app)/${route}/page.tsx`;
    assert.ok(fs.existsSync(file), `${file} exists`);
    const source = read(file);
    assert.match(source, new RegExp(`redirect\\(legacyRedirectTarget\\("/money", await searchParams, \\{ browse: "${browse}" \\}\\)\\);`));
    assert.doesNotMatch(source, /return \(/, `${file} renders nothing of its own - no duplicated page`);
  }
  for (const detail of ["estimates/[id]", "jobs/[id]", "invoices/[id]"]) assert.ok(fs.existsSync(`app/(app)/${detail}/page.tsx`), `${detail} detail page kept`);
});

test("Money: browse is canonical, view is an alias, and the five views are Overview, Estimates, Jobs, Invoices, Payments", () => {
  assert.deepEqual(MONEY_TABS.map((t) => [t.label, t.href]), [
    ["Overview", "/money"],
    ["Estimates", "/money?browse=estimates"],
    ["Jobs", "/money?browse=jobs"],
    ["Invoices", "/money?browse=invoices"],
    ["Payments", "/money?browse=payments"],
  ]);
  for (const view of ["estimates", "jobs", "invoices", "payments"]) assert.equal(normalizeBrowse(view), view);
  for (const other of [undefined, "", "money", "bogus", "constructor"]) assert.equal(normalizeBrowse(other), "money");
  assert.match(read("app/(app)/money/page.tsx"), /normalizeBrowse\(typeof params\.browse === "string" \? params\.browse : typeof params\.view === "string" \? params\.view : undefined\)/);
});

test("People: one destination with Everyone and Leads views; the Leads view stays reachable", () => {
  const views = read("app/(app)/people/_components/people-views.tsx");
  assert.match(views, /\{ value: "all", label: everyoneLabel, href: "\/people" \}/);
  assert.match(views, /\{ value: "leads", label: "Leads", href: "\/people\?view=leads" \}/);
  assert.match(read("app/(app)/people/page.tsx"), /<PeopleViews active=\{leadsView \? "leads" : "all"\}/);
});

test("the people/schedule/inbox/today legacy redirects still land where they did, without loops", async () => {
  const rules = await nextConfig.default.redirects!();
  const bySource = (source: string) => rules.filter((rule) => rule.source === source).map((rule) => rule.destination);
  assert.deepEqual(bySource("/leads"), ["/people?view=leads"]);
  assert.deepEqual(bySource("/contacts"), ["/people"]);
  assert.deepEqual(bySource("/calendar"), ["/schedule"]);
  assert.match(read("app/(app)/customers/page.tsx"), /redirect\("\/people"\)/);
  assert.match(read("app/(app)/dashboard/page.tsx"), /`\/today\?\$\{query\}` : "\/today"/);
  assert.match(read("app/(app)/inbox/page.tsx"), /`\/conversations\?\$\{query\}` : "\/conversations"/);
  assert.match(read("app/(app)/opportunities/page.tsx"), /redirect\("\/today\?view=by-type#opportunities"\)/);
  // No loops: no redirect destination is itself a redirect source.
  const sources = new Set(rules.map((rule) => rule.source));
  for (const rule of rules) assert.ok(!sources.has(pathOf(rule.destination)), `${rule.source} -> ${rule.destination} loops`);
  for (const target of ["/money", "/today", "/people", "/conversations", "/insights", "/autopilot"]) {
    const page = read(`app/(app)${target}/page.tsx`);
    assert.doesNotMatch(page, /export default (async )?function \w*Redirect/, `${target} is a real page, never another redirect`);
  }
});

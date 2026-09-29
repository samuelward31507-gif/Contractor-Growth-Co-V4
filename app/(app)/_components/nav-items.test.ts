/**
 * Pure, dependency-free tests of the nav foundation. Originally Gym
 * Foundation Phase 1, Section 6; rewritten for the IA consolidation pass and
 * the nav-restructure pass; rewritten again for the Trackpr 2.0 (step 2C)
 * grouped IA - Dashboard, Customers, Schedule, Work, Growth, Insights, and a
 * pinned Settings / Agency Command Center group. See nav-items.ts's header
 * comment for the full reasoning. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test "app/(app)/_components/nav-items.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { NAV_GROUPS, AGENCY_NAV_ITEM, getNavGroupsForVertical, resolveActiveNavItem }: typeof import("./nav-items") = require("./nav-items.ts");

function flatten(groups: { label: string | null; items: { href: string; label: string }[] }[]) {
  return groups.flatMap((g) => g.items.map((i) => `${i.href}:${i.label}`));
}

function hrefsOf(groups: ReturnType<typeof getNavGroupsForVertical>) {
  return groups.flatMap((g) => g.items.map((i) => i.href));
}

/** The route part of an href - what a legacy/redirect check has to compare. */
const pathOf = (href: string) => href.split(/[?#]/)[0];

// ===========================================================================
// A. All canonical destinations exist in navigation.
// ===========================================================================

test("A. every canonical destination route is present in the unfiltered nav", () => {
  const paths = flatten(NAV_GROUPS).map((entry) => pathOf(entry.split(":")[0]));
  for (const href of ["/today", "/people", "/conversations", "/schedule", "/estimates", "/jobs", "/money", "/growth", "/insights", "/automations", "/settings"]) {
    assert.ok(paths.includes(href), `expected canonical destination ${href} to be present`);
  }
});

test("A2. Performance Pass A: Inbox nav href is exactly /conversations (the route it renders), never /inbox (a compatibility redirect that cost every click a server round trip)", () => {
  const hrefs = hrefsOf(getNavGroupsForVertical("contractor", true));
  const inboxEntry = flatten(NAV_GROUPS).find((entry) => entry.endsWith(":Inbox"));
  assert.equal(inboxEntry, "/conversations:Inbox");
  assert.ok(!hrefs.includes("/inbox"), "/inbox is a redirect to /conversations - navigation must link to the destination directly");
});

// ===========================================================================
// B. Legacy/redirect routes never appear in navigation - the entries that
// replace them link to their final destination instead.
// ===========================================================================

test("B. no legacy or redirect-only route appears anywhere in navigation, for either vertical, with or without the agency link", () => {
  const legacy = ["/leads", "/contacts", "/calendar", "/appointments", "/customers", "/work", "/dashboard", "/opportunities", "/analytics", "/inbox", "/activity", "/automation-health"];
  for (const vertical of ["contractor", "gym"] as const) {
    for (const showAgencyLink of [true, false]) {
      const paths = hrefsOf(getNavGroupsForVertical(vertical, showAgencyLink)).map(pathOf);
      for (const legacyHref of legacy) {
        assert.ok(!paths.includes(legacyHref), `${legacyHref} must never appear in navigation (vertical=${vertical}, agency=${showAgencyLink})`);
      }
    }
  }
});

test("B2. the entries that replace redirect routes link to exactly the URL each redirect lands on", () => {
  const byLabel = new Map(getNavGroupsForVertical("contractor", false).flatMap((g) => g.items.map((i) => [i.label, i.href] as const)));
  assert.equal(byLabel.get("Contacts"), "/people"); // /contacts -> /people
  assert.equal(byLabel.get("Leads"), "/people?temperature=hot"); // /leads -> /people?temperature=hot
  assert.equal(byLabel.get("Calendar"), "/schedule"); // /calendar -> /schedule
  assert.equal(byLabel.get("Appointments"), "/schedule?view=list"); // /appointments -> /schedule?view=list
  assert.equal(byLabel.get("Opportunities"), "/today?view=by-type"); // /opportunities -> /today?view=by-type
  assert.equal(byLabel.get("Analytics"), "/insights"); // /analytics -> /insights
});

test("B3. /money is a Work destination again for a contractor (Trackpr 2.0 step 2C), and stays hidden for a gym", () => {
  const work = getNavGroupsForVertical("contractor", false).find((g) => g.id === "work");
  assert.ok(work?.items.some((i) => i.href === "/money"));
  assert.ok(!hrefsOf(getNavGroupsForVertical("gym", false)).includes("/money"));
});

// ===========================================================================
// C. Correct labels are rendered.
// ===========================================================================

test("C. every label renders exactly as specified, for a contractor", () => {
  const entries = flatten(getNavGroupsForVertical("contractor", false));
  const expected = [
    "/today:Dashboard",
    "/people:Contacts",
    "/people?temperature=hot:Leads",
    "/conversations:Inbox",
    "/schedule:Calendar",
    "/schedule?view=list:Appointments",
    "/estimates:Estimates",
    "/jobs:Jobs",
    "/money:Money",
    "/today?view=by-type:Opportunities",
    "/growth#reviews:Reviews",
    "/growth#referrals:Referrals",
    "/insights:Analytics",
    "/automations:Automations",
    "/settings:Settings",
  ];
  assert.deepEqual(entries, expected);
});

test("C2. gym nav relabels Contacts to Members; contractor keeps Contacts", () => {
  const gymEntry = flatten(getNavGroupsForVertical("gym", false)).find((e) => e.startsWith("/people:"));
  const contractorEntry = flatten(getNavGroupsForVertical("contractor", false)).find((e) => e.startsWith("/people:"));
  assert.equal(gymEntry, "/people:Members");
  assert.equal(contractorEntry, "/people:Contacts");
});

// ===========================================================================
// D. Correct groups are rendered.
// ===========================================================================

test("D. the group structure exists in the exact order: Dashboard, Customers, Schedule, Work, Growth, Insights, then the pinned system group", () => {
  assert.deepEqual(
    NAV_GROUPS.map((g) => [g.id, g.label]),
    [
      ["home", null],
      ["customers", "Customers"],
      ["schedule", "Schedule"],
      ["work", "Work"],
      ["growth", "Growth"],
      ["insights", "Insights"],
      ["system", null],
    ],
  );
});

test("D2. each group contains exactly its destinations, in order (contractor)", () => {
  const groups = Object.fromEntries(getNavGroupsForVertical("contractor", false).map((g) => [g.id, g.items.map((i) => i.label)]));
  assert.deepEqual(groups, {
    home: ["Dashboard"],
    customers: ["Contacts", "Leads", "Inbox"],
    schedule: ["Calendar", "Appointments"],
    work: ["Estimates", "Jobs", "Money"],
    growth: ["Opportunities", "Reviews", "Referrals"],
    insights: ["Analytics", "Automations"],
    system: ["Settings"],
  });
});

test("D3. group ids are unique - they key the sidebar's persisted fold state", () => {
  const ids = NAV_GROUPS.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("D5. the system group contains Settings, and Agency Command Center only when authorized", () => {
  const withoutAgency = getNavGroupsForVertical("contractor", false).find((g) => g.id === "system");
  const withAgency = getNavGroupsForVertical("contractor", true).find((g) => g.id === "system");
  assert.deepEqual(withoutAgency!.items.map((i) => i.href), ["/settings"]);
  assert.deepEqual(withAgency!.items.map((i) => i.href), ["/settings", "/agency"]);
  assert.equal(withAgency!.items.find((i) => i.href === "/agency")?.label, "Agency Command Center");
});

test("D6. Agency Command Center never appears as its own group or in any other group", () => {
  const groups = getNavGroupsForVertical("contractor", true);
  assert.ok(!groups.some((g) => g.label === "Agency"));
  for (const group of groups.filter((g) => g.id !== "system")) {
    assert.ok(!group.items.some((i) => i.href === "/agency"), `${group.id} must not contain /agency`);
  }
});

// ===========================================================================
// Vertical filtering
// ===========================================================================

test("contractor nav includes Estimates, Jobs and Money", () => {
  const hrefs = hrefsOf(getNavGroupsForVertical("contractor", false));
  for (const href of ["/estimates", "/jobs", "/money"]) assert.ok(hrefs.includes(href), href);
});

test("gym nav excludes Estimates, Jobs and Money, and drops the then-empty Work group", () => {
  const groups = getNavGroupsForVertical("gym", false);
  const hrefs = hrefsOf(groups);
  for (const href of ["/estimates", "/jobs", "/money"]) assert.ok(!hrefs.includes(href), href);
  assert.ok(!groups.some((g) => g.id === "work"));
});

test("gym nav still includes every vertical-neutral item", () => {
  const hrefs = hrefsOf(getNavGroupsForVertical("gym", false));
  for (const href of ["/today", "/people", "/people?temperature=hot", "/conversations", "/schedule", "/schedule?view=list", "/today?view=by-type", "/growth#reviews", "/growth#referrals", "/insights", "/automations", "/settings"]) {
    assert.ok(hrefs.includes(href), `expected ${href} to remain visible for gym`);
  }
});

test("showAgencyLink appends /agency for both verticals", () => {
  assert.ok(hrefsOf(getNavGroupsForVertical("contractor", true)).includes("/agency"));
  assert.ok(hrefsOf(getNavGroupsForVertical("gym", true)).includes("/agency"));
});

test("showAgencyLink=false omits /agency entirely", () => {
  assert.ok(!hrefsOf(getNavGroupsForVertical("contractor", false)).includes("/agency"));
  assert.ok(!hrefsOf(getNavGroupsForVertical("gym", false)).includes("/agency"));
});

// ===========================================================================
// I. No duplicate navigation destinations exist.
// ===========================================================================

test("I. no href appears more than once across the entire nav, for either vertical, with or without the agency link", () => {
  for (const vertical of ["contractor", "gym"] as const) {
    for (const showAgencyLink of [true, false]) {
      const hrefs = hrefsOf(getNavGroupsForVertical(vertical, showAgencyLink));
      assert.equal(hrefs.length, new Set(hrefs).size, `duplicate nav href found for vertical=${vertical}, agency=${showAgencyLink}: ${hrefs.join(", ")}`);
    }
  }
});

test("I2. no label appears more than once - every entry is distinguishable in the sidebar and its tooltips", () => {
  const labels = getNavGroupsForVertical("contractor", true).flatMap((g) => g.items.map((i) => i.label));
  assert.equal(labels.length, new Set(labels).size, labels.join(", "));
});

// ===========================================================================
// R. Active-item resolution - exactly one entry is active, even where two
// entries share a route.
// ===========================================================================

const ITEMS = [...NAV_GROUPS.flatMap((g) => g.items), AGENCY_NAV_ITEM];
const activeLabel = (pathname: string, search = "", hash = "") => resolveActiveNavItem(ITEMS, { pathname, search, hash })?.label ?? null;

test("R1. two views of one route resolve to the more specific entry only when its query is present (or its fragment matches)", () => {
  assert.equal(activeLabel("/people"), "Contacts");
  assert.equal(activeLabel("/people", "temperature=hot"), "Leads");
  assert.equal(activeLabel("/people", "temperature=warm"), "Contacts");
  assert.equal(activeLabel("/people", "temperature=hot&q=smith"), "Leads");
  assert.equal(activeLabel("/schedule"), "Calendar");
  assert.equal(activeLabel("/schedule", "view=week&date=2026-09-28"), "Calendar");
  assert.equal(activeLabel("/schedule", "view=list"), "Appointments");
  assert.equal(activeLabel("/schedule", "view=list&apptView=past"), "Appointments");
  assert.equal(activeLabel("/today"), "Dashboard");
  assert.equal(activeLabel("/today", "view=by-type"), "Opportunities");
  // A fragment is a soft preference: plain /growth is the first entry.
  assert.equal(activeLabel("/growth"), "Reviews");
  assert.equal(activeLabel("/growth", "", "#referrals"), "Referrals");
  assert.equal(activeLabel("/growth", "", "#reviews"), "Reviews");
  assert.equal(activeLabel("/growth", "", "#somewhere-else"), "Reviews");
});

test("R2. detail and legacy routes resolve to the destination they belong to", () => {
  assert.equal(activeLabel("/people/abc"), "Contacts");
  assert.equal(activeLabel("/customers/abc"), "Contacts");
  assert.equal(activeLabel("/appointments/abc"), "Appointments");
  assert.equal(activeLabel("/jobs/abc"), "Jobs");
  assert.equal(activeLabel("/estimates/abc"), "Estimates");
  assert.equal(activeLabel("/invoices/abc"), "Money");
  assert.equal(activeLabel("/conversations/abc"), "Inbox");
  assert.equal(activeLabel("/settings/sms"), "Settings");
  assert.equal(activeLabel("/agency/usage"), "Agency Command Center");
});

test("R3. an unrelated route resolves to nothing, and a path prefix is never a false match", () => {
  assert.equal(activeLabel("/onboarding"), null);
  assert.equal(activeLabel("/peoplex"), null);
  assert.equal(activeLabel("/todayish"), null);
});

/**
 * Pure, dependency-free tests of the nav-filtering foundation. Originally
 * Gym Foundation Phase 1, Section 6; rewritten for the IA consolidation
 * pass that retired Dashboard, Customers/Leads/Contacts, Work, Opportunities,
 * and Analytics as separate nav destinations (all absorbed into Today,
 * People, Money, and Insights respectively). Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test "app/(app)/_components/nav-items.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { NAV_GROUPS, getNavGroupsForVertical }: typeof import("./nav-items") = require("./nav-items.ts");

function flatten(groups: { label: string | null; items: { href: string; label: string }[] }[]) {
  return groups.flatMap((g) => g.items.map((i) => `${i.href}:${i.label}`));
}

function hrefsOf(groups: ReturnType<typeof getNavGroupsForVertical>) {
  return flatten(groups).map((entry) => entry.split(":")[0]);
}

// ===========================================================================
// A. All canonical destinations exist in navigation.
// ===========================================================================

test("A. every locked canonical destination is present in the unfiltered nav", () => {
  const hrefs = flatten(NAV_GROUPS).map((entry) => entry.split(":")[0]);
  for (const href of ["/today", "/people", "/money", "/schedule", "/inbox", "/growth", "/automations", "/insights", "/settings"]) {
    assert.ok(hrefs.includes(href), `expected canonical destination ${href} to be present`);
  }
});

test("A2. Inbox nav href is exactly /inbox, and no nav item points to /conversations as the primary Inbox destination", () => {
  const hrefs = hrefsOf(getNavGroupsForVertical("contractor", true));
  const inboxEntry = flatten(NAV_GROUPS).find((entry) => entry.endsWith(":Inbox"));
  assert.equal(inboxEntry, "/inbox:Inbox");
  assert.ok(!hrefs.includes("/conversations"), "/conversations must not appear as a primary nav destination - Inbox now points at /inbox");
});

// ===========================================================================
// B. Legacy/superseded destinations do not appear in navigation.
// ===========================================================================

test("B. no legacy or IA-consolidation-superseded route appears anywhere in navigation, for either vertical, with or without the agency link", () => {
  const legacy = ["/leads", "/contacts", "/calendar", "/appointments", "/estimates", "/jobs", "/customers", "/work", "/dashboard", "/opportunities", "/analytics"];
  for (const vertical of ["contractor", "gym"] as const) {
    for (const showAgencyLink of [true, false]) {
      const hrefs = hrefsOf(getNavGroupsForVertical(vertical, showAgencyLink));
      for (const legacyHref of legacy) {
        assert.ok(!hrefs.includes(legacyHref), `${legacyHref} must never appear in navigation (vertical=${vertical}, agency=${showAgencyLink})`);
      }
    }
  }
});

// ===========================================================================
// C. Correct labels are rendered, and every nav label matches its own
// page's H1 (the redesign audit's "every page gets one consistent name").
// ===========================================================================

test("C. every locked label renders exactly as specified, for a contractor", () => {
  const entries = flatten(getNavGroupsForVertical("contractor", false));
  const expected = [
    "/today:Today",
    "/people:People",
    "/money:Money",
    "/schedule:Schedule",
    "/inbox:Inbox",
    "/growth:Reviews & Referrals",
    "/automations:Automations",
    "/insights:Insights",
    "/settings:Settings",
  ];
  for (const e of expected) {
    assert.ok(entries.includes(e), `expected exact entry "${e}" in contractor nav`);
  }
});

test("C2. gym nav relabels People to Members; contractor keeps People", () => {
  const gymEntry = flatten(getNavGroupsForVertical("gym", false)).find((e) => e.startsWith("/people:"));
  const contractorEntry = flatten(getNavGroupsForVertical("contractor", false)).find((e) => e.startsWith("/people:"));
  assert.equal(gymEntry, "/people:Members");
  assert.equal(contractorEntry, "/people:People");
});

// ===========================================================================
// D. Correct groups are rendered.
// ===========================================================================

test("D. the locked group structure exists in the exact order: (ungrouped primary), More", () => {
  const labels = NAV_GROUPS.map((g) => g.label);
  assert.deepEqual(labels, [null, "More"]);
});

test("D2. the primary group contains exactly Today, People, Money, Schedule (for a contractor, in order)", () => {
  const primaryGroup = getNavGroupsForVertical("contractor", false).find((g) => g.label === null);
  assert.ok(primaryGroup);
  assert.deepEqual(
    primaryGroup!.items.map((i) => i.href),
    ["/today", "/people", "/money", "/schedule"],
  );
});

test("D3. More contains exactly Inbox, Reviews & Referrals, Automations, Insights, Settings (for a contractor) - Dashboard and Opportunities are gone entirely, fully absorbed into Today", () => {
  const moreGroup = getNavGroupsForVertical("contractor", false).find((g) => g.label === "More");
  assert.ok(moreGroup);
  assert.deepEqual(
    moreGroup!.items.map((i) => i.href),
    ["/inbox", "/growth", "/automations", "/insights", "/settings"],
  );
});

test("D4. no other groups exist beyond the primary group and More", () => {
  const groups = getNavGroupsForVertical("contractor", true);
  const labels = groups.map((g) => g.label);
  assert.deepEqual(labels.sort(), [null, "More"].sort());
});

test("D5. More contains Settings, and Agency Command Center only when authorized", () => {
  const withoutAgency = getNavGroupsForVertical("contractor", false).find((g) => g.label === "More");
  const withAgency = getNavGroupsForVertical("contractor", true).find((g) => g.label === "More");
  assert.ok(withoutAgency!.items.map((i) => i.href).includes("/settings"));
  assert.ok(!withoutAgency!.items.map((i) => i.href).includes("/agency"));
  assert.ok(withAgency!.items.map((i) => i.href).includes("/agency"));
  assert.equal(withAgency!.items.find((i) => i.href === "/agency")?.label, "Agency Command Center");
});

test("D6. Agency Command Center appears inside the existing More group, never as its own separate group", () => {
  const groups = getNavGroupsForVertical("contractor", true);
  assert.ok(!groups.some((g) => g.label === "Agency"), "a separate 'Agency' group must not exist - Agency Command Center lives inside More");
  const moreGroup = groups.find((g) => g.label === "More");
  assert.ok(moreGroup!.items.some((i) => i.href === "/agency"));
});

// ===========================================================================
// Vertical filtering (unchanged behavior, retargeted to /money)
// ===========================================================================

test("contractor nav still includes Money (/money)", () => {
  const hrefs = hrefsOf(getNavGroupsForVertical("contractor", false));
  assert.ok(hrefs.includes("/money"));
});

test("gym nav excludes Money (/money)", () => {
  const hrefs = hrefsOf(getNavGroupsForVertical("gym", false));
  assert.ok(!hrefs.includes("/money"));
});

test("gym nav still includes every vertical-neutral item", () => {
  const hrefs = hrefsOf(getNavGroupsForVertical("gym", false));
  for (const href of ["/today", "/people", "/schedule", "/inbox", "/growth", "/automations", "/insights", "/settings"]) {
    assert.ok(hrefs.includes(href), `expected ${href} to remain visible for gym`);
  }
});

test("showAgencyLink appends /agency for both verticals", () => {
  assert.ok(hrefsOf(getNavGroupsForVertical("contractor", true)).includes("/agency"));
  assert.ok(hrefsOf(getNavGroupsForVertical("gym", true)).includes("/agency"));
});

test("showAgencyLink=false omits /agency entirely", () => {
  assert.ok(!hrefsOf(getNavGroupsForVertical("contractor", false)).includes("/agency"));
});

// ===========================================================================
// I. No duplicate navigation destinations exist.
// ===========================================================================

test("I. no href appears more than once across the entire nav, for either vertical, with or without the agency link", () => {
  for (const vertical of ["contractor", "gym"] as const) {
    for (const showAgencyLink of [true, false]) {
      const hrefs = hrefsOf(getNavGroupsForVertical(vertical, showAgencyLink));
      const unique = new Set(hrefs);
      assert.equal(hrefs.length, unique.size, `duplicate nav href found for vertical=${vertical}, agency=${showAgencyLink}: ${hrefs.join(", ")}`);
    }
  }
});

test("I2. there is no competing pair of destinations for the same merged concept", () => {
  const hrefs = hrefsOf(getNavGroupsForVertical("contractor", true));
  const forbiddenPairs: [string, string][] = [
    ["/people", "/leads"],
    ["/people", "/contacts"],
    ["/people", "/customers"],
    ["/schedule", "/calendar"],
    ["/schedule", "/appointments"],
    ["/money", "/work"],
    ["/money", "/estimates"],
    ["/money", "/jobs"],
    ["/today", "/dashboard"],
    ["/today", "/opportunities"],
    ["/insights", "/analytics"],
  ];
  for (const [kept, retired] of forbiddenPairs) {
    assert.ok(!(hrefs.includes(kept) && hrefs.includes(retired)), `both ${kept} and ${retired} appear in navigation - only ${kept} may be present`);
  }
});

test("I3. Dashboard and Opportunities are not reachable from navigation at all (fully absorbed into Today, not merely deprioritized)", () => {
  const groups = getNavGroupsForVertical("contractor", true);
  const hrefs = hrefsOf(groups);
  assert.ok(!hrefs.includes("/dashboard"));
  assert.ok(!hrefs.includes("/opportunities"));
});

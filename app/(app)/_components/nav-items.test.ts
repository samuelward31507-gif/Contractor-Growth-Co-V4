/**
 * Pure, dependency-free tests of the nav-filtering foundation. Originally
 * Gym Foundation Phase 1, Section 6; updated for Trackpr 2.0 Phase 1
 * (navigation/IA) to reflect the locked navigation hierarchy and canonical
 * Phase 0 routes. Run with:
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

test("A. every locked Trackpr 2.0 canonical destination is present in the unfiltered nav", () => {
  const hrefs = flatten(NAV_GROUPS).map((entry) => entry.split(":")[0]);
  for (const href of ["/dashboard", "/customers", "/inbox", "/schedule", "/work", "/opportunities", "/growth", "/analytics", "/automations", "/settings"]) {
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
// B. Legacy destinations do not appear in primary navigation.
// ===========================================================================

test("B. no legacy route appears anywhere in navigation, for either vertical, with or without the agency link", () => {
  const legacy = ["/leads", "/contacts", "/calendar", "/appointments", "/estimates", "/jobs"];
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
// C. Correct labels are rendered.
// ===========================================================================

test("C. every locked label renders exactly as specified, for a contractor", () => {
  const entries = flatten(getNavGroupsForVertical("contractor", false));
  const expected = [
    "/dashboard:Dashboard",
    "/customers:Customers",
    "/inbox:Inbox",
    "/schedule:Schedule",
    "/work:Estimates & Jobs",
    "/opportunities:Opportunities",
    "/growth:Reviews & Referrals",
    "/analytics:Analytics",
    "/automations:Automations",
    "/settings:Settings",
  ];
  for (const e of expected) {
    assert.ok(entries.includes(e), `expected exact entry "${e}" in contractor nav`);
  }
});

test("C2. gym nav relabels Customers to Members; contractor keeps Customers", () => {
  const gymEntry = flatten(getNavGroupsForVertical("gym", false)).find((e) => e.startsWith("/customers:"));
  const contractorEntry = flatten(getNavGroupsForVertical("contractor", false)).find((e) => e.startsWith("/customers:"));
  assert.equal(gymEntry, "/customers:Members");
  assert.equal(contractorEntry, "/customers:Customers");
});

// ===========================================================================
// D. Correct groups are rendered.
// ===========================================================================

test("D. the locked group structure exists in the exact order: (ungrouped Dashboard), Work, Growth, Intelligence, System", () => {
  const labels = NAV_GROUPS.map((g) => g.label);
  assert.deepEqual(labels, [null, "Work", "Growth", "Intelligence", "System"]);
});

test("D2. Work contains exactly Customers, Inbox, Schedule, Estimates & Jobs (for a contractor)", () => {
  const workGroup = getNavGroupsForVertical("contractor", false).find((g) => g.label === "Work");
  assert.ok(workGroup);
  assert.deepEqual(
    workGroup!.items.map((i) => i.href),
    ["/customers", "/inbox", "/schedule", "/work"],
  );
});

test("D3. Growth contains exactly Opportunities and Reviews & Referrals", () => {
  const growthGroup = getNavGroupsForVertical("contractor", false).find((g) => g.label === "Growth");
  assert.ok(growthGroup);
  assert.deepEqual(
    growthGroup!.items.map((i) => i.href),
    ["/opportunities", "/growth"],
  );
});

test("D4. Intelligence contains exactly Analytics and Automations", () => {
  const intelGroup = getNavGroupsForVertical("contractor", false).find((g) => g.label === "Intelligence");
  assert.ok(intelGroup);
  assert.deepEqual(
    intelGroup!.items.map((i) => i.href),
    ["/analytics", "/automations"],
  );
});

test("D5. System contains Settings, and Agency Command Center only when authorized", () => {
  const withoutAgency = getNavGroupsForVertical("contractor", false).find((g) => g.label === "System");
  const withAgency = getNavGroupsForVertical("contractor", true).find((g) => g.label === "System");
  assert.deepEqual(withoutAgency!.items.map((i) => i.href), ["/settings"]);
  assert.deepEqual(withAgency!.items.map((i) => i.href), ["/settings", "/agency"]);
  assert.equal(withAgency!.items.find((i) => i.href === "/agency")?.label, "Agency Command Center");
});

test("D6. Agency Command Center appears inside the existing System group, never as its own separate group", () => {
  const groups = getNavGroupsForVertical("contractor", true);
  assert.ok(!groups.some((g) => g.label === "Agency"), "a separate 'Agency' group must not exist - Agency Command Center lives inside System");
  const systemGroup = groups.find((g) => g.label === "System");
  assert.ok(systemGroup!.items.some((i) => i.href === "/agency"));
});

// ===========================================================================
// Vertical filtering (unchanged behavior, retargeted to /work)
// ===========================================================================

test("contractor nav still includes Estimates & Jobs (/work)", () => {
  const hrefs = hrefsOf(getNavGroupsForVertical("contractor", false));
  assert.ok(hrefs.includes("/work"));
});

test("gym nav excludes Estimates & Jobs (/work)", () => {
  const hrefs = hrefsOf(getNavGroupsForVertical("gym", false));
  assert.ok(!hrefs.includes("/work"));
});

test("gym nav still includes every vertical-neutral item", () => {
  const hrefs = hrefsOf(getNavGroupsForVertical("gym", false));
  for (const href of ["/dashboard", "/customers", "/inbox", "/schedule", "/opportunities", "/growth", "/automations", "/analytics", "/settings"]) {
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

test("I2. there is no competing pair of destinations for the same merged concept (Customers vs Leads/Contacts, Schedule vs Calendar/Appointments, Estimates & Jobs vs Estimates/Jobs)", () => {
  const hrefs = hrefsOf(getNavGroupsForVertical("contractor", true));
  const forbiddenPairs: [string, string][] = [
    ["/customers", "/leads"],
    ["/customers", "/contacts"],
    ["/schedule", "/calendar"],
    ["/schedule", "/appointments"],
    ["/work", "/estimates"],
    ["/work", "/jobs"],
    ["/growth", "/reviews"],
    ["/growth", "/referrals"],
  ];
  for (const [kept, retired] of forbiddenPairs) {
    assert.ok(!(hrefs.includes(kept) && hrefs.includes(retired)), `both ${kept} and ${retired} appear in navigation - only ${kept} may be present`);
  }
});

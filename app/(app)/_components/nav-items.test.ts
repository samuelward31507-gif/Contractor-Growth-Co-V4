/**
 * Pure, dependency-free tests of the vertical nav-filtering foundation
 * (Gym Foundation Phase 1, Section 6). Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test "app/(app)/_components/nav-items.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { NAV_GROUPS, getNavGroupsForVertical }: typeof import("./nav-items") = require("./nav-items.ts");

function flatten(groups: { items: { href: string; label: string }[] }[]) {
  return groups.flatMap((g) => g.items.map((i) => `${i.href}:${i.label}`));
}

test("contractor nav is byte-identical to the unfiltered NAV_GROUPS (no agency link)", () => {
  const filtered = getNavGroupsForVertical("contractor", false);
  assert.deepEqual(flatten(filtered), flatten(NAV_GROUPS));
});

test("contractor nav still includes Estimates and Jobs", () => {
  const filtered = getNavGroupsForVertical("contractor", false);
  const hrefs = flatten(filtered).map((entry) => entry.split(":")[0]);
  assert.ok(hrefs.includes("/estimates"));
  assert.ok(hrefs.includes("/jobs"));
});

test("gym nav excludes Estimates and Jobs", () => {
  const filtered = getNavGroupsForVertical("gym", false);
  const hrefs = flatten(filtered).map((entry) => entry.split(":")[0]);
  assert.ok(!hrefs.includes("/estimates"));
  assert.ok(!hrefs.includes("/jobs"));
});

test("gym nav relabels Contacts to Members; contractor keeps Contacts", () => {
  const gymEntry = flatten(getNavGroupsForVertical("gym", false)).find((e) => e.startsWith("/contacts:"));
  const contractorEntry = flatten(getNavGroupsForVertical("contractor", false)).find((e) => e.startsWith("/contacts:"));
  assert.equal(gymEntry, "/contacts:Members");
  assert.equal(contractorEntry, "/contacts:Contacts");
});

test("gym nav still includes every vertical-neutral item (Leads, Conversations, Appointments, Automations, Analytics, Settings)", () => {
  const hrefs = flatten(getNavGroupsForVertical("gym", false)).map((entry) => entry.split(":")[0]);
  for (const href of ["/dashboard", "/leads", "/contacts", "/conversations", "/appointments", "/automations", "/analytics", "/settings"]) {
    assert.ok(hrefs.includes(href), `expected ${href} to remain visible for gym`);
  }
});

test("showAgencyLink appends the Agency group for both verticals", () => {
  const contractorHrefs = flatten(getNavGroupsForVertical("contractor", true)).map((entry) => entry.split(":")[0]);
  const gymHrefs = flatten(getNavGroupsForVertical("gym", true)).map((entry) => entry.split(":")[0]);
  assert.ok(contractorHrefs.includes("/agency"));
  assert.ok(gymHrefs.includes("/agency"));
});

test("showAgencyLink=false omits the Agency group", () => {
  const hrefs = flatten(getNavGroupsForVertical("contractor", false)).map((entry) => entry.split(":")[0]);
  assert.ok(!hrefs.includes("/agency"));
});

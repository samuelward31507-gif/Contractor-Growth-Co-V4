/**
 * Operator-shell active-item resolution (lib/ui/operator-shell/nav.ts).
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/ui/operator-shell/nav.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENCY_NAV_GROUP, FOUNDER_NAV_GROUP, resolveOperatorActiveItem } from "./nav";

const groups = [AGENCY_NAV_GROUP, FOUNDER_NAV_GROUP];
const label = (path: string) => resolveOperatorActiveItem(groups, path)?.label ?? null;

test("the most specific item wins; section roots match only themselves (plus their declared detail routes)", () => {
  assert.equal(label("/agency"), "Overview");
  assert.equal(label("/agency/organizations/abc"), "Overview", "a client detail page belongs to Overview");
  assert.equal(label("/agency/revenue"), "Revenue");
  assert.equal(label("/agency/handoffs"), "Client handoffs");
  assert.equal(label("/agency/costs"), "Costs");
  assert.equal(label("/founder"), "Home");
  assert.equal(label("/founder/deals"), "Deals");
  assert.equal(label("/founder/calendar"), "Calendar");
  assert.equal(label("/founder/tasks"), "Tasks & events");
  assert.equal(label("/agency/unknown"), null, "an unknown agency path is not Overview");
  assert.equal(label("/agencyx"), null, "prefix matching is by path segment");
  assert.equal(label(null as unknown as string), null);
});

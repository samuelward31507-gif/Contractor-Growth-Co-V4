/**
 * Regression coverage for the sidebar's two persisted preferences (rail
 * collapse, per-group open/closed state). Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/(app)/_components/sidebar-prefs.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultOpenGroups, parseStoredGroups, toggleGroupState, SIDEBAR_RAIL_STORAGE_KEY, SIDEBAR_GROUPS_STORAGE_KEY } from "./sidebar-prefs";

test("1. defaultOpenGroups marks every given label open, matching the sidebar's original non-collapsible behavior", () => {
  const result = defaultOpenGroups(["Work", "Growth", "Intelligence", "System"]);
  assert.deepEqual(result, { Work: true, Growth: true, Intelligence: true, System: true });
});

test("2. defaultOpenGroups on an empty label list returns an empty object, never throws", () => {
  assert.deepEqual(defaultOpenGroups([]), {});
});

test("3. parseStoredGroups(null) - nothing ever stored - returns null, not a crash", () => {
  assert.equal(parseStoredGroups(null), null);
});

test("4. parseStoredGroups on valid JSON returns the parsed object", () => {
  assert.deepEqual(parseStoredGroups('{"Work":false,"Growth":true}'), { Work: false, Growth: true });
});

test("5. parseStoredGroups on malformed JSON returns null, never throws", () => {
  assert.equal(parseStoredGroups("{not valid json"), null);
});

test("6. parseStoredGroups on a JSON array (wrong shape) returns null, not the array", () => {
  assert.equal(parseStoredGroups("[1,2,3]"), null);
});

test("7. parseStoredGroups on a bare JSON primitive (wrong shape) returns null", () => {
  assert.equal(parseStoredGroups("42"), null);
});

test("8. toggleGroupState flips exactly the named group, leaving every other group's stored state untouched", () => {
  const current = { Work: true, Growth: true, Intelligence: false, System: true };
  const next = toggleGroupState(current, "Growth");
  assert.deepEqual(next, { Work: true, Growth: false, Intelligence: false, System: true });
});

test("9. toggleGroupState on a group with no prior entry treats it as closed, so the first toggle opens it (Boolean(undefined) === false, so !undefined === true)", () => {
  const next = toggleGroupState({}, "Work");
  assert.deepEqual(next, { Work: true });
});

test("10. toggleGroupState never mutates the input object - a fresh object is returned each time", () => {
  const current = { Work: true };
  const next = toggleGroupState(current, "Work");
  assert.notEqual(next, current);
  assert.equal(current.Work, true);
});

test("11. the two storage keys are distinct, non-empty, and namespaced under trackpr: - no accidental collision with any other localStorage consumer", () => {
  assert.notEqual(SIDEBAR_RAIL_STORAGE_KEY, SIDEBAR_GROUPS_STORAGE_KEY);
  assert.match(SIDEBAR_RAIL_STORAGE_KEY, /^trackpr:/);
  assert.match(SIDEBAR_GROUPS_STORAGE_KEY, /^trackpr:/);
});

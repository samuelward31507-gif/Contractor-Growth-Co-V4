/**
 * Pure, dependency-free tests of resolveOrganization()'s fail-closed
 * vertical resolution (Gym Foundation Phase 1 completion). Complements
 * lib/auth/organization-vertical.integration.test.ts, which proves the
 * live database round-trip - this file proves the resolution logic itself
 * handles a value the organizations_vertical_check CHECK constraint would
 * never actually allow into the live database (garbage/missing), which
 * can't be exercised live but the code must still defend against (e.g. a
 * future schema change, or a null embed from a dangling FK). Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/auth/organization.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { resolveOrganization }: typeof import("./organization") = require("./organization.ts");

test("a contractor organization resolves as contractor", () => {
  const { vertical } = resolveOrganization({ name: "Acme Contracting", payment_status: "active", vertical: "contractor" });
  assert.equal(vertical, "contractor");
});

test("a gym organization resolves as gym", () => {
  const { vertical } = resolveOrganization({ name: "Acme Fitness", payment_status: "active", vertical: "gym" });
  assert.equal(vertical, "gym");
});

test("an unrecognized vertical value fails closed to contractor, never silently to gym", () => {
  const { vertical } = resolveOrganization({ name: "Acme", payment_status: "active", vertical: "not-a-real-vertical" });
  assert.equal(vertical, "contractor");
});

test("a missing/null vertical fails closed to contractor", () => {
  const { vertical } = resolveOrganization({ name: "Acme", payment_status: "active", vertical: null });
  assert.equal(vertical, "contractor");
});

test("a null organizations embed (e.g. a dangling FK) fails closed to contractor", () => {
  const { vertical } = resolveOrganization(null);
  assert.equal(vertical, "contractor");
});

test("PostgREST's array-shaped embed (older client versions) is handled the same as a single object", () => {
  const { vertical } = resolveOrganization([{ name: "Acme Fitness", payment_status: "active", vertical: "gym" }]);
  assert.equal(vertical, "gym");
});

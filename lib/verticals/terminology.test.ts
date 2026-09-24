/**
 * Pure, dependency-free tests of the vertical terminology dictionary
 * (Gym Foundation Phase 1, Section 5). Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/verticals/terminology.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { getTerminology }: typeof import("./terminology") = require("./terminology.ts");

test("contractor terminology keeps the existing 'Contacts' wording", () => {
  const terminology = getTerminology("contractor");
  assert.equal(terminology.contactsLabel, "Contacts");
  assert.equal(terminology.contactSingular, "contact");
});

test("gym terminology relabels contacts as members", () => {
  const terminology = getTerminology("gym");
  assert.equal(terminology.contactsLabel, "Members");
  assert.equal(terminology.contactSingular, "member");
});

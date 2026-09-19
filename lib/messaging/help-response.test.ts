/**
 * Unit tests for buildHelpResponseMessage() - pure, no I/O, no AI. Run with:
 *
 *   node --test lib/messaging/help-response.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildHelpResponseMessage }: typeof import("./help-response") = require("./help-response.ts");

test("uses the organization's own configured phone number when set", () => {
  const message = buildHelpResponseMessage({ name: "Acme Plumbing", phone: "+15551234567", email: "hi@acme.example" });
  assert.match(message, /Acme Plumbing/);
  assert.match(message, /\+15551234567/);
  assert.doesNotMatch(message, /hi@acme\.example/, "phone should take priority over email when both are set");
});

test("falls back to email when no phone is configured", () => {
  const message = buildHelpResponseMessage({ name: "Acme Plumbing", phone: null, email: "hi@acme.example" });
  assert.match(message, /hi@acme\.example/);
});

test("never invents a phone number or claim when neither is configured", () => {
  const message = buildHelpResponseMessage({ name: "Acme Plumbing", phone: null, email: null });
  assert.doesNotMatch(message, /\+1\d{10}/, "must not contain a fabricated phone number");
  assert.match(message, /follow up/i);
});

test("always includes the STOP opt-out instruction", () => {
  const message = buildHelpResponseMessage({ name: "Acme Plumbing", phone: "+15551234567", email: null });
  assert.match(message, /STOP/);
});

test("always includes the organization's own name, never a generic/unrelated business name", () => {
  const message = buildHelpResponseMessage({ name: "Bob's Roofing Co", phone: null, email: null });
  assert.match(message, /Bob's Roofing Co/);
});

test("is deterministic - the same input always produces the exact same output", () => {
  const input = { name: "Acme Plumbing", phone: "+15551234567", email: null };
  assert.equal(buildHelpResponseMessage(input), buildHelpResponseMessage(input));
});

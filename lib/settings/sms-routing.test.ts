/**
 * Unit tests for validateSmsPhoneNumber() - pure, no I/O. Run with:
 *
 *   node --test lib/settings/sms-routing.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { validateSmsPhoneNumber }: typeof import("./sms-routing") = require("./sms-routing.ts");

test("valid E.164 number is accepted unchanged", () => {
  const result = validateSmsPhoneNumber("+15551234567");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value, "+15551234567");
});

test("surrounding whitespace is trimmed, the number itself is never altered", () => {
  const result = validateSmsPhoneNumber("  +15551234567  ");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value, "+15551234567");
});

test("empty string is rejected", () => {
  const result = validateSmsPhoneNumber("");
  assert.equal(result.ok, false);
});

test("whitespace-only string is rejected", () => {
  const result = validateSmsPhoneNumber("   ");
  assert.equal(result.ok, false);
});

test("a number missing the leading + is rejected", () => {
  const result = validateSmsPhoneNumber("15551234567");
  assert.equal(result.ok, false);
});

test("a number containing letters is rejected", () => {
  const result = validateSmsPhoneNumber("+1555CALLNOW");
  assert.equal(result.ok, false);
});

test("a number with a leading zero after the country code is rejected (E164_PATTERN's own rule)", () => {
  const result = validateSmsPhoneNumber("+0123456789");
  assert.equal(result.ok, false);
});

test("a number exceeding E.164's 15-digit maximum is rejected", () => {
  const result = validateSmsPhoneNumber("+1234567890123456");
  assert.equal(result.ok, false);
});

test("a number with a space in the middle is rejected, not silently stripped", () => {
  const result = validateSmsPhoneNumber("+1 5551234567");
  assert.equal(result.ok, false);
});

test("a number with parentheses/dashes is rejected, never auto-formatted", () => {
  const result = validateSmsPhoneNumber("(555) 123-4567");
  assert.equal(result.ok, false);
});

test("a short but validly-shaped E.164 number is accepted (format check only, not a real-number lookup)", () => {
  const result = validateSmsPhoneNumber("+123");
  assert.equal(result.ok, true);
});

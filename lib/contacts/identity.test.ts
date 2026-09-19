/**
 * Unit tests for normalizePhoneForIdentity()/normalizeEmailForIdentity() -
 * pure, no I/O. Run with:
 *
 *   node --test lib/contacts/identity.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { normalizePhoneForIdentity, normalizeEmailForIdentity }: typeof import("./identity") = require("./identity.ts");

// ==================== Phone ====================

test("a 10-digit US number is normalized to E.164 with an assumed +1", () => {
  assert.equal(normalizePhoneForIdentity("5551234567"), "+15551234567");
});

test("common US formatting (parens, dashes, spaces, dots) is stripped before normalization", () => {
  assert.equal(normalizePhoneForIdentity("(555) 123-4567"), "+15551234567");
  assert.equal(normalizePhoneForIdentity("555-123-4567"), "+15551234567");
  assert.equal(normalizePhoneForIdentity("555.123.4567"), "+15551234567");
  assert.equal(normalizePhoneForIdentity("555 123 4567"), "+15551234567");
});

test("an 11-digit number starting with 1 is normalized the same way", () => {
  assert.equal(normalizePhoneForIdentity("15551234567"), "+15551234567");
  assert.equal(normalizePhoneForIdentity("1-555-123-4567"), "+15551234567");
});

test("an already-E.164 number is validated and kept exactly as given, never re-formatted", () => {
  assert.equal(normalizePhoneForIdentity("+15551234567"), "+15551234567");
  assert.equal(normalizePhoneForIdentity("+442071838750"), "+442071838750");
});

test("a 7-digit local number is ambiguous and returns null - never guesses a country/area code", () => {
  assert.equal(normalizePhoneForIdentity("1234567"), null);
});

test("an invalid E.164-shaped input (leading + but bad shape) returns null", () => {
  assert.equal(normalizePhoneForIdentity("+0123456789"), null);
  assert.equal(normalizePhoneForIdentity("+1"), null);
});

test("garbage/non-numeric input returns null, never throws", () => {
  assert.equal(normalizePhoneForIdentity("not a phone number"), null);
  assert.equal(normalizePhoneForIdentity(""), null);
  assert.equal(normalizePhoneForIdentity(null), null);
  assert.equal(normalizePhoneForIdentity(undefined), null);
});

test("an 11-digit number NOT starting with 1 is ambiguous and returns null", () => {
  assert.equal(normalizePhoneForIdentity("25551234567"), null);
});

// ==================== Email ====================

test("email is trimmed and lowercased", () => {
  assert.equal(normalizeEmailForIdentity("  Jane.Doe@Example.COM  "), "jane.doe@example.com");
});

test("email casing differences normalize to the same identity", () => {
  assert.equal(normalizeEmailForIdentity("USER@EXAMPLE.COM"), normalizeEmailForIdentity("user@example.com"));
});

test("Gmail dot-insensitivity is NOT applied - two dot-variants are different identities", () => {
  assert.notEqual(normalizeEmailForIdentity("jane.doe@gmail.com"), normalizeEmailForIdentity("janedoe@gmail.com"));
});

test("plus-addressing is NOT stripped - a +tag changes the identity", () => {
  assert.notEqual(normalizeEmailForIdentity("jane+work@example.com"), normalizeEmailForIdentity("jane@example.com"));
});

test("invalid email shapes return null", () => {
  assert.equal(normalizeEmailForIdentity("not-an-email"), null);
  assert.equal(normalizeEmailForIdentity("missing-at-sign.com"), null);
  assert.equal(normalizeEmailForIdentity(""), null);
  assert.equal(normalizeEmailForIdentity(null), null);
});

/**
 * Unit tests for isValidTwilioSignature() - pure, no I/O, no real Twilio
 * secret needed (HMAC correctness is secret-agnostic; any fixed test token
 * proves the same thing a real one would). Run with:
 *
 *   node --test lib/messaging/twilio-signature.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { isValidTwilioSignature }: typeof import("./twilio-signature") = require("./twilio-signature.ts");

const TEST_AUTH_TOKEN = "test-auth-token-not-a-real-secret";
const URL = "https://contractor-growth-co-v4.vercel.app/api/webhooks/sms/status";
const PARAMS = { MessageSid: "SM123", MessageStatus: "delivered", To: "+15551234567", From: "+15557654321" };

function computeValidSignature(url: string, params: Record<string, string>, authToken: string): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}

test("a correctly-computed signature is accepted", () => {
  const signature = computeValidSignature(URL, PARAMS, TEST_AUTH_TOKEN);
  assert.equal(isValidTwilioSignature(URL, PARAMS, signature, TEST_AUTH_TOKEN), true);
});

test("a signature computed with the wrong auth token is rejected", () => {
  const signature = computeValidSignature(URL, PARAMS, "a-different-token");
  assert.equal(isValidTwilioSignature(URL, PARAMS, signature, TEST_AUTH_TOKEN), false);
});

test("a signature for different params is rejected (tampered payload)", () => {
  const signature = computeValidSignature(URL, PARAMS, TEST_AUTH_TOKEN);
  const tamperedParams = { ...PARAMS, MessageStatus: "failed" };
  assert.equal(isValidTwilioSignature(URL, tamperedParams, signature, TEST_AUTH_TOKEN), false);
});

test("a signature for a different URL is rejected", () => {
  const signature = computeValidSignature(URL, PARAMS, TEST_AUTH_TOKEN);
  assert.equal(isValidTwilioSignature("https://evil.example/api/webhooks/sms/status", PARAMS, signature, TEST_AUTH_TOKEN), false);
});

test("a garbage/malformed signature is rejected, never throws", () => {
  assert.equal(isValidTwilioSignature(URL, PARAMS, "not-base64-!!!", TEST_AUTH_TOKEN), false);
});

test("an empty signature is rejected", () => {
  assert.equal(isValidTwilioSignature(URL, PARAMS, "", TEST_AUTH_TOKEN), false);
});

/**
 * Unit test for lib/automation/sms-fetch.ts's fail-closed unconfigured path
 * - mirrors lib/billing/checkout.test.ts's own minimal
 * missing-credential-test convention. No real Twilio call is ever made in
 * this test.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/sms-fetch.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const REPO_ROOT = process.cwd();
const require = createRequire(path.join(REPO_ROOT, "package.json"));

test("1. fetchTwilioMessage never calls Twilio and returns a typed failure when credentials are not configured", async () => {
  const savedAccountSid = process.env.TWILIO_ACCOUNT_SID;
  const savedAuthToken = process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;

  try {
    const { fetchTwilioMessage }: typeof import("./sms-fetch") = require(path.join(REPO_ROOT, "lib/automation/sms-fetch.ts"));
    const result = await fetchTwilioMessage("SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /not configured/i);
  } finally {
    if (savedAccountSid !== undefined) process.env.TWILIO_ACCOUNT_SID = savedAccountSid;
    if (savedAuthToken !== undefined) process.env.TWILIO_AUTH_TOKEN = savedAuthToken;
  }
});

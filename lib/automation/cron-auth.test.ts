/**
 * Unit tests for isAuthorizedCronRequest() - the single shared authorization
 * gate for every scheduled-automation HTTP endpoint (appointment-reminders,
 * estimate-followups, lead-nurture, lead-reactivation), now invoked by an
 * n8n Schedule Trigger instead of Vercel Cron. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/cron-auth.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { isAuthorizedCronRequest }: typeof import("./cron-auth") = require("./cron-auth.ts");

function makeRequest(authHeader: string | null): Parameters<typeof isAuthorizedCronRequest>[0] {
  return {
    headers: {
      get: (name: string) => (name.toLowerCase() === "authorization" ? authHeader : null),
    },
  } as Parameters<typeof isAuthorizedCronRequest>[0];
}

test("rejects when CRON_SECRET is unset, even with a correct-looking header", () => {
  const original = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    assert.equal(isAuthorizedCronRequest(makeRequest("Bearer whatever")), false);
  } finally {
    if (original !== undefined) process.env.CRON_SECRET = original;
  }
});

test("rejects a missing Authorization header", () => {
  process.env.CRON_SECRET = "test-secret-value";
  assert.equal(isAuthorizedCronRequest(makeRequest(null)), false);
});

test("rejects a header with the wrong secret", () => {
  process.env.CRON_SECRET = "test-secret-value";
  assert.equal(isAuthorizedCronRequest(makeRequest("Bearer wrong-secret")), false);
});

test("rejects a header of a different length than expected (pre-timingSafeEqual guard)", () => {
  process.env.CRON_SECRET = "test-secret-value";
  assert.equal(isAuthorizedCronRequest(makeRequest("Bearer short")), false);
});

test("rejects a header missing the 'Bearer ' prefix", () => {
  process.env.CRON_SECRET = "test-secret-value";
  assert.equal(isAuthorizedCronRequest(makeRequest("test-secret-value")), false);
});

test("accepts the exact expected 'Bearer <secret>' header", () => {
  process.env.CRON_SECRET = "test-secret-value";
  assert.equal(isAuthorizedCronRequest(makeRequest("Bearer test-secret-value")), true);
});

test("is case-sensitive on the secret itself", () => {
  process.env.CRON_SECRET = "Test-Secret-Value";
  assert.equal(isAuthorizedCronRequest(makeRequest("Bearer test-secret-value")), false);
});

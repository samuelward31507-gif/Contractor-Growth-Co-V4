/**
 * Unit tests for resolveAppBaseUrl() and buildTwilioCreateMessageParams() -
 * pure, no I/O, no real Twilio call. Run with:
 *
 *   node --test lib/automation/sms.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { resolveAppBaseUrl, buildTwilioCreateMessageParams }: typeof import("./sms") = require("./sms.ts");

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("in production (VERCEL_ENV=production), always returns the hardcoded canonical URL - never localhost, never a per-deployment URL, regardless of APP_BASE_URL/VERCEL_PROJECT_PRODUCTION_URL", () => {
  withEnv({ VERCEL_ENV: "production", APP_BASE_URL: undefined, VERCEL_PROJECT_PRODUCTION_URL: undefined }, () => {
    assert.equal(resolveAppBaseUrl(), "https://contractor-growth-co-v4.vercel.app");
  });
});

test("in production, the canonical URL wins even if APP_BASE_URL or VERCEL_PROJECT_PRODUCTION_URL are set to something else (e.g. localhost) - reproduces and proves the fix for the 2026-09-21 incident", () => {
  withEnv(
    { VERCEL_ENV: "production", APP_BASE_URL: "http://localhost:3000", VERCEL_PROJECT_PRODUCTION_URL: "some-preview-xyz.vercel.app" },
    () => {
      const result = resolveAppBaseUrl();
      assert.equal(result, "https://contractor-growth-co-v4.vercel.app");
      assert.doesNotMatch(result!, /localhost/);
    },
  );
});

test("outside production (VERCEL_ENV unset, i.e. local dev), APP_BASE_URL is used and its trailing slash is stripped", () => {
  withEnv({ VERCEL_ENV: undefined, APP_BASE_URL: "https://example.com/", VERCEL_PROJECT_PRODUCTION_URL: "should-not-be-used.vercel.app" }, () => {
    assert.equal(resolveAppBaseUrl(), "https://example.com");
  });
});

test("outside production, falls back to VERCEL_PROJECT_PRODUCTION_URL when APP_BASE_URL is unset (e.g. a preview deployment)", () => {
  withEnv({ VERCEL_ENV: "preview", APP_BASE_URL: undefined, VERCEL_PROJECT_PRODUCTION_URL: "contractor-growth-co-v4.vercel.app" }, () => {
    assert.equal(resolveAppBaseUrl(), "https://contractor-growth-co-v4.vercel.app");
  });
});

test("outside production, returns null (never a guessed/hardcoded URL, and never localhost) when nothing is configured - local dev's own headers()-based fallback takes over from here", () => {
  withEnv({ VERCEL_ENV: undefined, APP_BASE_URL: undefined, VERCEL_PROJECT_PRODUCTION_URL: undefined }, () => {
    assert.equal(resolveAppBaseUrl(), null);
  });
});

test("buildTwilioCreateMessageParams includes statusCallback when a base URL is available", () => {
  const params = buildTwilioCreateMessageParams({ to: "+15551234567", from: "+15559876543", body: "hi", statusCallbackUrl: "https://example.com/api/webhooks/sms/status" });
  assert.equal(params.statusCallback, "https://example.com/api/webhooks/sms/status");
  assert.equal(params.to, "+15551234567");
  assert.equal(params.from, "+15559876543");
  assert.equal(params.body, "hi");
});

test("buildTwilioCreateMessageParams omits statusCallback entirely (not an empty string) when no base URL is available", () => {
  const params = buildTwilioCreateMessageParams({ to: "+15551234567", from: "+15559876543", body: "hi", statusCallbackUrl: null });
  assert.equal("statusCallback" in params, false);
});

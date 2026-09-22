/**
 * Unit tests for resolveCalendarOAuthRedirectUri() - the shared helper
 * app/api/calendar/oauth/start and .../callback both use so the
 * redirect_uri they send to Google can never drift apart (see oauth.ts's
 * own module comment for why that matters). Pure function, no Supabase, no
 * network - a minimal fake NextRequest (it only ever calls
 * request.headers.get(...)) is enough. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/calendar/oauth.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { NextRequest } from "next/server";

const require = createRequire(import.meta.url);
const { resolveCalendarOAuthRedirectUri, OAUTH_STATE_COOKIE_NAME, OAUTH_STATE_COOKIE_MAX_AGE_SECONDS, OAUTH_STATE_COOKIE_PATH }: typeof import("./oauth") = require("./oauth.ts");

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

function fakeRequest(headers: Record<string, string>): NextRequest {
  return { headers: { get: (name: string) => headers[name] ?? null } } as unknown as NextRequest;
}

test("1. in production (VERCEL_ENV=production), the redirect_uri is built from the canonical app URL, never from any request header", () => {
  withEnv({ VERCEL_ENV: "production", APP_BASE_URL: undefined, VERCEL_PROJECT_PRODUCTION_URL: undefined }, () => {
    const uri = resolveCalendarOAuthRedirectUri(fakeRequest({ host: "attacker.example.com" }));
    assert.equal(uri, "https://contractor-growth-co-v4.vercel.app/api/calendar/oauth/callback");
  });
});

test("2. with no configured base URL at all, falls back to the incoming request's own Host header (local development only - never reachable in the real Vercel deployment)", () => {
  withEnv({ VERCEL_ENV: undefined, APP_BASE_URL: undefined, VERCEL_PROJECT_PRODUCTION_URL: undefined }, () => {
    const uri = resolveCalendarOAuthRedirectUri(fakeRequest({ host: "localhost:3000" }));
    assert.equal(uri, "http://localhost:3000/api/calendar/oauth/callback");
  });
});

test("3. the fallback respects x-forwarded-proto for a non-localhost host", () => {
  withEnv({ VERCEL_ENV: undefined, APP_BASE_URL: undefined, VERCEL_PROJECT_PRODUCTION_URL: undefined }, () => {
    const uri = resolveCalendarOAuthRedirectUri(fakeRequest({ host: "preview-123.vercel.app", "x-forwarded-proto": "https" }));
    assert.equal(uri, "https://preview-123.vercel.app/api/calendar/oauth/callback");
  });
});

test("4. the state cookie constants are a short-lived, narrowly-scoped configuration - 10 minutes, scoped to only the OAuth routes themselves", () => {
  assert.equal(OAUTH_STATE_COOKIE_NAME, "calendar_oauth_state");
  assert.equal(OAUTH_STATE_COOKIE_MAX_AGE_SECONDS, 600);
  assert.equal(OAUTH_STATE_COOKIE_PATH, "/api/calendar/oauth");
});

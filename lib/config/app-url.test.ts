/**
 * Final Batch 4: configurable base URL - production may name its canonical
 * domain; preview/TEST name their own; unsafe values are never used.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/config/app-url.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_PRODUCTION_APP_URL, canonicalSiteUrl, isCanonicalUrlMisconfigured, parseCanonicalOrigin, resolveAppBaseUrlFromEnv } from "./app-url";

test("production with no override keeps the existing canonical URL (unchanged behavior)", () => {
  assert.equal(resolveAppBaseUrlFromEnv({ VERCEL_ENV: "production" }), DEFAULT_PRODUCTION_APP_URL);
});

test("production can name its canonical domain with APP_CANONICAL_URL (normalized to its origin)", () => {
  assert.equal(resolveAppBaseUrlFromEnv({ VERCEL_ENV: "production", APP_CANONICAL_URL: "https://app.trackpr.example/" }), "https://app.trackpr.example");
  assert.equal(resolveAppBaseUrlFromEnv({ VERCEL_ENV: "production", APP_CANONICAL_URL: "  https://APP.Trackpr.example  " }), "https://app.trackpr.example");
});

test("production never uses an unsafe canonical value - it falls back to the safe default", () => {
  for (const bad of ["http://app.trackpr.example", "https://localhost:3000", "https://127.0.0.1", "https://app.trackpr.example/path", "https://app.trackpr.example/?x=1", "https://user:pw@app.trackpr.example", "not a url", "https://intranet"]) {
    assert.equal(resolveAppBaseUrlFromEnv({ VERCEL_ENV: "production", APP_CANONICAL_URL: bad }), DEFAULT_PRODUCTION_APP_URL, bad);
    assert.equal(isCanonicalUrlMisconfigured({ APP_CANONICAL_URL: bad }), true, bad);
  }
});

test("production ignores APP_BASE_URL / VERCEL_PROJECT_PRODUCTION_URL (the 2026-09-21 localhost incident stays fixed)", () => {
  assert.equal(resolveAppBaseUrlFromEnv({ VERCEL_ENV: "production", APP_BASE_URL: "http://localhost:3000", VERCEL_PROJECT_PRODUCTION_URL: "some-preview-xyz.vercel.app" }), DEFAULT_PRODUCTION_APP_URL);
  // Even a well-formed https APP_BASE_URL (e.g. a stale preview domain left in Production) is never used there.
  assert.equal(resolveAppBaseUrlFromEnv({ VERCEL_ENV: "production", APP_BASE_URL: "https://stale-preview.example" }), DEFAULT_PRODUCTION_APP_URL);
});

test("preview / TEST / local name their own URL with APP_BASE_URL; never the production canonical override", () => {
  assert.equal(resolveAppBaseUrlFromEnv({ VERCEL_ENV: "preview", APP_BASE_URL: "https://trackpr-test.example/", APP_CANONICAL_URL: "https://app.trackpr.example" }), "https://trackpr-test.example");
  assert.equal(resolveAppBaseUrlFromEnv({ VERCEL_ENV: "preview", VERCEL_PROJECT_PRODUCTION_URL: "project.vercel.app" }), "https://project.vercel.app");
  assert.equal(resolveAppBaseUrlFromEnv({}), null, "not configured is null, never a guess");
});

test("the public site's canonical URL is the production canonical in every environment", () => {
  assert.equal(canonicalSiteUrl({}), DEFAULT_PRODUCTION_APP_URL);
  assert.equal(canonicalSiteUrl({ VERCEL_ENV: "preview", APP_BASE_URL: "https://preview.example" }), DEFAULT_PRODUCTION_APP_URL, "a preview never advertises itself");
  assert.equal(canonicalSiteUrl({ APP_CANONICAL_URL: "https://app.trackpr.example" }), "https://app.trackpr.example");
  assert.equal(parseCanonicalOrigin(undefined), null);
});

test("the production URL literal lives in exactly one source file; robots, sitemap, the marketing site and resolveAppBaseUrl all use the helper", () => {
  const files = ["lib/automation/sms.ts", "app/robots.ts", "app/sitemap.ts", "app/(cinder)/_components/content.ts"];
  for (const file of files) assert.doesNotMatch(readFileSync(file, "utf8"), /contractor-growth-co-v4\.vercel\.app/, file);
  assert.match(readFileSync("lib/automation/sms.ts", "utf8"), /return resolveAppBaseUrlFromEnv\(process\.env\);/);
  for (const file of files.slice(1)) assert.match(readFileSync(file, "utf8"), /canonicalSiteUrl\(\)/, file);
});

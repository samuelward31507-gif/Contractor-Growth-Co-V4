/**
 * Structural/wiring tests for the email-confirmation redirect fix in
 * app/(auth)/signup/actions.ts. Root cause: signup() called
 * supabase.auth.signUp() without `options.emailRedirectTo`, so Supabase's
 * hosted /auth/v1/verify endpoint fell back to the project's Auth "Site
 * URL" after verifying the OTP - sending users to `/` instead of this app's
 * own app/auth/confirm/route.ts, which is what actually establishes the
 * session and routes into /onboarding or /dashboard.
 *
 * signup() calls createClient() from lib/supabase/server.ts (reads
 * cookies()) and resolveSignupBaseUrl() calls headers() - both throw
 * "outside a request scope" from a bare node:test script, the same
 * limitation already documented in
 * app/(auth)/signup/actions.notification.test.ts and
 * app/onboarding/actions.payment-gate.test.ts. These tests instead verify,
 * against the real source, that:
 *
 *  (a) signUp() is called with `options: { emailRedirectTo: ... }` pointing
 *      at `${baseUrl}/auth/confirm`, not left unset;
 *  (b) resolveSignupBaseUrl() follows the exact same precedence as the
 *      already-established resolveCheckoutBaseUrl() in
 *      lib/billing/checkout.ts (resolveAppBaseUrl() first, incoming
 *      request Host header only as a local-dev fallback) - so this
 *      doesn't introduce a second, inconsistent "what's our own URL"
 *      convention.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/(auth)/signup/actions.confirm-redirect.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const ACTIONS_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "app/(auth)/signup/actions.ts"), "utf8");
const CHECKOUT_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "lib/billing/checkout.ts"), "utf8");

test("1. signUp() is called with emailRedirectTo pointing at ${baseUrl}/auth/confirm", () => {
  const fnMatch = ACTIONS_SOURCE.match(/const \{ data, error \} = await supabase\.auth\.signUp\(\{[\s\S]*?\}\);/);
  assert.ok(fnMatch, "expected to find the supabase.auth.signUp(...) call");
  const body = fnMatch![0];
  assert.match(body, /options:\s*\{\s*emailRedirectTo:\s*`\$\{baseUrl\}\/auth\/confirm`\s*\}/);
});

test("2. baseUrl is resolved before signUp() is called, so emailRedirectTo is never built from a stale/undefined value", () => {
  const baseUrlIndex = ACTIONS_SOURCE.indexOf("const baseUrl = await resolveSignupBaseUrl();");
  const signUpIndex = ACTIONS_SOURCE.indexOf("supabase.auth.signUp(");
  assert.ok(baseUrlIndex !== -1 && signUpIndex !== -1 && baseUrlIndex < signUpIndex);
});

test("3. resolveSignupBaseUrl prefers resolveAppBaseUrl() (the established APP_BASE_URL / Vercel production-URL convention) before falling back to request headers", () => {
  const fnMatch = ACTIONS_SOURCE.match(/async function resolveSignupBaseUrl\(\)[\s\S]*?\n}\n/);
  assert.ok(fnMatch, "expected to find resolveSignupBaseUrl");
  const body = fnMatch![0];
  assert.match(body, /const configured = resolveAppBaseUrl\(\);/);
  assert.match(body, /if \(configured\) return configured;/);
  assert.match(body, /headerList\.get\("host"\)/);
  assert.match(body, /headerList\.get\("x-forwarded-proto"\)/);
});

test("4. resolveSignupBaseUrl mirrors resolveCheckoutBaseUrl's precedence exactly (no divergent 'what's our own URL' convention)", () => {
  const signupFn = ACTIONS_SOURCE.match(/async function resolveSignupBaseUrl\(\)[\s\S]*?\n}\n/)![0];
  const checkoutFn = CHECKOUT_SOURCE.match(/async function resolveCheckoutBaseUrl\(\)[\s\S]*?\n}\n/)![0];

  const bodyOf = (fn: string) => fn.slice(fn.indexOf("{") + 1, fn.lastIndexOf("}")).trim();
  assert.equal(bodyOf(signupFn), bodyOf(checkoutFn));
});

test("5. signup() still imports and calls resolveAppBaseUrl from the existing lib/automation/sms.ts helper, not a new one", () => {
  assert.match(ACTIONS_SOURCE, /import \{ resolveAppBaseUrl \} from "@\/lib\/automation\/sms";/);
});

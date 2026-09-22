/**
 * Structural/wiring tests for Launch Blocker #3's consent enforcement in
 * app/(auth)/signup/actions.ts. signup() calls createClient() from
 * lib/supabase/server.ts, which reads cookies() from next/headers - the
 * same "outside a request scope" limitation already documented in
 * app/(auth)/signup/actions.notification.test.ts and
 * app/(auth)/signup/actions.confirm-redirect.test.ts, so signup() can't be
 * invoked directly from a bare node:test script. These tests verify,
 * against the real source, that the consent check exists, is unconditional,
 * and runs before any account is created. Live, database-level proof that
 * the resulting terms_accepted_at/terms_version values actually persist and
 * are org-isolated lives in lib/legal/consent-persistence.integration.test.ts,
 * which does not have this limitation.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/(auth)/signup/actions.consent.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const ACTIONS_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "app/(auth)/signup/actions.ts"), "utf8");
const FORM_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "app/(auth)/signup/signup-form.tsx"), "utf8");

test("1. signup() reads agreeToTerms from the submitted form data and rejects unless it is exactly the string \"true\" - an unchecked checkbox (omitted field) must not pass", () => {
  assert.match(ACTIONS_SOURCE, /formData\.get\("agreeToTerms"\)\s*===\s*"true"/);
});

test("2. the consent check runs BEFORE supabase.auth.signUp() is ever called - no auth user, let alone an organization, is created without consent", () => {
  const consentCheckIndex = ACTIONS_SOURCE.indexOf('formData.get("agreeToTerms")');
  const signUpCallIndex = ACTIONS_SOURCE.indexOf("supabase.auth.signUp(");
  assert.ok(consentCheckIndex !== -1 && signUpCallIndex !== -1 && consentCheckIndex < signUpCallIndex);
});

test("3. the consent check returns an error and does not silently continue - it is inside an if(!agreeToTerms) branch that returns", () => {
  const fnMatch = ACTIONS_SOURCE.match(/const agreeToTerms = formData\.get\("agreeToTerms"\) === "true";\s*\n\s*if \(!agreeToTerms\) \{\s*\n\s*return \{ error: ".*?" \};\s*\n\s*\}/);
  assert.ok(fnMatch, "expected an unconditional if(!agreeToTerms) { return { error: ... } } guard");
});

test("4. signUp() is called with options.data carrying server-computed terms_accepted_at/terms_version, not a client-supplied value", () => {
  const signUpCallMatch = ACTIONS_SOURCE.match(/const \{ data, error \} = await supabase\.auth\.signUp\(\{[\s\S]*?\}\);/);
  assert.ok(signUpCallMatch, "expected to find the signUp(...) call");
  const body = signUpCallMatch![0];
  assert.match(body, /data:\s*\{\s*terms_accepted_at:\s*termsAcceptedAt,\s*terms_version:\s*TERMS_VERSION\s*\}/);
  // termsAcceptedAt must be computed server-side (new Date().toISOString()), never read from formData.
  assert.doesNotMatch(body, /formData\.get\(/);
});

test("5. termsAcceptedAt is computed server-side via new Date(), not taken from the request", () => {
  assert.match(ACTIONS_SOURCE, /const termsAcceptedAt = new Date\(\)\.toISOString\(\);/);
});

test("6. TERMS_VERSION is imported from the single shared constant, not a hardcoded literal duplicated in this file", () => {
  assert.match(ACTIONS_SOURCE, /import \{ TERMS_VERSION \} from "@\/lib\/legal\/terms-version";/);
});

test("7. the signup form renders a required checkbox named agreeToTerms with an associated label", () => {
  assert.match(FORM_SOURCE, /id="agreeToTerms"/);
  assert.match(FORM_SOURCE, /name="agreeToTerms"/);
  assert.match(FORM_SOURCE, /type="checkbox"/);
  assert.match(FORM_SOURCE, /required/);
  assert.match(FORM_SOURCE, /htmlFor="agreeToTerms"/);
});

test("8. the signup form's consent label links to both /terms and /privacy", () => {
  const labelMatch = FORM_SOURCE.match(/<label htmlFor="agreeToTerms"[\s\S]*?<\/label>/);
  assert.ok(labelMatch, "expected to find the agreeToTerms label");
  const label = labelMatch![0];
  assert.match(label, /href="\/terms"/);
  assert.match(label, /href="\/privacy"/);
});

/**
 * Structural test for the consent-persistence half of Launch Blocker #3:
 * createOrganization() (app/onboarding/actions.ts) copies terms_accepted_at/
 * terms_version from the auth user's own metadata (set at signup(), see
 * app/(auth)/signup/actions.consent.test.ts) onto the newly-created
 * organizations row, in the same request as the rest of Step 1. Same
 * "outside a request scope" limitation as every other cookies()-bound
 * Server Action in this codebase, so this is source-text verification;
 * live, database-level proof that these two columns actually persist and
 * are org-isolated lives in lib/legal/consent-persistence.integration.test.ts.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/onboarding/actions.consent.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const ACTIONS_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "app/onboarding/actions.ts"), "utf8");

test("1. createOrganization reads terms_accepted_at/terms_version from user.user_metadata, never from client-supplied formData", () => {
  assert.match(ACTIONS_SOURCE, /user\.user_metadata\?\.terms_accepted_at/);
  assert.match(ACTIONS_SOURCE, /user\.user_metadata\?\.terms_version/);
});

test("2. both values are type-checked (typeof === \"string\") before use - a missing/malformed metadata value never becomes a fabricated acceptance", () => {
  assert.match(ACTIONS_SOURCE, /typeof user\.user_metadata\?\.terms_accepted_at === "string"/);
  assert.match(ACTIONS_SOURCE, /typeof user\.user_metadata\?\.terms_version === "string"/);
});

test("3. an account with no recorded consent (both values null) writes neither column, rather than writing a fabricated acceptance", () => {
  const fnMatch = ACTIONS_SOURCE.match(/const termsAcceptedAt = [\s\S]*?\.eq\("id", organizationId\);/);
  assert.ok(fnMatch, "expected to find the organizations update block");
  assert.match(fnMatch![0], /\.\.\.\(termsAcceptedAt && termsVersion \? \{ terms_accepted_at: termsAcceptedAt, terms_version: termsVersion \} : \{\}\)/);
});

test("4. terms_accepted_at/terms_version are written in the SAME organizations update as owner_name/trade/phone, not a separate write (preserves the file's existing non-fatal-failure semantics rather than introducing a new one)", () => {
  const updateCallMatch = ACTIONS_SOURCE.match(/await supabase\s*\n\s*\.from\("organizations"\)\s*\n\s*\.update\(\{[\s\S]*?\}\)\s*\n\s*\.eq\("id", organizationId\);/);
  assert.ok(updateCallMatch, "expected to find the organizations.update(...) call");
  const body = updateCallMatch![0];
  assert.match(body, /owner_name:/);
  assert.match(body, /terms_accepted_at:|terms_accepted_at &&/);
});

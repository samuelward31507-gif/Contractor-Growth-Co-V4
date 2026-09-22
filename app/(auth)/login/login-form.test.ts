/**
 * Structural test proving the "Forgot password?" link added for Launch
 * Blocker #4 exists and points at the right route. No component-rendering
 * infrastructure exists in this repo (no jsdom/@testing-library), so this
 * is verified against the real source, the same way every other "renders"
 * claim in this codebase's test suite already is.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/(auth)/login/login-form.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const FORM_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "app/(auth)/login/login-form.tsx"), "utf8");

test("1. the login form renders a 'Forgot password?' link pointing at /forgot-password", () => {
  assert.match(FORM_SOURCE, /href="\/forgot-password"/);
  assert.match(FORM_SOURCE, /Forgot password\?/);
});

test("2. the existing email/password fields and submit button are unmodified by the addition", () => {
  assert.match(FORM_SOURCE, /id="email"/);
  assert.match(FORM_SOURCE, /id="password"/);
  assert.match(FORM_SOURCE, /Sign in/);
});

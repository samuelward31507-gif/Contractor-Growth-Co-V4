/**
 * Phase 3 (W5): first-week clarity - Today says when the workspace isn't live
 * yet (owners and admins get a link to finish setup; members are told the
 * owner can finish it), and the set-password page reads correctly for both a
 * first-time invite and a password reset.
 *
 *   node --import ./lib/automation/test-loader.mjs --test "app/(app)/today/setup-banner.structural.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

test("Today: a workspace that isn't live shows the setup banner - owners/admins get 'Finish setup', members are told the owner can finish it", () => {
  const today = read("app/(app)/today/page.tsx");
  assert.match(today, /const automationModeRead = getAutomationMode\(supabase, membership\.organizationId\);/);
  assert.match(today, /const isLive = \(await automationModeRead\) === "live";/);
  assert.match(today, /\{!isLive \? \(/);
  assert.match(today, /<Link href="\/onboarding"[^>]*>\s*Finish setup\s*<\/Link>/);
  assert.match(today, /const canFinishSetup = membership\.role === "owner" \|\| membership\.role === "admin";/);
  assert.match(today, /"Your workspace owner can finish it\."/);
});

test("set-password page: neutral copy for a first-time invite and a reset alike", () => {
  const form = read("app/auth/reset-password/reset-password-form.tsx");
  // The sign-in redesign renders every auth heading through AuthHeader, whose title is the page's h1.
  assert.match(form, /<AuthHeader title="Set your password\."/);
  assert.match(read("app/(auth)/_components/auth-ui.tsx"), /<h1 [^>]*>\{title\}<\/h1>/);
  assert.doesNotMatch(form, /Set a new password/);
});

test("operator runbook exists and documents A2P 10DLC as a manual operator step before Go Live", () => {
  const runbook = read("docs/operator-runbook.md");
  assert.match(runbook, /A2P 10DLC registration \(manual, outside the app\)/);
  assert.match(runbook, /Do not Go Live until the\s+number's campaign is approved/);
  assert.match(runbook, /Trackpr does not email the invite/);
});

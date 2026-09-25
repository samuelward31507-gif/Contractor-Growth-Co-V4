/**
 * L2 (pre-launch lead-leak audit): source-level structural verification for
 * emitCustomerReplyFollowup's dispatch-failure handling in customer-reply.ts.
 *
 * This code lives inside the function's existing `after(async () => {...})`
 * callback - the same Next.js API that, per
 * app/(app)/jobs/actions.referral-lead.integration.test.ts's own documented
 * finding, throws synchronously when called outside a real Next.js request
 * ("`after` was called outside a request scope"), which means the callback
 * body itself never executes in this codebase's plain Node test harness -
 * a genuine, pre-existing limitation shared by every after()-based dispatch
 * path in this codebase (lead-followup.ts's own dispatch-failure incident
 * recording included), not something specific to this fix. A live trigger
 * is therefore not possible here without either a test seam or an actual
 * Next.js request context, neither of which this task's scope calls for.
 *
 * Mirrors lib/automation/vertical-propagation.integration.test.ts's own
 * established precedent (its "E2"/"E3" tests) for verifying exactly this
 * class of code by direct source inspection rather than a live call.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/customer-reply-dispatch-failure.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const source = fs.readFileSync(path.join(REPO_ROOT, "lib/automation/customer-reply.ts"), "utf8");

test("L2: the dispatch-failure branch locks the conversation using the same conditional ai_enabled guard as every other lockout in this codebase", () => {
  assert.match(source, /\.update\(\{ ai_enabled: false \}\)/);
  assert.match(source, /\.eq\("id", input\.conversationId\)/);
  assert.match(source, /\.eq\("organization_id", input\.organizationId\)/);
  assert.match(source, /\.eq\("ai_enabled", true\)/);
});

test("L2: a successful lock also records a human_escalation_requested incident (HANDOFF-01's exact category/shape) alongside the existing founder notification", () => {
  assert.match(source, /category:\s*"human_escalation_requested"/);
  assert.match(source, /fingerprintContext:\s*input\.conversationId/);
  assert.match(source, /recordAutomationHealthSignal\(/);
  assert.match(source, /notifyFounder\(supabase,\s*\{[\s\S]*?kind:\s*"ai_escalation"/);
});

test("L2: the incident/notify block is positioned after the existing dispatch-failure branch opens, never before it (so it can only ever run on a failed dispatch)", () => {
  const dispatchFailureIndex = source.indexOf("if (!dispatch.ok)");
  const recordSignalIndex = source.indexOf("recordAutomationHealthSignal(");
  const escalationKindIndex = source.indexOf('kind: "ai_escalation"');
  assert.ok(dispatchFailureIndex >= 0);
  assert.ok(recordSignalIndex > dispatchFailureIndex, "the incident recording must be nested inside (after) the dispatch-failure check");
  assert.ok(escalationKindIndex > dispatchFailureIndex, "the founder notification must be nested inside (after) the dispatch-failure check");
});

test("L2 regression: retry remains intentionally unsafe for customer_reply_followup - SAFE_RETRY_AUTOMATION_IDS is unchanged, not silently widened by this fix", () => {
  const eligibilitySource = fs.readFileSync(path.join(REPO_ROOT, "lib/automation/retry-eligibility.ts"), "utf8");
  assert.match(eligibilitySource, /SAFE_RETRY_AUTOMATION_IDS = new Set\(\["appointment-reminders", "estimate-followup", "instant-lead-followup"\]\)/);
});

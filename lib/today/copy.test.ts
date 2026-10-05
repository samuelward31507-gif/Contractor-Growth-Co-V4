/**
 * Regression coverage for the Today copy layer. TypeScript already
 * enforces exhaustiveness at compile time (ATTENTION_COPY is typed as
 * Record<AttentionItem["kind"], ...>, imported from the real query file,
 * never re-declared - a build fails the moment a kind is added there
 * without a copy entry here). This test walks the union at runtime to
 * catch content-quality problems the type system can't see - an empty
 * label, a missing/invalid tone - the same "walk the union" pattern
 * app/(app)/_components/nav-items.test.ts already establishes for the nav
 * groups. Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "lib/today/copy.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ATTENTION_COPY, OPPORTUNITY_ONLY_COPY }: typeof import("./copy") = require("./copy.ts");

const VALID_TONES = new Set(["urgent", "soon", "good", "done"]);

// The real, current AttentionItem["kind"] union (lib/dashboard/queries.ts) -
// duplicated here only as literal strings for the test's own assertion
// list, never re-declared as a type ATTENTION_COPY's own Record<> already
// enforces against.
const ATTENTION_KINDS = [
  "overdue_appointment",
  "hot_lead",
  "high_value_lead",
  "pending_estimate",
  "calendar_disconnected",
  "human_escalation",
  "awaiting_reply",
  "stale_estimate",
  "dormant_customer",
  "no_show",
  "awaiting_confirmation",
  "abandoned_conversation",
  "accepted_estimate_no_job",
  "uncontacted_lead",
  "cancelled_appointment_no_rebooking",
  "completed_job_no_review_request",
  "completed_job_no_referral_request",
  // P0 A2
  "automation_needs_attention",
  "automation_retrying",
];

test("1. every real AttentionItem kind has a copy entry with a non-empty label and a valid tone", () => {
  for (const kind of ATTENTION_KINDS) {
    const entry = ATTENTION_COPY[kind as keyof typeof ATTENTION_COPY];
    assert.ok(entry, `expected a copy entry for kind "${kind}"`);
    assert.ok(entry.label.trim().length > 0, `expected a non-empty label for "${kind}"`);
    assert.ok(VALID_TONES.has(entry.tone), `expected a valid tone for "${kind}", got "${entry.tone}"`);
  }
});

test("2. ATTENTION_COPY has exactly the real kind set - no stray entries left over from a removed kind", () => {
  assert.deepEqual(Object.keys(ATTENTION_COPY).sort(), [...ATTENTION_KINDS].sort());
});

test("3. no two attention labels are byte-identical - each kind reads as its own distinct problem", () => {
  const labels = Object.values(ATTENTION_COPY).map((entry) => entry.label);
  assert.equal(new Set(labels).size, labels.length, "expected every attention label to be unique");
});

test("4. the two opportunity-only entries (no matching AttentionItem kind) have non-empty labels and valid tones", () => {
  for (const [type, entry] of Object.entries(OPPORTUNITY_ONLY_COPY)) {
    assert.ok(entry, `expected a copy entry for opportunity type "${type}"`);
    assert.ok(entry!.label.trim().length > 0, `expected a non-empty label for "${type}"`);
    assert.ok(VALID_TONES.has(entry!.tone), `expected a valid tone for "${type}", got "${entry!.tone}"`);
  }
});

test("5. OPPORTUNITY_ONLY_COPY covers exactly qualified_lead_unbooked and completed_appointment_no_estimate - the two types with no AttentionItem kind at all", () => {
  assert.deepEqual(Object.keys(OPPORTUNITY_ONLY_COPY).sort(), ["completed_appointment_no_estimate", "qualified_lead_unbooked"]);
});

/**
 * P0-B B2.8a: the strict n8n draft contract (lib/automation/n8n.ts
 * validateN8nDraftCallback / touchDraftFromN8n) - "draft returned for
 * claimed execution". n8n returns advisory output only; any field that
 * would let it name the recipient, authorize the send, assert lifecycle,
 * payment or automation state, or steer retry or timing is rejected.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test lib/automation/n8n-draft.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;
const { validateN8nDraftCallback, touchDraftFromN8n } = await import(lib("lib/automation/n8n.ts"));

type Row = Record<string, unknown>;
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const valid = (): Row => ({
  execution_id: ID(1),
  event_id: ID(2),
  organization_id: ID(3),
  automation_id: "lost-lead-nurture",
  draft: {
    body: "Hi Riley, it's Acme Roofing - still thinking about that roof?",
    needs_human: false,
    classification: { qualification_status: "qualifying", urgency: "normal", intent: "follow_up", summary: "Warm lead.", missing_information: ["budget"] },
    model: "claude-sonnet-5",
    usage: { input_tokens: 120, output_tokens: 40, total_tokens: 160 },
  },
});
const withDraft = (draft: Row): Row => ({ ...valid(), draft: { ...(valid().draft as Row), ...draft } });

test("a well-formed draft callback is accepted exactly as advisory output", () => {
  const result = validateN8nDraftCallback(valid());
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.callback, valid());
  const minimal = validateN8nDraftCallback({ ...valid(), draft: { body: null, needs_human: true, classification: null, model: "m", usage: null } });
  assert.equal(minimal.ok, true, "a declined, needs-human draft is valid");
});

test("authority fields are rejected, never ignored - at the envelope and inside the draft", () => {
  const forbidden = ["recipient", "to", "phone", "contact_id", "conversation_id", "lead_id", "send_authorized", "should_send", "gate_passed", "gate_result", "lifecycle_valid", "lifecycle_state", "organization_allowed", "payment_allowed", "payment_status", "automation_enabled", "automation_paused", "retry", "retry_after", "max_attempts", "next_action", "send_at", "schedule_at", "execution_owner"];
  for (const field of forbidden) {
    const envelope = validateN8nDraftCallback({ ...valid(), [field]: true });
    assert.deepEqual(envelope, { ok: false, error: `unexpected field: ${field}` }, `envelope ${field}`);
    const draft = validateN8nDraftCallback(withDraft({ [field]: true }));
    assert.deepEqual(draft, { ok: false, error: `unexpected field: draft.${field}` }, `draft ${field}`);
  }
  assert.deepEqual(validateN8nDraftCallback(withDraft({ classification: { qualification_status: null, urgency: null, intent: null, summary: null, missing_information: [], send_authorized: true } })), { ok: false, error: "unexpected field: draft.classification.send_authorized" });
  assert.deepEqual(validateN8nDraftCallback(withDraft({ usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, retry: 1 } })), { ok: false, error: "unexpected field: draft.usage.retry" });
});

test("identifiers must be UUIDs and an automation id - shape only; Trackpr's own rows decide whether they match", () => {
  for (const key of ["execution_id", "event_id", "organization_id"]) {
    for (const bad of [undefined, null, 7, "not-a-uuid", `${ID(1)}x`]) {
      const result = validateN8nDraftCallback({ ...valid(), [key]: bad });
      assert.deepEqual(result, { ok: false, error: `${key} must be a UUID` }, `${key}=${String(bad)}`);
    }
  }
  for (const bad of [undefined, "", "Lost Lead", "x".repeat(65), "a--b", 3]) {
    assert.deepEqual(validateN8nDraftCallback({ ...valid(), automation_id: bad }), { ok: false, error: "automation_id must be an automation id" }, String(bad));
  }
  for (const raw of [null, [], "x", 1]) assert.equal(validateN8nDraftCallback(raw).ok, false);
});

test("the draft's own fields are strict: body text within 1600 or null, a boolean needs_human, a model, known classification values, integer usage", () => {
  const bad: [Row, string][] = [
    [{ body: "" }, "draft.body must be non-empty text within the length limit, or null"],
    [{ body: "   " }, "draft.body must be non-empty text within the length limit, or null"],
    [{ body: "x".repeat(1601) }, "draft.body must be non-empty text within the length limit, or null"],
    [{ body: 42 }, "draft.body must be non-empty text within the length limit, or null"],
    [{ needs_human: "no" }, "draft.needs_human must be a boolean"],
    [{ model: null }, "draft.model must be a short string"],
    [{ model: "" }, "draft.model must be a short string"],
    [{ classification: "hot" }, "draft.classification must be an object or null"],
    [{ classification: { qualification_status: "won" } }, "draft.classification.qualification_status is not a known status"],
    [{ classification: { urgency: "now" } }, "draft.classification.urgency is not a known level"],
    [{ classification: { missing_information: Array(11).fill("x") } }, "draft.classification.missing_information must be a short list of short strings"],
    [{ usage: { input_tokens: -1 } }, "draft.usage token counts must be non-negative integers or null"],
    [{ usage: { total_tokens: 1.5 } }, "draft.usage token counts must be non-negative integers or null"],
  ];
  for (const [draft, error] of bad) assert.deepEqual(validateN8nDraftCallback(withDraft(draft)), { ok: false, error }, JSON.stringify(draft));
  assert.deepEqual(validateN8nDraftCallback({ ...valid(), draft: null }), { ok: false, error: "draft must be an object" });
  assert.equal(validateN8nDraftCallback(withDraft({ body: "x".repeat(1600) })).ok, true, "exactly the limit");
});

test("only the body and the needs-human signal ever reach the runtime", () => {
  const result = validateN8nDraftCallback(valid());
  assert.ok(result.ok);
  assert.deepEqual(touchDraftFromN8n(result.callback.draft), { body: "Hi Riley, it's Acme Roofing - still thinking about that roof?", needsHuman: false });
  assert.deepEqual(Object.keys(touchDraftFromN8n(result.callback.draft)).sort(), ["body", "needsHuman"]);
});

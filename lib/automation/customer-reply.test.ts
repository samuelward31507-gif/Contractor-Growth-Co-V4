/**
 * Unit tests for selectRecentMessages() - the pure decision behind how many
 * recent conversation messages are included in the n8n contract (Automation
 * Configuration V2.1). This file transitively imports several "@/"-aliased
 * modules, so it needs the same resolution bridge as retry.test.ts - see
 * lib/automation/test-loader.mjs. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/customer-reply.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { selectRecentMessages }: typeof import("./customer-reply") = require("./customer-reply.ts");

function makeMessages(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i}`,
    conversation_id: "conv-1",
    direction: i % 2 === 0 ? "inbound" : "outbound",
    sender_type: i % 2 === 0 ? "contact" : "ai",
    body: `message ${i}`,
    status: "sent",
    status_reason: null,
    provider_message_id: null,
    workflow_execution_id: null,
    created_at: `2026-09-19T00:00:${String(i).padStart(2, "0")}.000Z`,
    updated_at: `2026-09-19T00:00:${String(i).padStart(2, "0")}.000Z`,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  })) as any;
}

test("V2.1: the default config (10) selects exactly the last 10 of a longer history - reproducing the old hardcoded RECENT_MESSAGE_WINDOW behavior exactly", () => {
  const messages = makeMessages(30);

  const selected = selectRecentMessages(messages, { recent_message_window: 10, respect_business_hours: false });

  assert.equal(selected.length, 10);
  assert.equal(selected[0]?.body, "message 20");
  assert.equal(selected[9]?.body, "message 29");
});

test("V2.1: a smaller configured window (3) selects fewer messages than the default would - proving the configured value, not a hardcoded constant, drives the slice", () => {
  const messages = makeMessages(30);

  const selected = selectRecentMessages(messages, { recent_message_window: 3, respect_business_hours: false });

  assert.equal(selected.length, 3);
  assert.deepEqual(
    selected.map((m) => m.body),
    ["message 27", "message 28", "message 29"],
  );
});

test("V2.1: a larger configured window (25) selects more messages than the default would", () => {
  const messages = makeMessages(30);

  const selected = selectRecentMessages(messages, { recent_message_window: 25, respect_business_hours: false });

  assert.equal(selected.length, 25);
  assert.equal(selected[0]?.body, "message 5");
});

test("V2.1: a configured window larger than the actual history returns the entire history, never throws or pads", () => {
  const messages = makeMessages(4);

  const selected = selectRecentMessages(messages, { recent_message_window: 50, respect_business_hours: false });

  assert.equal(selected.length, 4);
});

test("V2.1: each selected entry carries only the four contract fields (direction, sender_type, body, created_at) - no extra message columns leak through", () => {
  const messages = makeMessages(2);

  const selected = selectRecentMessages(messages, { recent_message_window: 2, respect_business_hours: false });

  for (const entry of selected) {
    assert.deepEqual(Object.keys(entry).sort(), ["body", "created_at", "direction", "sender_type"]);
  }
});

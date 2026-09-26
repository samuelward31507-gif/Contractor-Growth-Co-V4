/**
 * Trackpr 2.0, Phase 4B (P1 #4): unit tests for getConversationsResult and
 * getLastMessagesByConversationResult, against a hand-built mocked Supabase
 * client - no real database. Mirrors this codebase's own established
 * mocked-client pattern (lib/dashboard/queries.partial-data.test.ts). No
 * mocked-client test file previously existed for lib/conversations/queries.ts.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/conversations/queries.partial-data.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const {
  getConversationsResult,
  getConversations,
  getLastMessagesByConversationResult,
  getLastMessagesByConversation,
}: typeof import("./queries") = require("./queries.ts");

type MockResult = { data: unknown; error: { message: string; code?: string } | null };

function makeMockSupabase(overrides: Partial<Record<string, MockResult>>): SupabaseClient {
  function makeBuilder(result: MockResult) {
    const builder = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      limit: () => Promise.resolve(result),
    };
    return builder;
  }
  return {
    from: (table: string) => makeBuilder(overrides[table] ?? { data: [], error: null }),
  } as unknown as SupabaseClient;
}

function makeConversationRow(id: string) {
  return {
    id,
    contact_id: "contact-1",
    lead_id: null,
    channel: "sms",
    status: "open",
    ai_enabled: true,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    contact: null,
    lead: null,
  };
}

// ---------------------------------------------------------------------------
// getConversationsResult / getConversations
// ---------------------------------------------------------------------------

test("getConversationsResult: a genuinely empty, successful result never sets failed - the Inbox must be able to tell 'zero conversations' from 'the read failed'", async () => {
  const supabase = makeMockSupabase({ conversations: { data: [], error: null } });
  const result = await getConversationsResult(supabase, "org-1");
  assert.equal(result.failed, false);
  assert.deepEqual(result.data, []);
});

test("getConversationsResult: a real Postgrest error sets failed, and never leaks the raw error", async () => {
  const supabase = makeMockSupabase({ conversations: { data: null, error: { message: "connection reset", code: "57P01" } } });
  const result = await getConversationsResult(supabase, "org-1");
  assert.equal(result.failed, true);
  assert.deepEqual(result.data, [], "still resolves to a real, empty array for the caller's convenience - `failed` is what distinguishes this from genuine emptiness");
  assert.equal(JSON.stringify(result).includes("57P01"), false);
});

test("getConversationsResult: valid existing data produces identical conversations to before this change", async () => {
  const supabase = makeMockSupabase({ conversations: { data: [makeConversationRow("conv-1"), makeConversationRow("conv-2")], error: null } });
  const result = await getConversationsResult(supabase, "org-1");
  assert.equal(result.failed, false);
  assert.equal(result.data.length, 2);
  assert.equal(result.data[0].id, "conv-1");

  // getConversations must keep delegating to the exact same read, unchanged for its existing (Dashboard/Contact Detail) callers.
  assert.deepEqual(await getConversations(supabase, "org-1"), result.data);
});

// ---------------------------------------------------------------------------
// getLastMessagesByConversationResult / getLastMessagesByConversation
// ---------------------------------------------------------------------------

function makeMessageRow(conversationId: string, id: string) {
  return {
    id,
    conversation_id: conversationId,
    direction: "outbound",
    sender_type: "ai",
    body: "test",
    status: "sent",
    status_reason: null,
    provider_error_code: null,
    provider_message_id: null,
    workflow_execution_id: null,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
  };
}

test("getLastMessagesByConversationResult: a genuinely empty result never sets failed", async () => {
  const supabase = makeMockSupabase({ messages: { data: [], error: null } });
  const result = await getLastMessagesByConversationResult(supabase, "org-1");
  assert.equal(result.failed, false);
  assert.equal(result.data.size, 0);
});

test("getLastMessagesByConversationResult: a real Postgrest error sets failed, never leaks the raw error, and never crashes", async () => {
  const supabase = makeMockSupabase({ messages: { data: null, error: { message: "timeout" } } });
  const result = await getLastMessagesByConversationResult(supabase, "org-1");
  assert.equal(result.failed, true);
  assert.equal(result.data.size, 0);
});

test("getLastMessagesByConversationResult: valid data reduces to exactly one (the newest) message per conversation, unchanged from before this phase", async () => {
  const supabase = makeMockSupabase({
    messages: {
      data: [makeMessageRow("conv-1", "msg-2"), makeMessageRow("conv-1", "msg-1")], // newest-first, matching the real query's own order()
      error: null,
    },
  });
  const result = await getLastMessagesByConversationResult(supabase, "org-1");
  assert.equal(result.failed, false);
  assert.equal(result.data.size, 1);
  assert.equal(result.data.get("conv-1")!.id, "msg-2", "the first (newest) row for a conversation wins - unchanged reduction logic");

  assert.deepEqual(await getLastMessagesByConversation(supabase, "org-1"), result.data);
});

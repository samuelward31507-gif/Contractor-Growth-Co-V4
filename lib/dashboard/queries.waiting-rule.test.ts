/**
 * Phase 3 (W1): the legacy (non-SQL) dashboard path - the default, used by
 * Agency - classifies "waiting on a reply" and "conversation went quiet" on
 * the canonical evidence (lib/conversations/waiting): a conversation's newest
 * inbound-or-successful-outbound message. A failed / undelivered / queued send
 * or a logged note is never a reply; timestamps stay on the last activity.
 *
 * Offline: an in-memory fake client routed by table and select.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/dashboard/queries.waiting-rule.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { getDashboardData }: typeof import("./queries") = require(path.join(process.cwd(), "lib/dashboard/queries.ts"));

const NOW = Date.now();
const H = 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const conversation = (id: string, status: "open" | "closed", updatedMsAgo: number) => ({
  id, contact_id: `contact-${id}`, lead_id: null, channel: "sms", status, ai_enabled: true, created_at: ago(30 * 24 * H), updated_at: ago(updatedMsAgo),
  contact: { id: `contact-${id}`, first_name: id, last_name: "Test", company_name: null, phone: null, email: null }, lead: null,
});
const message = (conversationId: string, direction: "inbound" | "outbound", status: string, msAgo: number) => ({
  id: `${conversationId}-${msAgo}`, conversation_id: conversationId, direction, sender_type: direction === "inbound" ? "customer" : "ai", body: "x", status,
  status_reason: null, provider_error_code: null, provider_message_id: null, workflow_execution_id: null, created_at: ago(msAgo), updated_at: ago(msAgo),
});

// c-failed: the customer wrote, our reply FAILED          -> waiting (old rule: "went quiet" once 48h old)
// c-note: the customer wrote, someone logged a NOTE       -> waiting
// c-quiet: we replied successfully 5 days ago, then a later send failed -> went quiet (judged from the successful send)
// c-only-failed: only a failed outbound, no customer message -> neither
// c-closed: closed                                         -> neither
const CONVERSATIONS = [conversation("c-failed", "open", 72 * H), conversation("c-note", "open", H), conversation("c-quiet", "open", 72 * H), conversation("c-only-failed", "open", 96 * H), conversation("c-closed", "closed", H)];
const LAST_MESSAGE: Record<string, ReturnType<typeof message>> = {
  "c-failed": message("c-failed", "outbound", "failed", 72 * H),
  "c-note": message("c-note", "outbound", "logged", 0.5 * H),
  "c-quiet": message("c-quiet", "outbound", "failed", 72 * H),
  "c-only-failed": message("c-only-failed", "outbound", "failed", 96 * H),
  "c-closed": message("c-closed", "inbound", "received", H),
};
// What the evidence read returns: open conversations' newest inbound-or-successful-outbound message only.
const EVIDENCE = [
  { id: "c-failed", messages: [{ direction: "inbound", created_at: ago(80 * H) }] },
  { id: "c-note", messages: [{ direction: "inbound", created_at: ago(H) }] },
  { id: "c-quiet", messages: [{ direction: "outbound", created_at: ago(120 * H) }] },
];

function fakeClient() {
  const reads: { table: string; select: string; filters: string[] }[] = [];
  const client = {
    from(table: string) {
      const read = { table, select: "", filters: [] as string[] };
      reads.push(read);
      const result = () => {
        if (table !== "conversations") return { data: table === "calendar_connections" ? null : [], error: null };
        if (read.select.includes("messages!inner")) return { data: EVIDENCE, error: null };
        if (read.select.startsWith("id, messages(")) return { data: CONVERSATIONS.map((c) => ({ id: c.id, messages: [LAST_MESSAGE[c.id]] })), error: null };
        return { data: CONVERSATIONS, error: null };
      };
      const builder: Record<string, unknown> = {
        select: (columns: string) => ((read.select = columns), builder),
        or: (filter: string) => (read.filters.push(`or ${filter}`), builder),
        range: async () => result(),
        maybeSingle: async () => ({ data: null, error: null }),
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
      };
      for (const name of ["eq", "in", "not", "is", "gte", "lt", "lte", "gt", "neq", "order", "limit"]) builder[name] = () => builder;
      return builder;
    },
    rpc: async () => ({ data: null, error: null }),
  } as unknown as SupabaseClient;
  return { client, reads };
}

test("legacy path: a failed send or a logged note after the customer's message is still waiting; a later failed send after a successful reply is 'went quiet'; failed-only and closed are neither", async () => {
  const { client, reads } = fakeClient();
  const data = await getDashboardData(client, "org-1");
  const byKind = (kind: string) => data.attentionItems.filter((item) => item.kind === kind).map((item) => item.id).sort();
  assert.deepEqual(byKind("awaiting_reply"), ["reply-c-failed", "reply-c-note"]);
  assert.deepEqual(byKind("abandoned_conversation"), ["abandoned-c-quiet"]);
  const evidenceRead = reads.find((r) => r.table === "conversations" && r.select.includes("messages!inner"));
  assert.ok(evidenceRead?.filters.includes("or direction.eq.inbound,and(direction.eq.outbound,status.in.(sent,delivered))"), "classification reads inbound + successful outbound only");
});

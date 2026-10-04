/**
 * Phase 2-13 (§3): "waiting on the business" - the latest customer message is
 * inbound and no successful outbound message has followed it. Pure rule plus
 * the one paged, organization-scoped read. Offline: an in-memory fake client.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/conversations/waiting.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { isWaitingOnBusiness, getWaitingConversationIds, getLatestEvidenceByConversation, countsAsEvidence }: typeof import("./waiting") = require(path.join(process.cwd(), "lib/conversations/waiting.ts"));

const inbound = (at: string) => ({ direction: "inbound" as const, status: "received", created_at: at });
const outbound = (at: string, status: string) => ({ direction: "outbound" as const, status, created_at: at });

test("waiting: the newest message is inbound", () => {
  assert.equal(isWaitingOnBusiness([outbound("2026-10-01T10:00:00Z", "delivered"), inbound("2026-10-01T11:00:00Z")]), true);
});

test("not waiting: a sent or delivered outbound message followed the customer's message", () => {
  assert.equal(isWaitingOnBusiness([inbound("2026-10-01T10:00:00Z"), outbound("2026-10-01T11:00:00Z", "sent")]), false);
  assert.equal(isWaitingOnBusiness([inbound("2026-10-01T10:00:00Z"), outbound("2026-10-01T11:00:00Z", "delivered")]), false);
});

test("still waiting: a failed, queued or blocked outbound after the customer's message is not a reply", () => {
  for (const status of ["failed", "queued", "blocked", "undelivered", "logged"]) {
    assert.equal(isWaitingOnBusiness([inbound("2026-10-01T10:00:00Z"), outbound("2026-10-01T11:00:00Z", status)]), true, status);
  }
});

test("not waiting: no messages, or only outbound messages", () => {
  assert.equal(isWaitingOnBusiness([]), false);
  assert.equal(isWaitingOnBusiness([outbound("2026-10-01T11:00:00Z", "delivered")]), false);
  assert.equal(isWaitingOnBusiness([outbound("2026-10-01T11:00:00Z", "failed")]), false);
});

test("order of the input does not matter - the newest by time decides", () => {
  assert.equal(isWaitingOnBusiness([inbound("2026-10-01T12:00:00Z"), outbound("2026-10-01T11:00:00Z", "sent"), inbound("2026-10-01T09:00:00Z")]), true);
  assert.equal(isWaitingOnBusiness([outbound("2026-10-01T13:00:00Z", "sent"), inbound("2026-10-01T12:00:00Z")]), false);
});

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

type Row = { id: string; messages: { direction: "inbound" | "outbound"; created_at: string }[] };

function fake(rows: Row[] | "fail") {
  const calls: string[] = [];
  const supabase = {
    from(table: string) {
      calls.push(`from ${table}`);
      const builder: Record<string, unknown> = {};
      builder.select = (columns: string) => (calls.push(`select ${columns}`), builder);
      builder.eq = (column: string, value: unknown) => (calls.push(`eq ${column} ${value}`), builder);
      builder.or = (filter: string, options: { referencedTable?: string }) => (calls.push(`or ${filter} @${options?.referencedTable}`), builder);
      builder.order = (column: string, options: { referencedTable?: string; ascending?: boolean } = {}) => (calls.push(`order ${column} @${options.referencedTable ?? ""} ${options.ascending ?? true}`), builder);
      builder.limit = (n: number, options: { referencedTable?: string } = {}) => (calls.push(`limit ${n} @${options.referencedTable ?? ""}`), builder);
      builder.range = async (from: number, to: number) => (rows === "fail" ? { data: null, error: { message: "boom" } } : { data: rows.slice(from, to + 1), error: null });
      return builder;
    },
  } as unknown as SupabaseClient;
  return { supabase, calls };
}

test("read: returns the open conversations whose newest inbound-or-successful-outbound message is inbound", async () => {
  const { supabase, calls } = fake([
    { id: "a", messages: [{ direction: "inbound", created_at: "2026-10-01T10:00:00Z" }] },
    { id: "b", messages: [{ direction: "outbound", created_at: "2026-10-01T10:00:00Z" }] },
    { id: "c", messages: [] },
  ]);
  const result = await getWaitingConversationIds(supabase, "org-1");
  assert.deepEqual([result.failed, [...result.ids]], [false, ["a"]]);
  assert.ok(calls.includes("eq organization_id org-1") && calls.includes("eq status open") && calls.includes("eq messages.organization_id org-1"), "organization-scoped, open only");
  assert.ok(calls.includes("or direction.eq.inbound,and(direction.eq.outbound,status.in.(sent,delivered)) @messages"), "only inbound and successful outbound messages are considered");
  assert.ok(calls.includes("order created_at @messages false") && calls.includes("limit 1 @messages"), "the newest such message per conversation");
  assert.ok(!calls.some((c) => c.includes("ai_enabled")), "whether AI is on is not part of the definition");
});

test("read: a contact scope narrows to that contact; a failed read is failed, never 'nobody waiting'", async () => {
  const { supabase, calls } = fake([]);
  await getWaitingConversationIds(supabase, "org-1", { contactId: "contact-9" });
  assert.ok(calls.includes("eq contact_id contact-9"));
  const failed = await getWaitingConversationIds(fake("fail").supabase, "org-1");
  assert.deepEqual([failed.failed, failed.ids.size], [true, 0]);
});

test("read: every page is read - waiting conversations past row 1,000 are included", async () => {
  const rows: Row[] = Array.from({ length: 2300 }, (_, i) => ({ id: `c-${i}`, messages: [{ direction: i >= 1000 ? "inbound" : "outbound", created_at: "2026-10-01T10:00:00Z" }] }));
  const result = await getWaitingConversationIds(fake(rows).supabase, "org-1");
  assert.equal(result.ids.size, 1300);
});

test("Phase 3: countsAsEvidence - any inbound, and only sent / delivered outbound", () => {
  assert.equal(countsAsEvidence({ direction: "inbound", status: "received" }), true);
  for (const status of ["sent", "delivered"]) assert.equal(countsAsEvidence({ direction: "outbound", status }), true, status);
  for (const status of ["failed", "undelivered", "queued", "logged", null]) assert.equal(countsAsEvidence({ direction: "outbound", status }), false, String(status));
});

test("Phase 3: getLatestEvidenceByConversation - each open conversation's newest qualifying message, newest-first with an id tie-break; absent when there is none", async () => {
  const { supabase, calls } = fake([
    { id: "a", messages: [{ direction: "inbound", created_at: "2026-10-01T10:00:00Z" }] },
    { id: "b", messages: [{ direction: "outbound", created_at: "2026-10-01T09:00:00Z" }] },
    { id: "c", messages: [] },
  ]);
  const result = await getLatestEvidenceByConversation(supabase, "org-1");
  assert.deepEqual([...result.evidence], [["a", { direction: "inbound", createdAt: "2026-10-01T10:00:00Z" }], ["b", { direction: "outbound", createdAt: "2026-10-01T09:00:00Z" }]]);
  assert.ok(calls.includes("order created_at @messages false") && calls.includes("order id @messages false"), "newest first, then id - the SQL's own tie-break");
});

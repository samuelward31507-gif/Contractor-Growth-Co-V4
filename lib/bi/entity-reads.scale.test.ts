/**
 * Phase 3 (W2): every contractor-facing list read is complete at any size -
 * paged (order + range) past the old silent 1,000 / 500 / 50-row caps, with a
 * deterministic id tie-break, and a failed page reported as failed.
 *
 * Offline: a fake client that serves `range(from, to)` slices of n rows and
 * records every call.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/bi/entity-reads.scale.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const load = <T>(file: string): T => require(path.join(ROOT, file));
const leads: typeof import("@/lib/leads/queries") = load("lib/leads/queries.ts");
const jobs: typeof import("@/lib/jobs/queries") = load("lib/jobs/queries.ts");
const estimates: typeof import("@/lib/estimates/queries") = load("lib/estimates/queries.ts");
const invoices: typeof import("@/lib/invoices/queries") = load("lib/invoices/queries.ts");
const contacts: typeof import("@/lib/contacts/queries") = load("lib/contacts/queries.ts");
const conversations: typeof import("@/lib/conversations/queries") = load("lib/conversations/queries.ts");
const appointments: typeof import("@/lib/appointments/queries") = load("lib/appointments/queries.ts");
const reviews: typeof import("@/lib/reviews-referrals/queries") = load("lib/reviews-referrals/queries.ts");
const duplicates: typeof import("@/lib/contacts/duplicates") = load("lib/contacts/duplicates.ts");

const SIZES = [999, 1000, 2500];

/** n generic rows; every field a reader might touch is present. */
const rows = (n: number, extra: (i: number) => Record<string, unknown> = () => ({})) =>
  Array.from({ length: n }, (_, i) => ({
    id: `row-${String(i).padStart(5, "0")}`, organization_id: "org-1", contact_id: "contact-1", conversation_id: "conv-1", lead_id: null, job_id: null,
    status: "new", created_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(), updated_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
    start_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(), end_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000 + 30_000).toISOString(),
    contact: null, lead: null, phone_normalized: null, email_normalized: null, ...extra(i),
  }));

function fakeClient(data: Record<string, unknown>[], failAtPage?: number) {
  const calls: string[] = [];
  const client = {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      for (const name of ["select", "eq", "in", "is", "not", "lt", "gt", "gte", "lte", "or", "limit"]) builder[name] = (...args: unknown[]) => (calls.push(`${table}.${name} ${JSON.stringify(args[0] ?? "")}`), builder);
      builder.order = (column: string, options?: { referencedTable?: string }) => (calls.push(`${table}.order ${column}${options?.referencedTable ? "@" + options.referencedTable : ""}`), builder);
      builder.range = async (from: number, to: number) => {
        calls.push(`${table}.range ${from}-${to}`);
        if (failAtPage !== undefined && from / 1000 === failAtPage) return { data: null, error: { message: "boom" } };
        return { data: data.slice(from, to + 1), error: null };
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

const READERS: [string, (c: SupabaseClient) => Promise<{ count: number; failed?: boolean }>][] = [
  ["getLeadsResult", async (c) => { const r = await leads.getLeadsResult(c, "org-1"); return { count: r.data.length, failed: r.failed }; }],
  ["getJobsResult", async (c) => { const r = await jobs.getJobsResult(c, "org-1"); return { count: r.data.length, failed: r.failed }; }],
  ["getEstimatesResult", async (c) => { const r = await estimates.getEstimatesResult(c, "org-1"); return { count: r.data.length, failed: r.failed }; }],
  ["getInvoicesResult", async (c) => { const r = await invoices.getInvoicesResult(c, "org-1"); return { count: r.data.length, failed: r.failed }; }],
  ["getConversationsResult", async (c) => { const r = await conversations.getConversationsResult(c, "org-1"); return { count: r.data.length, failed: r.failed }; }],
  ["getAppointmentsResult", async (c) => { const r = await appointments.getAppointmentsResult(c, "org-1"); return { count: r.data.length, failed: r.failed }; }],
  ["getContacts", async (c) => ({ count: (await contacts.getContacts(c, "org-1")).length })],
  ["getReviewRequestsResult", async (c) => { const r = await reviews.getReviewRequestsResult(c, "org-1"); return { count: r.data.length, failed: r.failed }; }],
  ["getContactLeads", async (c) => ({ count: (await leads.getContactLeads(c, "org-1", "contact-1")).length })],
  ["getContactJobs", async (c) => ({ count: (await jobs.getContactJobs(c, "org-1", "contact-1")).length })],
  ["getContactEstimates", async (c) => ({ count: (await estimates.getContactEstimates(c, "org-1", "contact-1")).length })],
  ["getContactInvoices", async (c) => ({ count: (await invoices.getContactInvoices(c, "org-1", "contact-1")).length })],
  ["getContactConversations", async (c) => ({ count: (await conversations.getContactConversations(c, "org-1", "contact-1")).length })],
  ["getContactAppointments", async (c) => ({ count: (await conversations.getContactAppointments(c, "org-1", "contact-1")).length })],
  ["getAppointmentsForContact", async (c) => ({ count: (await appointments.getAppointmentsForContact(c, "org-1", "contact-1")).length })],
  ["getMessages", async (c) => ({ count: (await conversations.getMessages(c, "org-1", "conv-1")).length })],
];

test("every list read returns all rows at 999, exactly 1,000 and 2,500 - past the old silent caps - ordered with an id tie-break", async () => {
  for (const [name, read] of READERS) {
    for (const n of SIZES) {
      const { client, calls } = fakeClient(rows(n));
      const result = await read(client);
      assert.equal(result.count, n, `${name} @ ${n}`);
      if (result.failed !== undefined) assert.equal(result.failed, false, `${name} @ ${n}`);
      assert.ok(calls.some((c) => /\.order id$/.test(c)), `${name}: deterministic id tie-break`);
      assert.ok(!calls.some((c) => /\.limit (1000|500|50|2000)$/.test(c)), `${name}: no row cap`);
    }
  }
});

test("a failed page is reported as failed, never as a silent partial list", async () => {
  for (const [name, read] of READERS) {
    const result = await read(fakeClient(rows(2500), 1).client);
    if (result.failed !== undefined) assert.equal(result.failed, true, name);
  }
});

test("getMessages returns the whole thread oldest-first, including the newest messages of a long conversation", async () => {
  const thread = rows(2500);
  const result = await conversations.getMessages(fakeClient(thread).client, "org-1", "conv-1");
  assert.equal(result.at(-1)!.id, thread.at(-1)!.id, "the newest message is present");
});

test("Inbox last message: every conversation gets its own newest message, however many messages the organization has", async () => {
  const conversationRows = Array.from({ length: 2500 }, (_, i) => ({ id: `conv-${i}`, messages: [{ ...rows(1)[0], id: `msg-${i}`, conversation_id: `conv-${i}` }] }));
  const { client, calls } = fakeClient(conversationRows);
  const result = await conversations.getLastMessagesByConversationResult(client, "org-1");
  assert.equal(result.data.size, 2500);
  assert.equal(result.data.get("conv-2499")!.id, "msg-2499");
  assert.ok(calls.includes("conversations.limit 1") && calls.includes("conversations.order created_at@messages"), "one newest message embedded per conversation");
  assert.ok(!calls.some((c) => /\.limit (1000|500|50|2000)$/.test(c)), "no row cap on the conversations read");
});

test("duplicates: contacts sharing a phone past row 1,000 are still found", async () => {
  const data = rows(2500, (i) => ({ phone_normalized: i === 5 || i === 2400 ? "+15555550100" : `+1555${String(i).padStart(7, "0")}`, merged_into_id: null, first_name: `c${i}`, last_name: null, email: null, phone: null, company_name: null, notes: null, sms_opt_out: false }));
  const groups = await duplicates.findPotentialDuplicates(fakeClient(data).client, "org-1");
  assert.equal(groups.length, 1);
});

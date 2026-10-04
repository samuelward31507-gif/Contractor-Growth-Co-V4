/**
 * Phase 3 (W2, K5 rule): lost-lead nurture, lead reactivation and customer
 * reactivation page through EVERY candidate (no silent 500 / 1,000 caps) in a
 * deterministic order, and a touch more than 48 hours past due is recorded as
 * overdue ("followup_overdue", under the touch's own idempotency key) and never
 * sent - so removing the caps can never become a historical SMS blast. No
 * conversation is created and no message is composed for an overdue touch.
 *
 * Offline: an in-memory fake client that serves the processors' real reads
 * and RPCs and records every call.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/late-touch.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const lateTouch: typeof import("./late-touch") = require(path.join(ROOT, "lib/automation/late-touch.ts"));
const { processLeadNurture }: typeof import("./lead-nurture") = require(path.join(ROOT, "lib/automation/lead-nurture.ts"));
const { processLeadReactivation }: typeof import("./lead-reactivation") = require(path.join(ROOT, "lib/automation/lead-reactivation.ts"));
const { processCustomerReactivation }: typeof import("./customer-reactivation") = require(path.join(ROOT, "lib/automation/customer-reactivation.ts"));

const NOW = new Date("2026-10-04T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const H = 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const pad = (i: number) => String(i).padStart(5, "0");

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

function fakeClient(tables: Tables, options: { failRangeFrom?: number } = {}) {
  const calls: string[] = [];
  const rpcCalls: { name: string; args: Row }[] = [];
  const keys = new Set<string>();
  let seq = 0;
  const client = {
    from(table: string) {
      calls.push(`from ${table}`);
      const filters: ((row: Row) => boolean)[] = [];
      const orders: [string, boolean][] = [];
      let limitN: number | undefined;
      let single = false;
      const rows = () => {
        let out = (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
        for (const [column, ascending] of [...orders].reverse()) out = [...out].sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : String(a[column]) > String(b[column]) ? 1 : 0) * (ascending ? 1 : -1));
        return limitN === undefined ? out : out.slice(0, limitN);
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: unknown) => (filters.push((row) => row[column] === value), builder),
        in: (column: string, values: unknown[]) => (filters.push((row) => values.includes(row[column])), builder),
        not: (column: string, _op: string, value: unknown) => (filters.push((row) => (value === null ? row[column] != null : row[column] !== value)), builder),
        is: (column: string, value: unknown) => (filters.push((row) => row[column] === value || (value === null && row[column] == null)), builder),
        gt: (column: string, value: string) => (filters.push((row) => String(row[column]) > value), builder),
        lte: (column: string, value: string) => (filters.push((row) => String(row[column]) <= value), builder),
        order: (column: string, opts: { ascending?: boolean } = {}) => (calls.push(`order ${table}.${column}`), orders.push([column, opts.ascending !== false]), builder),
        limit: (n: number) => ((limitN = n), builder),
        range: async (from: number, to: number) => {
          calls.push(`range ${table} ${from}`);
          if (options.failRangeFrom !== undefined && from >= options.failRangeFrom) return { data: null, error: { message: "boom" } };
          return { data: rows().slice(from, to + 1), error: null };
        },
        maybeSingle: () => ((single = true), builder),
        single: () => ((single = true), builder),
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(single ? { data: rows()[0] ?? null, error: null } : { data: rows(), error: null }).then(resolve, reject),
        insert: () => (calls.push(`insert ${table}`), builder),
        update: () => (calls.push(`update ${table}`), builder),
      };
      return builder;
    },
    rpc(name: string, args: Row = {}) {
      rpcCalls.push({ name, args });
      const answer = () => {
        if (name === "create_automation_event") {
          const key = String(args.p_idempotency_key);
          const duplicate = keys.has(key);
          keys.add(key);
          return { data: { id: `event-${++seq}`, organization_id: args.p_organization_id, is_duplicate: duplicate, status: "pending" }, error: null };
        }
        if (name === "start_workflow_execution") return { data: { id: `exec-${seq}`, status: "running", attempt: 1 }, error: null };
        if (name === "complete_workflow_execution") return { data: { id: args.p_execution_id, status: "completed" }, error: null };
        return { data: null, error: null };
      };
      const result = Promise.resolve(answer());
      return Object.assign(result, { single: () => result });
    },
  } as unknown as SupabaseClient;
  return { client, calls, rpcCalls, keys };
}

const overdueCompletions = (rpcCalls: { name: string; args: Row }[]) => rpcCalls.filter((c) => c.name === "complete_workflow_execution" && (c.args.p_metadata as Row)?.blocked_reason === "followup_overdue");

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

test("late-touch rule: hours past due, and overdue only when MORE than 48 hours late (48h exactly is still on time)", () => {
  assert.equal(lateTouch.LATE_TOUCH_GRACE_HOURS, 48);
  assert.equal(lateTouch.hoursPastDue(NOW.getTime(), NOW.getTime() - 3 * DAY, 2 * DAY), 24);
  assert.equal(lateTouch.hoursPastDue(NOW.getTime(), NOW.getTime() - DAY, 2 * DAY), -24, "not yet due");
  assert.equal(lateTouch.isTouchOverdue(48), false);
  assert.equal(lateTouch.isTouchOverdue(48.01), true);
});

test("recordOverdueTouch: claims the touch's idempotency key and completes the execution as not sent (followup_overdue); a second call is a duplicate", async () => {
  const { client, rpcCalls } = fakeClient({});
  const input = { organizationId: "org-1", eventType: "lead.reactivation", entityType: "lead", entityId: "lead-1", payload: { lead_id: "lead-1", occurrence: 2 }, idempotencyKey: "lead.reactivation:lead-1:2", workflowName: "lead_reactivation_followup", lateHours: 300 };
  assert.deepEqual(await lateTouch.recordOverdueTouch(client, input), { outcome: "blocked", reason: "followup_overdue" });
  const completion = overdueCompletions(rpcCalls)[0];
  assert.equal((completion.args.p_metadata as Row).should_send, false);
  assert.equal((completion.args.p_metadata as Row).blocked_detail, "300 hours past due");
  assert.deepEqual(await lateTouch.recordOverdueTouch(client, input), { outcome: "skipped_duplicate" });
});

// ---------------------------------------------------------------------------
// Lost-lead nurture
// ---------------------------------------------------------------------------

test("lost-lead nurture: pages every lead.lost event past the old 500 cap in id order; long-overdue touches are recorded, never dispatched, and no conversation is touched", async () => {
  const leads: Row[] = [];
  const events: Row[] = [];
  for (let i = 0; i < 1200; i++) {
    leads.push({ id: `lead-${pad(i)}`, organization_id: "org-1", contact_id: `contact-${i}`, status: "lost" });
    events.push({ id: `evt-${pad(i)}`, organization_id: "org-1", entity_id: `lead-${pad(i)}`, event_type: "lead.lost", created_at: ago(60 * DAY) }); // touch 2 due 46 days ago
  }
  leads.push({ id: "lead-recent", organization_id: "org-1", contact_id: "c-r", status: "lost" });
  events.push({ id: "evt-recent", organization_id: "org-1", entity_id: "lead-recent", event_type: "lead.lost", created_at: ago(DAY) }); // not due
  leads.push({ id: "lead-won", organization_id: "org-1", contact_id: "c-w", status: "won" });
  events.push({ id: "evt-won", organization_id: "org-1", entity_id: "lead-won", event_type: "lead.lost", created_at: ago(60 * DAY) }); // no longer lost
  const { client, calls, rpcCalls } = fakeClient({ leads, automation_events: events, organizations: [{ id: "org-1", automation_paused: false }] });

  const result = await processLeadNurture(client, NOW);
  assert.equal(result.candidates, 1202, "every candidate, past the old 500-row cap");
  const counts = result.outcomes.reduce<Record<string, number>>((acc, o) => ((acc[o.outcome] = (acc[o.outcome] ?? 0) + 1), acc), {});
  assert.deepEqual(counts, { blocked: 1200, not_due: 1, not_lost: 1 });
  assert.equal(overdueCompletions(rpcCalls).length, 1200);
  assert.ok(rpcCalls.filter((c) => c.name === "create_automation_event").every((c) => /^lead\.lost_nurture:lead-\d{5}:2$/.test(String(c.args.p_idempotency_key))), "the touch's own key - a later run sees a duplicate");
  assert.ok(!calls.includes("from conversations"), "no conversation looked up or created for an overdue touch");
  assert.ok(calls.includes("order automation_events.id"), "deterministic order");
});

test("lost-lead nurture: a failed candidate page stops the run - nothing is processed", async () => {
  const events = Array.from({ length: 1500 }, (_, i) => ({ id: `evt-${pad(i)}`, organization_id: "org-1", entity_id: `lead-${i}`, event_type: "lead.lost", created_at: ago(60 * DAY) }));
  const { client, rpcCalls } = fakeClient({ automation_events: events }, { failRangeFrom: 1000 });
  await assert.rejects(() => processLeadNurture(client, NOW), /no lead was processed/);
  assert.equal(rpcCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Lead reactivation
// ---------------------------------------------------------------------------

test("lead reactivation: pages every eligible lead past the old 500 cap; a touch long past due is recorded, never dispatched", async () => {
  const leads: Row[] = [];
  const conversations: Row[] = [];
  const messages: Row[] = [];
  for (let i = 0; i < 700; i++) {
    const lead = `lead-${pad(i)}`;
    leads.push({ id: lead, organization_id: "org-1", contact_id: `contact-${i}`, status: "contacted", service: null, source: null, ai_summary: null });
    conversations.push({ id: `conv-${i}`, organization_id: "org-1", contact_id: `contact-${i}`, channel: "sms", status: "open", lead_id: lead });
    messages.push({ id: `msg-${i}`, organization_id: "org-1", conversation_id: `conv-${i}`, direction: "inbound", created_at: ago(90 * DAY) }); // touch 2 (21d) due 69 days ago
  }
  // Within the window: last inbound 8 days ago -> touch 1 (7d) due 24h ago; dispatch path stops at a duplicate key below.
  leads.push({ id: "lead-due", organization_id: "org-1", contact_id: "contact-due", status: "contacted", service: null, source: null, ai_summary: null });
  conversations.push({ id: "conv-due", organization_id: "org-1", contact_id: "contact-due", channel: "sms", status: "open", lead_id: "lead-due" });
  messages.push({ id: "msg-due", organization_id: "org-1", conversation_id: "conv-due", direction: "inbound", created_at: ago(8 * DAY) });
  const existing = [{ id: "already", organization_id: "org-1", idempotency_key: "lead.reactivation:lead-due:1" }];
  const { client, rpcCalls } = fakeClient({ leads, conversations, messages, automation_events: existing, organizations: [{ id: "org-1", automation_paused: false }] });

  const result = await processLeadReactivation(client, NOW);
  assert.equal(result.candidates, 701);
  const counts = result.outcomes.reduce<Record<string, number>>((acc, o) => ((acc[o.outcome] = (acc[o.outcome] ?? 0) + 1), acc), {});
  assert.deepEqual(counts, { blocked: 700, skipped_duplicate: 1 }, "the on-time touch is untouched by the guard (its existing send is found as a duplicate)");
  assert.equal(overdueCompletions(rpcCalls).length, 700);
  assert.ok(rpcCalls.filter((c) => c.name === "create_automation_event").every((c) => String(c.args.p_idempotency_key).endsWith(":2")));
});

// ---------------------------------------------------------------------------
// Customer reactivation
// ---------------------------------------------------------------------------

test("customer reactivation: reads every completed job past the old 1,000 cap, so long-dormant customers are no longer dropped - and records their long-overdue touch instead of texting them", async () => {
  const jobs: Row[] = [];
  const contacts: Row[] = [];
  // 1,000 recent jobs (not yet dormant), then 300 customers whose last job was 400 days ago (dormant since 220 days).
  for (let i = 0; i < 1000; i++) {
    jobs.push({ id: `job-recent-${pad(i)}`, organization_id: "org-1", contact_id: `recent-${i}`, title: "Recent", status: "completed", completed_at: ago(10 * DAY + i * 1000) });
  }
  for (let i = 0; i < 300; i++) {
    jobs.push({ id: `job-old-${pad(i)}`, organization_id: "org-1", contact_id: `old-${i}`, title: "Old", status: "completed", completed_at: ago(400 * DAY + i * 1000) });
    contacts.push({ id: `old-${i}`, organization_id: "org-1", first_name: "Old", phone: "+15555550100", sms_opt_out: false });
  }
  const sends: unknown[] = [];
  const { client, calls, rpcCalls } = fakeClient({ jobs, contacts, organizations: [{ id: "org-1", automation_paused: false, payment_status: "active" }] });

  const result = await processCustomerReactivation(client, NOW, async (input) => (sends.push(input), { ok: true, providerMessageId: "x" }) as never);
  assert.equal(result.candidates, 300, "the dormant customers past the old 1,000-job cap are now candidates");
  assert.ok(result.outcomes.every((o) => o.outcome === "blocked" && o.reason === "followup_overdue"));
  assert.equal(overdueCompletions(rpcCalls).length, 300);
  assert.equal(sends.length, 0, "no historical blast - not one message");
  assert.ok(!calls.includes("insert conversations") && !calls.includes("insert messages"), "no conversation created and no message written for an overdue touch");
  assert.ok(calls.includes("order jobs.completed_at") && calls.includes("order jobs.id"), "newest first with an id tie-break");
});

test("customer reactivation: a customer crossing the threshold within the last 48 hours is NOT blocked by the guard (the normal path continues)", async () => {
  const jobs = [{ id: "job-1", organization_id: "org-1", contact_id: "c-1", title: "Roof", status: "completed", completed_at: ago(180 * DAY + 10 * H) }];
  const { client, rpcCalls } = fakeClient({ jobs, contacts: [{ id: "c-1", organization_id: "org-1", first_name: "Ann", phone: "+15555550100", sms_opt_out: false }], organizations: [{ id: "org-1", automation_paused: false, payment_status: "active" }], conversations: [{ id: "existing-open", organization_id: "org-1", contact_id: "c-1", status: "open" }] });
  const result = await processCustomerReactivation(client, NOW, async () => ({ ok: true, providerMessageId: "x" }) as never);
  assert.deepEqual(result.outcomes.map((o) => o.outcome), ["has_open_conversation"], "10 hours past due: the guard lets it through to the existing checks");
  assert.equal(overdueCompletions(rpcCalls).length, 0);
});

test("lost-lead nurture: lateness is measured from the touch that is due - touch 2 due 30 hours ago is on time even though touch 1 was due 11 days ago", async () => {
  const leads = [{ id: "lead-1", organization_id: "org-1", contact_id: "contact-1", status: "lost", service: null, source: null, ai_summary: null }];
  const events = [{ id: "evt-1", organization_id: "org-1", entity_id: "lead-1", event_type: "lead.lost", created_at: ago(14 * DAY + 30 * H) }];
  const contacts = [{ id: "contact-1", organization_id: "org-1", first_name: "Ann", last_name: null, phone: "+15555550100", email: null }];
  const conversations = [{ id: "conv-1", organization_id: "org-1", contact_id: "contact-1", channel: "sms", status: "open", lead_id: "lead-1" }];
  const { client, calls, rpcCalls, keys } = fakeClient({ leads, automation_events: events, contacts, conversations, organizations: [{ id: "org-1", automation_paused: false }] });
  keys.add("lead.lost_nurture:lead-1:2"); // already sent - the on-time path ends at the duplicate, before any dispatch
  const result = await processLeadNurture(client, NOW);
  assert.deepEqual(result.outcomes.map((o) => o.outcome), ["skipped_duplicate"]);
  assert.equal(overdueCompletions(rpcCalls).length, 0);
  assert.ok(calls.includes("from contacts"), "the on-time path went on to resolve the contact - the overdue path never does");
});

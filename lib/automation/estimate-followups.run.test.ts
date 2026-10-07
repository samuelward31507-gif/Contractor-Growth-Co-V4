/**
 * K5: processEstimateFollowups / previewEstimateFollowups run behavior -
 * ordered paging with no 500-row cap, a failed page stopping the run, expiry
 * before the enabled check, the 48-hour late-send guard, the enabled state
 * read once per organization, unchanged idempotency and outbound gate, and
 * the test-only organization scope.
 *
 * Offline: the outbound gate, sendOutboundMessage and the conversation
 * lookup are module-mocked; everything else runs against an in-memory fake
 * service client. No network, no database.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test lib/automation/estimate-followups.run.test.ts
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;

type GateCall = { organizationId: string; contactId: string | null; conversationId: string | null; estimateId?: string; estimateEligibleStatuses?: string[]; aiResult: { should_send: boolean; response_message: string; needs_human: boolean } };
const gateCalls: GateCall[] = [];
let gateDeny: string | null = null;
// The real module's other exports stay available (the shared touch runtime imports isWithinBusinessHours); only the gate decision is stubbed.
const realOutboundGate = await import(lib("lib/automation/outbound-gate.ts"));
mock.module(lib("lib/automation/outbound-gate.ts"), {
  namedExports: {
    ...realOutboundGate,
    evaluateOutboundGate: async (_s: unknown, input: GateCall) => {
      gateCalls.push(input);
      return gateDeny ? { allowed: false, reason: gateDeny } : { allowed: true, contactId: input.contactId, conversationId: input.conversationId, body: input.aiResult.response_message };
    },
  },
});
const sendCalls: { body: string; senderType: string }[] = [];
mock.module(lib("lib/messaging/outbound.ts"), {
  namedExports: { sendOutboundMessage: async (_s: unknown, input: { body: string; senderType: string }) => (sendCalls.push(input), { ok: true, messageId: `msg-${sendCalls.length}`, conversationId: "conv-1", providerMessageId: "SM" }) },
});
mock.module(lib("lib/conversations/queries.ts"), { namedExports: { findOrCreateOpenConversation: async () => ({ id: "conv-1" }) } });

const { processEstimateFollowups, previewEstimateFollowups, STALE_FOLLOWUP_GRACE_HOURS }: typeof import("./estimate-followups") = await import(lib("lib/automation/estimate-followups.ts"));

const NOW = new Date("2026-10-10T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
type RangeCall = { table: string; order: string | null; from: number };

function estimate(id: string, sentHoursAgo: number, extra: Row = {}): Row {
  return { id, organization_id: "org-1", contact_id: "contact-1", lead_id: null, title: `Quote ${id}`, status: "sent", sent_at: hoursAgo(sentHoursAgo), expires_at: null, ...extra };
}
const pad = (i: number) => `e-${String(i).padStart(5, "0")}`;

function fakeService(t: Tables, options: { failPage?: number } = {}) {
  const rpcCalls: { name: string; args: Row }[] = [];
  const reads: { table: string; select: string; filters: [string, unknown][] }[] = [];
  const ranges: RangeCall[] = [];
  const updates: { table: string; patch: Row; filters: [string, unknown][] }[] = [];
  let seq = 0;
  const supabase = {
    rpc(name: string, args: Row = {}) {
      rpcCalls.push({ name, args });
      const answer = () => {
        if (name === "create_automation_event") {
          const key = String(args.p_idempotency_key);
          const existing = (t.automation_events ??= []).find((e) => e.organization_id === args.p_organization_id && e.idempotency_key === key);
          if (existing) return { data: { ...existing, is_duplicate: true }, error: null };
          const created = { id: `event-${++seq}`, organization_id: args.p_organization_id, event_type: args.p_event_type, entity_id: args.p_entity_id, payload: args.p_payload, idempotency_key: key };
          t.automation_events.push(created);
          return { data: { ...created, is_duplicate: false }, error: null };
        }
        if (name === "start_workflow_execution") return { data: { id: `exec-${seq}`, status: "running" }, error: null };
        return { data: { id: args.p_execution_id }, error: null };
      };
      const result = Promise.resolve(answer());
      return Object.assign(result, { single: () => result });
    },
    from(table: string) {
      const filters: [string, unknown][] = [];
      const predicates: ((row: Row) => boolean)[] = [];
      let select = "";
      let order: string | null = null;
      let patch: Row | null = null;
      const builder: Record<string, unknown> = {};
      builder.select = (columns: string) => ((select = columns), builder);
      builder.eq = (c: string, v: unknown) => (filters.push([`eq ${c}`, v]), predicates.push((r) => r[c] === v), builder);
      builder.in = (c: string, v: unknown[]) => (filters.push([`in ${c}`, v]), predicates.push((r) => v.includes(r[c])), builder);
      builder.not = (c: string) => (filters.push([`not ${c}`, null]), predicates.push((r) => r[c] != null), builder);
      builder.order = (c: string) => ((order = c), builder);
      builder.limit = (n: number) => (filters.push(["limit", n]), builder);
      builder.update = (p: Row) => ((patch = p), builder);
      const rows = () => {
        const matched = (t[table] ?? []).filter((r) => predicates.every((p) => p(r)));
        return order ? [...matched].sort((a, b) => String(a[order!]).localeCompare(String(b[order!]))) : matched;
      };
      builder.range = async (from: number, to: number) => {
        ranges.push({ table, order, from });
        reads.push({ table, select, filters: [...filters] });
        if (options.failPage !== undefined && table === "estimates" && from / 1000 + 1 === options.failPage) return { data: null, error: { message: "boom" } };
        return { data: rows().slice(from, to + 1), error: null };
      };
      builder.maybeSingle = async () => (reads.push({ table, select, filters: [...filters] }), { data: rows()[0] ?? null, error: null });
      builder.then = (resolve: (v: unknown) => unknown) => {
        if (patch) {
          updates.push({ table, patch, filters: [...filters] });
          for (const row of rows()) Object.assign(row, patch);
          return Promise.resolve({ data: null, error: null }).then(resolve);
        }
        reads.push({ table, select, filters: [...filters] });
        return Promise.resolve({ data: rows(), error: null }).then(resolve);
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { supabase, rpcCalls, reads, ranges, updates };
}

function tables(estimates: Row[], settings: Row[] = []): Tables {
  // P0-B B2.5: the estimates' contact exists in each organization the fixtures use, so the shared runtime's B1
  // lifecycle verification finds it (fixture infrastructure only - no expectation depends on it).
  const contacts = ["org-1", "org-2", "org-3"].map((org) => ({ id: "contact-1", organization_id: org, sms_opt_out: false }));
  return { estimates, automation_settings: settings, organizations: [{ id: "org-1", automation_paused: false }, { id: "org-2", automation_paused: false }, { id: "org-3", automation_paused: false }], automation_events: [], contacts };
}
const disabled = (org = "org-1"): Row => ({ organization_id: org, automation_id: "estimate-followup", enabled: false, config: {} });
const configured = (f1: number, f2: number, org = "org-1"): Row => ({ organization_id: org, automation_id: "estimate-followup", enabled: true, config: { followup_1_hours: f1, followup_2_hours: f2 } });
const outcomeOf = (r: Awaited<ReturnType<typeof processEstimateFollowups>>) => r.outcomes.map((o) => `${o.estimateId}:${o.outcome}${"occurrence" in o ? `@${o.occurrence}` : ""}${"reason" in o ? `:${o.reason}` : ""}`);

beforeEach(() => {
  gateCalls.length = 0;
  sendCalls.length = 0;
  gateDeny = null;
});

// ---------------------------------------------------------------------------
// K5-1: ordered paging, no cap, a failed page stops the run
// ---------------------------------------------------------------------------

test("K5-1: 500 and 1,000 (and 1,200) sent estimates are all considered - no 500-row cap", async () => {
  for (const n of [500, 1000, 1200]) {
    const fake = fakeService(tables(Array.from({ length: n }, (_, i) => estimate(pad(i), 1))));
    const result = await processEstimateFollowups(fake.supabase, NOW);
    assert.equal(result.candidates, n, `${n}`);
    assert.equal(result.outcomes.length, n);
    assert.ok(result.outcomes.every((o) => o.outcome === "not_due"));
    assert.ok(!fake.reads.some((r) => r.table === "estimates" && r.filters.some(([f]) => f === "limit")), "no .limit on the candidate read");
  }
});

test("K5-1: stable ordered paging - every page ordered by id, processed in id order, across the 1,000-row page boundary", async () => {
  const ids = Array.from({ length: 1200 }, (_, i) => pad(i));
  const shuffled = [...ids].reverse().map((id) => estimate(id, 1));
  const fake = fakeService(tables(shuffled));
  const result = await processEstimateFollowups(fake.supabase, NOW);
  assert.deepEqual(fake.ranges.filter((r) => r.table === "estimates").map((r) => [r.order, r.from]), [["id", 0], ["id", 1000]]);
  assert.deepEqual(result.outcomes.map((o) => o.estimateId), ids);
});

test("K5-1: a failed page stops the run - it throws, and nothing is expired, claimed or sent", async () => {
  const rows = Array.from({ length: 1200 }, (_, i) => estimate(pad(i), i === 0 ? 30 : 1, i === 1 ? { expires_at: hoursAgo(1) } : {}));
  const fake = fakeService(tables(rows), { failPage: 2 });
  await assert.rejects(processEstimateFollowups(fake.supabase, NOW), /candidate read failed or reached the row limit - no estimate was processed/);
  assert.deepEqual([fake.rpcCalls.length, fake.updates.length, sendCalls.length], [0, 0, 0]);
});

// ---------------------------------------------------------------------------
// K5-2: expiry first; disabled sends nothing
// ---------------------------------------------------------------------------

test("K5-2: with the automation disabled, a past-expiry estimate still expires - no message, no event logged", async () => {
  const rows = [estimate("e-expired", 500, { expires_at: hoursAgo(2) })];
  const t = tables(rows, [disabled()]);
  const fake = fakeService(t);
  const result = await processEstimateFollowups(fake.supabase, NOW);
  assert.deepEqual(outcomeOf(result), ["e-expired:expired"]);
  assert.equal(t.estimates[0].status, "expired");
  assert.equal(t.automation_events.length, 0, "the event rules (enabled, not paused) still decide whether estimate.expired is logged");
  assert.deepEqual([gateCalls.length, sendCalls.length], [0, 0]);
});

test("K5-2: an enabled organization's past-expiry estimate expires and logs estimate.expired, as before", async () => {
  const t = tables([estimate("e-expired", 500, { expires_at: hoursAgo(2) })]);
  const result = await processEstimateFollowups(fakeService(t).supabase, NOW);
  assert.deepEqual(outcomeOf(result), ["e-expired:expired"]);
  assert.deepEqual(t.automation_events.map((e) => e.idempotency_key), ["estimate.expired:e-expired"]);
});

test("K5-2: with the automation disabled, a due follow-up is never sent", async () => {
  const result = await processEstimateFollowups(fakeService(tables([estimate("e-due", 30)], [disabled()])).supabase, NOW);
  assert.deepEqual(outcomeOf(result), ["e-due:skipped_disabled"]);
  assert.deepEqual([gateCalls.length, sendCalls.length], [0, 0]);
});

test("enabled: a normally due follow-up goes through the unchanged outbound gate and sends once", async () => {
  const result = await processEstimateFollowups(fakeService(tables([estimate("e-due", 30)])).supabase, NOW);
  assert.deepEqual(outcomeOf(result), ["e-due:sent@1"]);
  assert.equal(gateCalls.length, 1);
  assert.deepEqual([gateCalls[0].estimateId, gateCalls[0].estimateEligibleStatuses, gateCalls[0].aiResult.should_send, gateCalls[0].aiResult.needs_human], ["e-due", ["sent"], true, false]);
  assert.deepEqual([sendCalls.length, sendCalls[0].senderType], [1, "ai"]);
});

test("the outbound gate still decides: a gate block is recorded and nothing is sent", async () => {
  gateDeny = "contact_opted_out";
  const result = await processEstimateFollowups(fakeService(tables([estimate("e-due", 30)])).supabase, NOW);
  assert.deepEqual(outcomeOf(result), ["e-due:blocked:contact_opted_out"]);
  assert.equal(sendCalls.length, 0);
});

// ---------------------------------------------------------------------------
// K5-3: the 48-hour late-send guard
// ---------------------------------------------------------------------------

test("K5-3: exactly 48 hours past due still sends normally; more than 48 hours past due is recorded as not sent", async () => {
  assert.equal(STALE_FOLLOWUP_GRACE_HOURS, 48);
  // followup_1 at 24h, followup_2 at 200h: an estimate sent 72h ago is exactly 48h past its first check-in.
  const exactly = await processEstimateFollowups(fakeService(tables([estimate("e-48", 72)], [configured(24, 200)])).supabase, NOW);
  assert.deepEqual(outcomeOf(exactly), ["e-48:sent@1"]);
  assert.equal(sendCalls.length, 1);

  sendCalls.length = 0;
  const t = tables([estimate("e-late", 72 + 1 / 60)], [configured(24, 200)]);
  const fake = fakeService(t);
  const late = await processEstimateFollowups(fake.supabase, NOW);
  assert.deepEqual(outcomeOf(late), ["e-late:blocked:followup_overdue"]);
  assert.deepEqual([gateCalls.length, sendCalls.length], [1, 0], "only e-48 reached the gate");
  assert.deepEqual(t.automation_events.map((e) => e.idempotency_key), ["estimate.followup:e-late:1"], "the occurrence's own idempotency key is claimed");
  const completion = fake.rpcCalls.find((c) => c.name === "complete_workflow_execution")!;
  assert.match(JSON.stringify(completion.args), /"should_send":false/);
  assert.match(JSON.stringify(completion.args), /"blocked_reason":"followup_overdue"/);
});

test("K5-3: a skipped stale follow-up can never send on a later run; the next occurrence still sends when it is due on time", async () => {
  const t = tables([estimate("e-late", 80)], [configured(24, 200)]);
  await processEstimateFollowups(fakeService(t).supabase, NOW);
  const again = await processEstimateFollowups(fakeService(t).supabase, new Date(NOW.getTime() + 3600_000));
  assert.deepEqual(outcomeOf(again), ["e-late:skipped_duplicate"]);
  assert.equal(sendCalls.length, 0);
  // At 200h the second check-in is due and on time: it sends.
  const later = await processEstimateFollowups(fakeService(t).supabase, new Date(NOW.getTime() + 120 * 3600_000));
  assert.deepEqual(outcomeOf(later), ["e-late:sent@2"]);
  assert.equal(sendCalls.length, 1);
});

test("K5-3: a starved estimate weeks past its last check-in gets no burst - one stale occurrence recorded, no message", async () => {
  const result = await processEstimateFollowups(fakeService(tables([estimate("e-starved", 24 * 21)])).supabase, NOW);
  assert.deepEqual(outcomeOf(result), ["e-starved:blocked:followup_overdue"]);
  assert.equal(sendCalls.length, 0);
});

// ---------------------------------------------------------------------------
// K5-5: enabled read once per organization; idempotency unchanged
// ---------------------------------------------------------------------------

test("K5-5 (R-b): the enabled state is read once per organization per run", async () => {
  const rows = ["org-1", "org-2", "org-3"].flatMap((org) => Array.from({ length: 50 }, (_, i) => estimate(`${org}-${pad(i)}`, 1, { organization_id: org })));
  const fake = fakeService(tables(rows));
  await processEstimateFollowups(fake.supabase, NOW);
  const enabledReads = fake.reads.filter((r) => r.table === "automation_settings" && r.select === "enabled");
  assert.deepEqual(enabledReads.map((r) => r.filters.find(([f]) => f === "eq organization_id")![1]).sort(), ["org-1", "org-2", "org-3"]);
});

test("idempotency unchanged: running twice sends once - the second run's event is a duplicate and is suppressed", async () => {
  const t = tables([estimate("e-due", 30)]);
  const first = await processEstimateFollowups(fakeService(t).supabase, NOW);
  const second = await processEstimateFollowups(fakeService(t).supabase, NOW);
  assert.deepEqual([outcomeOf(first), outcomeOf(second)], [["e-due:sent@1"], ["e-due:skipped_duplicate"]]);
  assert.equal(sendCalls.length, 1);
  assert.deepEqual(t.automation_events.map((e) => e.idempotency_key), ["estimate.followup:e-due:1"]);
});

// ---------------------------------------------------------------------------
// K5-5 (R-c): preview paging; K5-4: the test-only scope
// ---------------------------------------------------------------------------

test("K5-5 (R-c): the preview pages in id order with no 500 cap - it finds the first due estimate past the old cap", async () => {
  const rows = [...Array.from({ length: 1100 }, (_, i) => estimate(pad(i), 1)), estimate(pad(1100), 30)].reverse();
  const fake = fakeService(tables(rows));
  const preview = await previewEstimateFollowups(fake.supabase, "org-1", NOW);
  assert.deepEqual([preview.outcome, "estimateId" in preview ? preview.estimateId : null], ["would_send", pad(1100)]);
  assert.deepEqual(fake.ranges.filter((r) => r.table === "estimates").map((r) => [r.order, r.from]), [["id", 0], ["id", 1000]]);
  assert.ok(!fake.reads.some((r) => r.table === "estimates" && r.filters.some(([f]) => f === "limit")));
});

test("K5-3 in the preview: a check-in more than 48 hours past due is not previewed as would_send", async () => {
  const preview = await previewEstimateFollowups(fakeService(tables([estimate("e-late", 80)], [configured(24, 200)])).supabase, "org-1", NOW);
  assert.equal(preview.outcome, "no_candidates");
});

test("K5-4: the test-only scope limits a run to one organization; without it the run stays global", async () => {
  const rows = [estimate("a", 1, { organization_id: "org-1" }), estimate("b", 1, { organization_id: "org-2" })];
  const scoped = await processEstimateFollowups(fakeService(tables(rows)).supabase, NOW, undefined, "event", { organizationId: "org-2" });
  assert.deepEqual(scoped.outcomes.map((o) => o.estimateId), ["b"]);
  const global = await processEstimateFollowups(fakeService(tables(rows)).supabase, NOW);
  assert.deepEqual(global.outcomes.map((o) => o.estimateId), ["a", "b"]);
});

test("structural: no .limit(500) left; the scheduled route and the Run now action never pass the test-only scope", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "lib/automation/estimate-followups.ts"), "utf8");
  assert.doesNotMatch(source, /\.limit\(500\)/);
  const route = fs.readFileSync(path.join(process.cwd(), "app/api/automation/estimate-followups/route.ts"), "utf8");
  assert.match(route, /await processEstimateFollowups\(service\);/);
  const actions = fs.readFileSync(path.join(process.cwd(), "app/(app)/automations/actions.ts"), "utf8");
  assert.match(actions, /await processEstimateFollowups\(supabase, new Date\(\), undefined, "manual"\)/);
});

// ===========================================================================
// P0-B B2.5a: test infrastructure only. A future migration of estimate
// follow-up onto the shared touch runtime reads the contact's B1 lifecycle
// snapshot; this proves the fake service above can serve that read (through
// the runtime's own verifyLifecycle) without changing any expectation above.
// ===========================================================================

test("infrastructure: the fake service serves the shared runtime's B1 lifecycle snapshot read (and reports a contact that is not the organization's)", async () => {
  const { verifyLifecycle } = await import(lib("lib/followups/engine.ts"));
  const t = { ...tables([estimate("e-1", 30)], [configured(24, 72)]), contacts: [{ id: "contact-1", organization_id: "org-1", sms_opt_out: false }] };
  const fake = fakeService(t);
  const verified = await verifyLifecycle(fake.supabase, "org-1", "contact-1", NOW);
  assert.equal(verified.failed, false);
  assert.equal(verified.snapshot.contactId, "contact-1");
  assert.equal(verified.lifecycle.stage, "estimate_follow_up", "the sent estimate is the contact's lifecycle position");
  const missing = await verifyLifecycle(fakeService({ ...t, contacts: [] }).supabase, "org-1", "contact-1", NOW);
  assert.deepEqual(missing, { failed: true, error: "contact_not_found" });
});

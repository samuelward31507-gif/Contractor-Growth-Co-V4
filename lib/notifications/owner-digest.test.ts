/**
 * Phase 3G-1: the weekly owner digest - local-time eligibility across time
 * zones, signal selection from the existing reads, composition (quiet weeks,
 * partial data, failed reads never shown as zero), per-organization
 * per-week idempotency, the owner's own setting, delivery success and
 * failure, the scheduled route's authorization and liveness, and proof that
 * no customer outbound path is involved.
 *
 * Offline: an in-memory fake Supabase client; delivery is injected. No
 * network, no database, no local environment file.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/notifications/owner-digest.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const digest: typeof import("./owner-digest") = require(path.join(ROOT, "lib/notifications/owner-digest.ts"));
const { ownerDigestWindow, ownerDigestIdempotencyKey, composeOwnerDigest, loadOwnerDigestSignals, runOwnerDigest, OWNER_DIGEST_EVENT_TYPE, OWNER_DIGEST_WORKFLOW } = digest;
const { getAutomationForEventType, getAutomationForWorkflowName, AUTOMATION_CATALOG }: typeof import("@/lib/automation/catalog") = require(path.join(ROOT, "lib/automation/catalog.ts"));
const { SCHEDULED_AUTOMATION_IDS }: typeof import("@/lib/automation-health/scheduled-automation-liveness") = require(path.join(ROOT, "lib/automation-health/scheduled-automation-liveness.ts"));
const { GET, POST }: typeof import("@/app/api/automation/owner-digest/route") = require(path.join(ROOT, "app/api/automation/owner-digest/route.ts"));
const { NextRequest }: typeof import("next/server") = require("next/server");

type Signals = import("./owner-digest").OwnerDigestSignals;
type FounderInput = import("./founder").FounderNotificationInput;
type FounderResult = import("./founder").FounderNotificationResult;

// 2026-10-05 is a Monday.
const MONDAY_1305Z = new Date("2026-10-05T13:05:00Z"); // Denver 07:05, New York 09:05, Los Angeles 06:05, Tokyo 22:05

// ---------------------------------------------------------------------------
// Fake Supabase client
// ---------------------------------------------------------------------------

type Org = { id: string; timezone: string | null };
type FakeOptions = {
  orgs?: Org[];
  scanFails?: boolean;
  settings?: Record<string, Record<string, unknown> | null>;
  existingKeys?: Set<string>;
  opportunities?: Record<string, { type: string; estimated_value: number | null }[] | "fail">;
  escalations?: Record<string, number | "fail">;
  health?: Record<string, Record<string, unknown> | "fail">;
  eventRpcFails?: boolean;
};

function fakeService(options: FakeOptions = {}) {
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const queriedTables: string[] = [];
  let eventSeq = 0;
  const supabase = {
    rpc(name: string, args: Record<string, unknown> = {}) {
      rpcCalls.push({ name, args });
      const answer = () => {
        if (name === "organization_health_inputs") {
          const inputs = options.health?.[String(args.p_organization_id)] ?? {};
          return inputs === "fail" ? { data: null, error: { message: "boom" } } : { data: inputs, error: null };
        }
        if (name === "create_automation_event") {
          if (options.eventRpcFails) return { data: null, error: { message: "boom" } };
          const key = String(args.p_idempotency_key);
          const duplicate = options.existingKeys?.has(key) ?? false;
          options.existingKeys?.add(key);
          return { data: { id: `event-${++eventSeq}`, is_duplicate: duplicate, status: "pending" }, error: null };
        }
        if (name === "start_workflow_execution") return { data: { id: `exec-${eventSeq}`, status: "running" }, error: null };
        if (name === "complete_workflow_execution") return { data: { id: args.p_execution_id, status: "completed" }, error: null };
        if (name === "fail_workflow_execution") return { data: { id: args.p_execution_id, status: "failed" }, error: null };
        return { data: null, error: null };
      };
      const result = Promise.resolve(answer());
      return Object.assign(result, { single: () => result });
    },
    from(table: string) {
      queriedTables.push(table);
      const filters: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {};
      for (const name of ["select", "order", "not", "in", "limit"]) builder[name] = () => builder;
      builder.eq = (column: string, value: unknown) => ((filters[column] = value), builder);
      builder.range = async (from: number, to: number) => {
        if (table === "organizations") return options.scanFails ? { data: null, error: { message: "boom" } } : { data: (options.orgs ?? []).slice(from, to + 1), error: null };
        if (table === "opportunities") {
          const rows = options.opportunities?.[String(filters.organization_id)] ?? [];
          if (rows === "fail") return { data: null, error: { message: "boom" } };
          return { data: rows.map((r, i) => ({ id: `opp-${i}`, organization_id: filters.organization_id, status: "open", ...r })).slice(from, to + 1), error: null };
        }
        return { data: [], error: null };
      };
      builder.maybeSingle = async () => {
        if (table === "notification_settings") return { data: options.settings?.[String(filters.organization_id)] ?? null, error: null };
        if (table === "automation_events") return { data: options.existingKeys?.has(String(filters.idempotency_key)) ? { id: "existing" } : null, error: null };
        if (table === "workflow_executions") return { data: { status: "running" }, error: null };
        return { data: null, error: null };
      };
      builder.then = (resolve: (value: unknown) => unknown) => {
        if (table === "conversations") {
          const count = options.escalations?.[String(filters.organization_id)] ?? 0;
          return Promise.resolve(count === "fail" ? { count: null, error: { message: "boom" } } : { count, error: null }).then(resolve);
        }
        return Promise.resolve({ data: null, error: null }).then(resolve);
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { supabase, rpcCalls, queriedTables };
}

const OWNER = { notification_phone: "+15555550100", notification_email: null, notify_on_owner_digest: true };
const signals = (overrides: Partial<Signals> = {}): Signals => ({
  opportunities: { failed: false, count: 0, knownValue: 0, topTypes: [], overdueInvoiceCount: 0, overdueInvoiceValue: 0 },
  health: { failed: false, automationIssues: 0, staleScheduledAutomations: 0 },
  escalations: { failed: false, count: 0 },
  ...overrides,
});
const BUSY = signals({ opportunities: { failed: false, count: 4, knownValue: 12500, topTypes: [{ type: "stale_estimate", count: 2 }], overdueInvoiceCount: 1, overdueInvoiceValue: 800 } });

function recorder(result: FounderResult = { outcome: "delivered", sms: true, email: false }) {
  const calls: FounderInput[] = [];
  return { calls, notify: async (_s: SupabaseClient, input: FounderInput) => (calls.push(input), result) };
}
const quiet = () => {};

// ---------------------------------------------------------------------------
// Local-time eligibility
// ---------------------------------------------------------------------------

test("window: Monday from 7:00 to before noon local is due, keyed by that Monday's local date; other days and hours are not", () => {
  assert.deepEqual(ownerDigestWindow(new Date("2026-10-05T13:00:00Z"), "America/Denver"), { due: true, weekOf: "2026-10-05" });
  assert.deepEqual(ownerDigestWindow(new Date("2026-10-05T12:59:00Z"), "America/Denver"), { due: false }, "06:59 is too early");
  assert.deepEqual(ownerDigestWindow(new Date("2026-10-05T17:59:00Z"), "America/Denver"), { due: true, weekOf: "2026-10-05" }, "11:59 still catches a missed 7:00");
  assert.deepEqual(ownerDigestWindow(new Date("2026-10-05T18:00:00Z"), "America/Denver"), { due: false }, "noon closes the window");
  assert.deepEqual(ownerDigestWindow(new Date("2026-10-06T13:05:00Z"), "America/Denver"), { due: false }, "Tuesday");
});

test("window across time zones: the same instant is Monday 7am in some zones and not in others; a zone ahead of UTC is due on Sunday UTC", () => {
  assert.equal(ownerDigestWindow(MONDAY_1305Z, "America/Denver").due, true);
  assert.equal(ownerDigestWindow(MONDAY_1305Z, "America/New_York").due, true);
  assert.equal(ownerDigestWindow(MONDAY_1305Z, "America/Los_Angeles").due, false);
  assert.equal(ownerDigestWindow(MONDAY_1305Z, "Asia/Tokyo").due, false);
  const sundayUtc = new Date("2026-10-04T22:30:00Z"); // Tokyo Monday 07:30
  assert.deepEqual(ownerDigestWindow(sundayUtc, "Asia/Tokyo"), { due: true, weekOf: "2026-10-05" });
  assert.equal(ownerDigestWindow(sundayUtc, "America/Denver").due, false);
  assert.throws(() => ownerDigestWindow(MONDAY_1305Z, "Not/AZone"), RangeError);
});

test("idempotency key: one per organization per local Monday", () => {
  assert.equal(ownerDigestIdempotencyKey("org-1", "2026-10-05"), "owner.digest:org-1:2026-10-05");
  assert.notEqual(ownerDigestIdempotencyKey("org-1", "2026-10-05"), ownerDigestIdempotencyKey("org-1", "2026-10-12"));
  assert.notEqual(ownerDigestIdempotencyKey("org-1", "2026-10-05"), ownerDigestIdempotencyKey("org-2", "2026-10-05"));
});

// ---------------------------------------------------------------------------
// Signals and composition
// ---------------------------------------------------------------------------

test("signals: open opportunities (count, known value, top types without overdue invoices), overdue invoices, incidents and escalations come from the existing reads", async () => {
  const { supabase } = fakeService({
    opportunities: {
      "org-1": [
        { type: "stale_estimate", estimated_value: 1000 },
        { type: "stale_estimate", estimated_value: 2000 },
        { type: "uncontacted_lead", estimated_value: null },
        { type: "invoice_overdue", estimated_value: 450 },
        { type: "invoice_overdue", estimated_value: 550 },
        { type: "no_show", estimated_value: 300 },
        { type: "dormant_customer", estimated_value: 100 },
      ],
    },
    health: { "org-1": { incidents: [{ category: "workflow_stuck", severity: "warning" }, { category: "sms_delivery_failed", severity: "warning" }], organization: { payment_status: "active", automation_paused: false } } },
    escalations: { "org-1": 3 },
  });
  const s = await loadOwnerDigestSignals(supabase, "org-1");
  assert.deepEqual(s.opportunities, {
    failed: false,
    count: 7,
    knownValue: 4400,
    topTypes: [
      { type: "stale_estimate", count: 2 },
      { type: "dormant_customer", count: 1 },
      { type: "no_show", count: 1 },
    ],
    overdueInvoiceCount: 2,
    overdueInvoiceValue: 1000,
  });
  assert.deepEqual(s.health, { failed: false, automationIssues: 2, staleScheduledAutomations: 0 });
  assert.deepEqual(s.escalations, { failed: false, count: 3 });
});

test("signals: each failed read is marked failed - never a zero", async () => {
  const { supabase } = fakeService({ opportunities: { "org-1": "fail" }, health: { "org-1": "fail" }, escalations: { "org-1": "fail" } });
  const s = await loadOwnerDigestSignals(supabase, "org-1");
  assert.deepEqual(s, { opportunities: { failed: true }, health: { failed: true }, escalations: { failed: true } });
});

test("compose: a busy week reads as one short message with each real figure", () => {
  const composed = composeOwnerDigest(
    signals({
      opportunities: { failed: false, count: 7, knownValue: 4400, topTypes: [{ type: "stale_estimate", count: 2 }, { type: "no_show", count: 1 }], overdueInvoiceCount: 2, overdueInvoiceValue: 1000 },
      health: { failed: false, automationIssues: 1, staleScheduledAutomations: 0 },
      escalations: { failed: false, count: 3 },
    }),
  );
  assert.deepEqual(composed, {
    kind: "send",
    partial: false,
    summary: "7 open opportunities worth $4,400. Top: 2 stale estimates, 1 no-show. 2 overdue invoices ($1,000). 1 automation issue open. 3 conversations waiting for your team.",
  });
  assert.ok(composed.kind === "send" && composed.summary.length < 320, "short enough for SMS");
});

test("compose: a quiet week (every read fine, nothing to act on) sends nothing", () => {
  assert.deepEqual(composeOwnerDigest(signals()), { kind: "quiet" });
});

test("compose: a failed read is left out (never '0') and the partial line is added; with nothing else to say only the partial line is sent", () => {
  const partial = composeOwnerDigest(signals({ opportunities: { failed: true }, escalations: { failed: false, count: 2 } }));
  assert.deepEqual(partial, { kind: "send", partial: true, summary: "2 conversations waiting for your team. Some figures couldn't be loaded - check Today." });
  assert.doesNotMatch(partial.kind === "send" ? partial.summary : "", /\b0\b|opportunit/);

  const partialOnly = composeOwnerDigest(signals({ health: { failed: true } }));
  assert.deepEqual(partialOnly, { kind: "send", partial: true, summary: "Some figures couldn't be loaded - check Today." }, "can't claim a quiet week when a read failed");

  const nothing = composeOwnerDigest({ opportunities: { failed: true }, health: { failed: true }, escalations: { failed: true } });
  assert.deepEqual(nothing, { kind: "send", partial: true, summary: "This week's summary couldn't be loaded - check Today." });
});

test("compose: no customer names, phone numbers or ids ever appear - only counts, money and type labels", () => {
  const composed = composeOwnerDigest(BUSY);
  assert.ok(composed.kind === "send");
  assert.doesNotMatch(composed.summary, /\+?\d{10,}|@|[0-9a-f]{8}-[0-9a-f]{4}/);
});

// ---------------------------------------------------------------------------
// Run: eligibility, idempotency, setting, delivery
// ---------------------------------------------------------------------------

test("run: a due organization with something to report gets one SMS-only owner notification and a completed execution", async () => {
  const keys = new Set<string>();
  const { supabase, rpcCalls } = fakeService({ orgs: [{ id: "org-1", timezone: "America/Denver" }], settings: { "org-1": OWNER }, existingKeys: keys });
  const { calls, notify } = recorder();
  const result = await runOwnerDigest(supabase, MONDAY_1305Z, { loadSignals: async () => BUSY, notify, log: quiet });
  assert.deepEqual([result.sent, result.failed, result.candidates], [1, 0, 1]);
  assert.equal(calls.length, 1);
  assert.deepEqual({ ...calls[0], summary: undefined }, { organizationId: "org-1", kind: "owner_digest", summary: undefined, detailPath: "/today", smsOnly: true });
  const event = rpcCalls.find((c) => c.name === "create_automation_event")!;
  assert.deepEqual([event.args.p_event_type, event.args.p_idempotency_key, event.args.p_entity_type], [OWNER_DIGEST_EVENT_TYPE, "owner.digest:org-1:2026-10-05", "organization"]);
  assert.equal(rpcCalls.find((c) => c.name === "start_workflow_execution")!.args.p_workflow_name, OWNER_DIGEST_WORKFLOW);
  assert.deepEqual(rpcCalls.find((c) => c.name === "complete_workflow_execution")!.args.p_metadata, { outcome: "sent", partial: false });
});

test("run: per-organization per-week idempotency - a second tick in the same window never sends again; the next Monday does", async () => {
  const keys = new Set<string>();
  const options = { orgs: [{ id: "org-1", timezone: "America/Denver" }], settings: { "org-1": OWNER }, existingKeys: keys };
  const { calls, notify } = recorder();
  await runOwnerDigest(fakeService(options).supabase, MONDAY_1305Z, { loadSignals: async () => BUSY, notify, log: quiet });
  const second = await runOwnerDigest(fakeService(options).supabase, new Date("2026-10-05T13:20:00Z"), { loadSignals: async () => BUSY, notify, log: quiet });
  assert.deepEqual([calls.length, second.outcomes[0].outcome], [1, "duplicate"]);
  await runOwnerDigest(fakeService(options).supabase, new Date("2026-10-12T13:05:00Z"), { loadSignals: async () => BUSY, notify, log: quiet });
  assert.equal(calls.length, 2, "a new week is a new key");
});

test("run: a race lost at the database (the event RPC reports a duplicate) sends nothing", async () => {
  const keys = new Set<string>();
  const { supabase } = fakeService({ orgs: [{ id: "org-1", timezone: "America/Denver" }], settings: { "org-1": OWNER }, existingKeys: keys });
  // Simulate another tick creating the event between the fast path and the RPC.
  const { calls, notify } = recorder();
  const result = await runOwnerDigest(supabase, MONDAY_1305Z, { loadSignals: async () => (keys.add("owner.digest:org-1:2026-10-05"), BUSY), notify, log: quiet });
  assert.deepEqual([result.outcomes[0].outcome, calls.length], ["duplicate", 0]);
});

test("run: organizations outside their Monday-morning window are skipped with no further reads", async () => {
  const { supabase, queriedTables } = fakeService({ orgs: [{ id: "org-la", timezone: "America/Los_Angeles" }, { id: "org-tokyo", timezone: "Asia/Tokyo" }] });
  const { calls, notify } = recorder();
  const result = await runOwnerDigest(supabase, MONDAY_1305Z, { loadSignals: async () => BUSY, notify, log: quiet });
  assert.deepEqual(result.outcomes.map((o) => o.outcome), ["not_due", "not_due"]);
  assert.deepEqual([calls.length, queriedTables], [0, ["organizations"]]);
});

test("run: the owner's setting off, or no phone number, sends and records nothing", async () => {
  for (const [settings, expected] of [
    [{ ...OWNER, notify_on_owner_digest: false }, "disabled"],
    [{ ...OWNER, notification_phone: null }, "no_recipient"],
  ] as const) {
    const { supabase, rpcCalls } = fakeService({ orgs: [{ id: "org-1", timezone: "America/Denver" }], settings: { "org-1": settings }, existingKeys: new Set() });
    const { calls, notify } = recorder();
    const result = await runOwnerDigest(supabase, MONDAY_1305Z, { loadSignals: async () => BUSY, notify, log: quiet });
    assert.deepEqual([result.outcomes[0].outcome, calls.length, rpcCalls.some((c) => c.name === "create_automation_event")], [expected, 0, false]);
  }
});

test("run: a quiet week records the decision once and sends nothing", async () => {
  const keys = new Set<string>();
  const { supabase, rpcCalls } = fakeService({ orgs: [{ id: "org-1", timezone: "America/Denver" }], settings: { "org-1": OWNER }, existingKeys: keys });
  const { calls, notify } = recorder();
  const result = await runOwnerDigest(supabase, MONDAY_1305Z, { loadSignals: async () => signals(), notify, log: quiet });
  assert.deepEqual([result.quiet, result.sent, calls.length], [1, 0, 0]);
  assert.deepEqual(rpcCalls.find((c) => c.name === "complete_workflow_execution")!.args.p_metadata, { outcome: "quiet" });
});

test("run: a failed owner delivery fails the execution (sms_send_failed), counts as failed, and the route never reports it as success", async () => {
  const { supabase, rpcCalls } = fakeService({ orgs: [{ id: "org-1", timezone: "America/Denver" }], settings: { "org-1": OWNER }, existingKeys: new Set() });
  const { notify } = recorder({ outcome: "failed" });
  const result = await runOwnerDigest(supabase, MONDAY_1305Z, { loadSignals: async () => BUSY, notify, log: quiet });
  assert.deepEqual([result.failed, result.sent], [1, 0]);
  const fail = rpcCalls.find((c) => c.name === "fail_workflow_execution")!;
  assert.equal(fail.args.p_error_message, "The weekly owner summary SMS could not be delivered.");
  assert.doesNotMatch(JSON.stringify(rpcCalls), /\+1555/, "the phone number is never written");
  const route = fs.readFileSync(path.join(ROOT, "app/api/automation/owner-digest/route.ts"), "utf8");
  assert.match(route, /ok: !result\.scanFailed && result\.failed === 0/);
});

test("run: partial data is delivered with the partial line; the payload records failed reads as null, never 0", async () => {
  const { supabase, rpcCalls } = fakeService({ orgs: [{ id: "org-1", timezone: "America/Denver" }], settings: { "org-1": OWNER }, existingKeys: new Set() });
  const { calls, notify } = recorder();
  await runOwnerDigest(supabase, MONDAY_1305Z, { loadSignals: async () => signals({ opportunities: { failed: true }, escalations: { failed: false, count: 1 } }), notify, log: quiet });
  assert.match(calls[0].summary, /Some figures couldn't be loaded - check Today\.$/);
  const payload = rpcCalls.find((c) => c.name === "create_automation_event")!.args.p_payload as Record<string, unknown>;
  assert.deepEqual([payload.open_opportunities, payload.overdue_invoices, payload.escalations, payload.partial], [null, null, 1, true]);
});

test("run: one organization's failure never stops the others; a failed scan evaluates nothing", async () => {
  const keys = new Set<string>();
  const { supabase } = fakeService({ orgs: [{ id: "org-bad", timezone: "Not/AZone" }, { id: "org-1", timezone: "America/Denver" }], settings: { "org-1": OWNER }, existingKeys: keys });
  const { calls, notify } = recorder();
  const result = await runOwnerDigest(supabase, MONDAY_1305Z, { loadSignals: async () => BUSY, notify, log: quiet });
  assert.deepEqual(result.outcomes.map((o) => o.outcome), ["failed", "sent"]);
  assert.equal(calls.length, 1);
  const scan = await runOwnerDigest(fakeService({ scanFails: true }).supabase, MONDAY_1305Z, { loadSignals: async () => BUSY, notify, log: quiet });
  assert.deepEqual([scan.scanFailed, scan.candidates], [true, 0]);
});

test("run: eligibility mirrors the existing scheduled owner alert - live, payment active, not paused", () => {
  const source = fs.readFileSync(path.join(ROOT, "lib/notifications/owner-digest.ts"), "utf8");
  assert.match(source, /\.eq\("automation_mode", "live"\)\.eq\("payment_status", "active"\)\.eq\("automation_paused", false\)\.order\("id"\)/);
});

// ---------------------------------------------------------------------------
// Owner-facing only, notification kind, catalog
// ---------------------------------------------------------------------------

test("owner-facing only: the digest never imports or calls the customer outbound path, the outbound gate or n8n", () => {
  const source = fs.readFileSync(path.join(ROOT, "lib/notifications/owner-digest.ts"), "utf8");
  const imports = source.split("\n").filter((line) => /^import\s/.test(line)).join("\n");
  assert.doesNotMatch(imports, /messaging\/outbound|outbound-gate|automation\/sms|n8n|twilio/i);
  assert.doesNotMatch(source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""), /sendOutboundMessage|evaluateOutboundGate|sendSms\(/);
  assert.match(source, /notifyFounder/);
});

test("notification kind: owner_digest maps to notify_on_owner_digest, labeled 'Weekly summary', default on, with an SMS-only option", () => {
  const founder = fs.readFileSync(path.join(ROOT, "lib/notifications/founder.ts"), "utf8");
  assert.match(founder, /\| "owner_digest";/);
  assert.match(founder, /owner_digest: "notify_on_owner_digest",/);
  assert.match(founder, /owner_digest: "Weekly summary",/);
  assert.match(founder, /const emailTo = input\.smsOnly \? null : settings\.notification_email;/);
  const settings = fs.readFileSync(path.join(ROOT, "lib/settings/queries.ts"), "utf8");
  assert.match(settings, /notify_on_owner_digest: true,/);
  const form = fs.readFileSync(path.join(ROOT, "app/(app)/settings/_components/notification-settings-section.tsx"), "utf8");
  assert.match(form, /name: "notifyOnOwnerDigest",\s*key: "notify_on_owner_digest"/);
  const action = fs.readFileSync(path.join(ROOT, "app/(app)/settings/actions.ts"), "utf8");
  assert.match(action, /notify_on_owner_digest: formData\.get\("notifyOnOwnerDigest"\) === "on",/);
});

test("catalog: the digest is not a customer automation - no catalog entry claims its event type or workflow, so the automation toggles never gate it", () => {
  assert.equal(getAutomationForEventType(OWNER_DIGEST_EVENT_TYPE), null);
  assert.equal(getAutomationForWorkflowName(OWNER_DIGEST_WORKFLOW), null);
  assert.ok(!AUTOMATION_CATALOG.some((a) => a.id === "owner-digest"));
});

// ---------------------------------------------------------------------------
// Scheduled route
// ---------------------------------------------------------------------------

test("route: CRON_SECRET authorization fails closed - no header, a wrong secret, or an unset secret all get 401 (GET and POST)", async () => {
  const original = process.env.CRON_SECRET;
  try {
    process.env.CRON_SECRET = "test-secret-value";
    for (const handler of [GET, POST]) {
      assert.equal((await handler(new NextRequest("https://example.test/api/automation/owner-digest"))).status, 401);
      assert.equal((await handler(new NextRequest("https://example.test/api/automation/owner-digest", { headers: { authorization: "Bearer wrong-secret-value" } }))).status, 401);
    }
    delete process.env.CRON_SECRET;
    assert.equal((await GET(new NextRequest("https://example.test/api/automation/owner-digest", { headers: { authorization: "Bearer test-secret-value" } }))).status, 401);
  } finally {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  }
});

test("route: authorizes before creating the service client and records liveness as 'owner-digest'; the liveness catalog tracks it", () => {
  const source = fs.readFileSync(path.join(ROOT, "app/api/automation/owner-digest/route.ts"), "utf8");
  assert.ok(source.indexOf("isAuthorizedCronRequest(request)") < source.indexOf("createServiceRoleClient()"));
  assert.match(source, /recordScheduledAutomationRun\(service, "owner-digest", result\.candidates\)/);
  assert.ok((SCHEDULED_AUTOMATION_IDS as readonly string[]).includes("owner-digest"));
});

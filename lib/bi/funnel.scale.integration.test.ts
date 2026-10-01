/**
 * Phase 2F: response time and stage timing at real volume against
 * disposable TEST fixtures - 450 leads with distinct contacts (past the
 * ~400-id point where an id-list read fails), 1,350 outbound messages (past
 * the API's 1,000-row cap) where the newest lead's reply is the very last
 * message, older replies to the same contacts that must not count, failed
 * sends that must not count, 1,350 stage events, and a second organization
 * that must never be counted.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/bi/funnel.scale.integration.test.ts
 *
 * Inserts are plain rows (stage events already 'completed'), so no
 * automation, n8n or provider call is made. after() deletes both fixture
 * organizations; everything else cascades.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const REPO_ROOT = process.cwd();
const require = createRequire(path.join(REPO_ROOT, "package.json"));
require("@next/env").loadEnvConfig(REPO_ROOT, true, { info() {}, error() {} });
if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("lwofqffxagxiqodqvcfr")) throw new Error("Phase 2F scale fixtures run against the TEST project only.");

const { createServiceRoleClient }: typeof import("@/lib/supabase/service") = require(path.join(REPO_ROOT, "lib/supabase/service.ts"));
const { getLeadResponseTimeMetrics, getLeadsForRangeResult }: typeof import("./funnel") = require(path.join(REPO_ROOT, "lib/bi/funnel.ts"));
const { getBusinessMetricsSnapshot }: typeof import("./metrics") = require(path.join(REPO_ROOT, "lib/bi/metrics.ts"));
const { resolveDateRange }: typeof import("./queries") = require(path.join(REPO_ROOT, "lib/bi/queries.ts"));

const service = createServiceRoleClient();
const LEADS = 450;
const UNREPLIED = 50; // leads 0-49: only failed sends and older replies
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW = Date.now();
const FIRST_LEAD_AT = NOW - 5 * DAY;
const iso = (ms: number) => new Date(ms).toISOString();
const leadCreatedAt = (i: number) => FIRST_LEAD_AT + i * 10 * MIN;
const replyMinutes = (i: number) => 1 + (i % 60);

let orgA: string;
let orgB: string;
let newestLeadId: string;

async function insertAll(table: string, rows: Record<string, unknown>[], columns = "id"): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < rows.length; i += 500) {
    const { data, error } = await service.from(table).insert(rows.slice(i, i + 500) as never).select(columns);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as unknown as Record<string, unknown>[]));
  }
  return out;
}

before(async () => {
  const orgs = await insertAll("organizations", [{ name: "Phase 2F Funnel Scale Test Org A" }, { name: "Phase 2F Funnel Scale Test Org B" }], "id, name");
  orgA = orgs.find((o) => String(o.name).endsWith("A"))!.id as string;
  orgB = orgs.find((o) => String(o.name).endsWith("B"))!.id as string;

  const contacts = await insertAll("contacts", Array.from({ length: LEADS }, (_, i) => ({ organization_id: orgA, phone: `+1555557${String(i).padStart(4, "0")}` })), "id, phone");
  const contactIds = contacts.sort((a, b) => String(a.phone).localeCompare(String(b.phone))).map((c) => c.id as string);
  const leads = await insertAll(
    "leads",
    contactIds.map((contactId, i) => ({ organization_id: orgA, contact_id: contactId, source: "website", status: "won", temperature: "warm", created_at: iso(leadCreatedAt(i)) })),
    "id, contact_id",
  );
  const leadByContact = new Map(leads.map((l) => [l.contact_id as string, l.id as string]));
  newestLeadId = leadByContact.get(contactIds[LEADS - 1])!;
  const conversations = await insertAll("conversations", contactIds.map((contactId) => ({ organization_id: orgA, contact_id: contactId, channel: "sms", status: "open" })), "id, contact_id");
  const conversationByContact = new Map(conversations.map((c) => [c.contact_id as string, c.id as string]));

  const message = (i: number, at: number, status: string) => ({ organization_id: orgA, conversation_id: conversationByContact.get(contactIds[i])!, direction: "outbound", sender_type: "user", body: "Phase 2F scale fixture", status, created_at: iso(at) });
  const messages = [
    // Older replies to the same contacts - before each lead existed, one in the previous period.
    ...contactIds.flatMap((_, i) => [message(i, leadCreatedAt(i) - 40 * DAY, "delivered"), message(i, leadCreatedAt(i) - 60 * MIN, "sent")]),
    // Failed sends after creation for the unreplied leads - attempts, never contact.
    ...contactIds.slice(0, UNREPLIED).map((_, i) => message(i, leadCreatedAt(i) + 5 * MIN, "failed")),
    // Each remaining lead's reply; the newest lead's is the latest message of all.
    ...contactIds.map((_, i) => i).filter((i) => i >= UNREPLIED).map((i) => message(i, leadCreatedAt(i) + replyMinutes(i) * MIN, "delivered")),
  ];
  assert.equal(messages.length, 1350);
  await insertAll("messages", messages);

  const stageEvent = (leadId: string, previous: string, next: string, at: number) => ({ organization_id: orgA, event_type: "lead.stage_changed", entity_type: "lead", entity_id: leadId, status: "completed", payload: { previous_status: previous, new_status: next }, created_at: iso(at) });
  await insertAll(
    "automation_events",
    contactIds.flatMap((contactId, i) => {
      const leadId = leadByContact.get(contactId)!;
      return [stageEvent(leadId, "new", "contacted", leadCreatedAt(i) + 10 * MIN), stageEvent(leadId, "contacted", "qualified", leadCreatedAt(i) + 20 * MIN), stageEvent(leadId, "qualified", "won", leadCreatedAt(i) + 30 * MIN)];
    }),
  );

  // Organization B: one lead and a reply in the same window - never counted for A.
  const [bContact] = await insertAll("contacts", [{ organization_id: orgB, phone: "+15555579999" }]);
  await insertAll("leads", [{ organization_id: orgB, contact_id: bContact.id, source: "website", status: "new", temperature: "warm", created_at: iso(FIRST_LEAD_AT) }]);
  const [bConversation] = await insertAll("conversations", [{ organization_id: orgB, contact_id: bContact.id, channel: "sms", status: "open" }]);
  await insertAll("messages", [{ organization_id: orgB, conversation_id: bConversation.id, direction: "outbound", sender_type: "user", body: "Phase 2F scale fixture", status: "delivered", created_at: iso(FIRST_LEAD_AT + MIN) }]);
});

after(async () => {
  for (const orgId of [orgA, orgB].filter(Boolean)) {
    const { error } = await service.from("organizations").delete().eq("id", orgId);
    if (error) console.error(`PHASE2F_FIXTURE_CLEANUP_FAILED=${orgId}: ${error.message}`);
  }
});

test("450 leads with distinct contacts and 1,350 messages: every reply found, every unreplied lead - and only those - never contacted", async () => {
  const snapshot = await getBusinessMetricsSnapshot(service, orgA, "last30Days");
  assert.deepEqual(snapshot.funnelUnavailable, { responseTime: false, stageTransitions: false, stageTiming: false });
  const { responseTime } = snapshot;
  assert.deepEqual([responseTime.totalLeadsInPopulation, responseTime.leadsContacted, responseTime.leadsNeverContacted], [LEADS, LEADS - UNREPLIED, UNREPLIED]);
  const expectedAverage = Array.from({ length: LEADS - UNREPLIED }, (_, k) => replyMinutes(k + UNREPLIED) * MIN).reduce((a, b) => a + b, 0) / (LEADS - UNREPLIED);
  assert.equal(responseTime.averageResponseTimeMs, expectedAverage, "each lead's own first reply - never an older one, never a failed send");
  assert.deepEqual(snapshot.comparisons.leadsContacted, { current: LEADS - UNREPLIED, previous: 0, change: LEADS - UNREPLIED, percentageChange: null });
});

test("the newest lead, whose reply is the last of 1,350 messages, is contacted", async () => {
  const range = resolveDateRange("last30Days");
  const { leads, failed } = await getLeadsForRangeResult(service, orgA, range);
  assert.equal(failed, false);
  const newest = leads.filter((l) => l.id === newestLeadId);
  assert.equal(newest.length, 1);
  const metrics = await getLeadResponseTimeMetrics(service, orgA, newest);
  assert.deepEqual([metrics.failed, metrics.leadsContacted, metrics.averageResponseTimeMs], [false, 1, replyMinutes(LEADS - 1) * MIN]);
});

test("1,350 stage events: every transition counted and every lead timed", async () => {
  const { leadStageFunnel } = await getBusinessMetricsSnapshot(service, orgA, "last30Days");
  assert.deepEqual([leadStageFunnel.transitions.totalTransitions, leadStageFunnel.transitions.leadsTransitionedToQualified, leadStageFunnel.transitions.leadsTransitionedToWon], [1350, LEADS, LEADS]);
  const { timing } = leadStageFunnel;
  assert.deepEqual([timing.leadsInRange, timing.leadsWithRecordedHistory, timing.leadsWithQualifiedTiming, timing.leadsWithWonTiming], [LEADS, LEADS, LEADS, LEADS]);
  assert.deepEqual([timing.averageTimeToQualifiedMs, timing.averageTimeToWonMs], [20 * MIN, 30 * MIN]);
});

test("organization isolation: B sees its one lead and reply; A's fixtures never reach B", async () => {
  const snapshot = await getBusinessMetricsSnapshot(service, orgB, "last30Days");
  assert.deepEqual([snapshot.responseTime.totalLeadsInPopulation, snapshot.responseTime.leadsContacted, snapshot.responseTime.averageResponseTimeMs], [1, 1, MIN]);
  assert.equal(snapshot.leadStageFunnel.transitions.totalTransitions, 0);
});

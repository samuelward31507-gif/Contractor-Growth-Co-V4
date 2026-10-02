/**
 * Phase 2J: message, conversation and opt-out counts at real volume against
 * disposable TEST fixtures - 1,200 conversations, 2,500 messages in the
 * period (100 failed and 50 undelivered among them) and 1,200 new contacts
 * with 300 opted out, all past the API's 1,000-row cap; 300 messages in the
 * previous period that must not be counted; organization isolation. The
 * byMessageStatus checked here is exactly what Agency's direct
 * getCommunicationMetrics call receives. A read failure can't be induced
 * safely on TEST; it is unit-tested in communication.scale.test.ts.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/bi/communication.scale.integration.test.ts
 *
 * Inserts are plain rows - no automation, n8n, Twilio or provider call.
 * after() deletes both fixture organizations; everything else cascades.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const REPO_ROOT = process.cwd();
const require = createRequire(path.join(REPO_ROOT, "package.json"));
require("@next/env").loadEnvConfig(REPO_ROOT, true, { info() {}, error() {} });
if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("lwofqffxagxiqodqvcfr")) throw new Error("Phase 2J scale fixtures run against the TEST project only.");

const { createServiceRoleClient }: typeof import("@/lib/supabase/service") = require(path.join(REPO_ROOT, "lib/supabase/service.ts"));
const { getCommunicationMetrics, resolveDateRange }: typeof import("./queries") = require(path.join(REPO_ROOT, "lib/bi/queries.ts"));
const { getBusinessMetricsSnapshot }: typeof import("./metrics") = require(path.join(REPO_ROOT, "lib/bi/metrics.ts"));

const service = createServiceRoleClient();
const TZ = "UTC";
const NOW = new Date();
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const CHANNELS = ["sms", "web", "email", "voice"];
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
let orgA = "";
let orgB = "";

/** 2,500 messages in the period: alternating inbound/outbound, outbound senders cycling, with 100 failed and 50 undelivered sends. */
const periodMessages = range(2500).map((i) => {
  if (i % 2 === 0) return { direction: "inbound", sender_type: "customer", status: "received" };
  const status = i < 200 ? "failed" : i < 300 ? "undelivered" : "delivered";
  return { direction: "outbound", sender_type: ["ai", "user", "system"][i % 3], status };
});
const outbound = periodMessages.filter((m) => m.direction === "outbound");

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
  const orgs = await insertAll("organizations", [{ name: "Phase 2J Communication Scale Test Org A", timezone: TZ }, { name: "Phase 2J Communication Scale Test Org B", timezone: TZ }], "id, name");
  orgA = orgs.find((o) => String(o.name).endsWith("A"))!.id as string;
  orgB = orgs.find((o) => String(o.name).endsWith("B"))!.id as string;

  const contacts = (await insertAll("contacts", range(1200).map((i) => ({ organization_id: orgA, phone: `+15558${String(100_000 + i)}`, sms_opt_out: i % 4 === 0, created_at: daysAgo(3) })))).map((c) => c.id as string);
  const conversations = (await insertAll("conversations", contacts.map((contact, i) => ({ organization_id: orgA, contact_id: contact, channel: CHANNELS[i % 4], status: i % 3 === 0 ? "closed" : "open", created_at: daysAgo(3) })))).map((c) => c.id as string);
  await insertAll("messages", [
    ...periodMessages.map((m, i) => ({ organization_id: orgA, conversation_id: conversations[i % conversations.length], body: "Phase 2J fixture", ...m, created_at: daysAgo(2) })),
    // The previous period - never counted.
    ...range(300).map((i) => ({ organization_id: orgA, conversation_id: conversations[i], direction: "outbound", sender_type: "ai", status: "failed", body: "Phase 2J fixture", created_at: daysAgo(40) })),
  ]);

  const [bContact] = await insertAll("contacts", [{ organization_id: orgB, phone: "+15558999999", sms_opt_out: true, created_at: daysAgo(3) }]);
  const [bConversation] = await insertAll("conversations", [{ organization_id: orgB, contact_id: bContact.id, channel: "sms", status: "open", created_at: daysAgo(3) }]);
  await insertAll("messages", [{ organization_id: orgB, conversation_id: bConversation.id, direction: "outbound", sender_type: "user", status: "undelivered", body: "Phase 2J fixture", created_at: daysAgo(2) }]);
});

after(async () => {
  for (const orgId of [orgA, orgB].filter(Boolean)) {
    const { error } = await service.from("organizations").delete().eq("id", orgId);
    if (error) console.error(`PHASE2J_FIXTURE_CLEANUP_FAILED=${orgId}: ${error.message}`);
  }
});

test("2,500 messages and 1,200 conversations in the period: exact direction, sender, status and channel counts - the complete byMessageStatus Agency receives", async () => {
  const m = await getCommunicationMetrics(service, orgA, resolveDateRange("last30Days", NOW, TZ));
  assert.equal(m.failed, false);
  assert.deepEqual([m.totalInboundMessages, m.totalOutboundMessages], [1250, 1250]);
  assert.deepEqual([m.aiOutboundMessages, m.userOutboundMessages, m.systemOutboundMessages], ["ai", "user", "system"].map((s) => outbound.filter((o) => o.sender_type === s).length));
  assert.deepEqual([m.failedMessages, m.undeliveredMessages, m.deliveredMessages, m.byMessageStatus.received], [100, 50, 1100, 1250], "the previous period's 300 failed sends are never counted");
  assert.deepEqual([m.openConversations, m.closedConversations], [800, 400]);
  assert.deepEqual([m.smsConversations, m.webConversations, m.emailConversations, m.voiceConversations], [300, 300, 300, 300]);
});

test("the snapshot: complete communication figures and 300 opt-outs among 1,200 new contacts; nothing unavailable", async () => {
  const s = await getBusinessMetricsSnapshot(service, orgA, "last30Days", { timeZone: TZ, now: NOW });
  assert.equal(s.communicationUnavailable, false);
  const c = s.communicationMetrics;
  assert.deepEqual([c.inboundMessages, c.outboundMessages, c.conversationsOpened, c.conversationsClosed, c.optOutCount], [1250, 1250, 800, 400, 300]);
  assert.ok(!s.dataQuality.notes.some((n) => n.startsWith("Message, conversation and opt-out counts could not be read")));
});

test("organization isolation: B sees only its own message, conversation and opt-out", async () => {
  const m = await getCommunicationMetrics(service, orgB, resolveDateRange("last30Days", NOW, TZ));
  assert.deepEqual([m.totalOutboundMessages, m.undeliveredMessages, m.openConversations], [1, 1, 1]);
  const s = await getBusinessMetricsSnapshot(service, orgB, "last30Days", { timeZone: TZ, now: NOW });
  assert.equal(s.communicationMetrics.optOutCount, 1);
});

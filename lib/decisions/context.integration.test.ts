/**
 * Phase 2-3: getDecisionContext against a real database (TEST). Proves
 * what the offline fake cannot: PostgREST's embedded per-conversation
 * message order and limit, the contact embed, and the organization / AI
 * settings reads, on one disposable organization that is removed afterwards.
 *
 * Writes only to the TEST project configured in .env.local, and deletes
 * everything it creates.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/decisions/context.integration.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const require = createRequire(path.join(REPO_ROOT, "package.json"));

const envPath = path.join(REPO_ROOT, ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

const { createServiceRoleClient }: typeof import("@/lib/supabase/service") = require(path.join(REPO_ROOT, "lib/supabase/service.ts"));
const { getDecisionContext }: typeof import("./context") = require(path.join(REPO_ROOT, "lib/decisions/context.ts"));

const service = createServiceRoleClient();
const MIN = 60 * 1000;
let organizationId: string;
const conversationIds: Record<string, string> = {};

const contactIds: Record<string, string> = {};

async function contactAndConversation(label: string, phone: string, smsOptOut: boolean, aiEnabled: boolean): Promise<string> {
  const { data: contact, error: contactError } = await service.from("contacts").insert({ organization_id: organizationId, first_name: `Ctx ${label}`, phone, sms_opt_out: smsOptOut }).select("id").single();
  assert.ifError(contactError);
  const { data: conversation, error } = await service.from("conversations").insert({ organization_id: organizationId, contact_id: contact!.id, channel: "sms", status: "open", ai_enabled: aiEnabled }).select("id").single();
  assert.ifError(error);
  contactIds[label] = contact!.id;
  return conversation!.id;
}

async function message(conversationId: string, direction: "inbound" | "outbound", minutesAgo: number) {
  const { error } = await service.from("messages").insert({
    organization_id: organizationId, conversation_id: conversationId, direction, sender_type: direction === "inbound" ? "customer" : "user",
    body: `ctx ${direction} ${minutesAgo}`, status: direction === "inbound" ? "received" : "delivered", created_at: new Date(Date.now() - minutesAgo * MIN).toISOString(),
  });
  assert.ifError(error);
}

before(async () => {
  const { data: org, error } = await service.from("organizations").insert({ name: "Decision Context Test Org" }).select("id").single();
  assert.ifError(error);
  organizationId = org!.id;
  const { error: liveError } = await service.from("organizations").update({ automation_mode: "live", payment_status: "active", automation_paused: false }).eq("id", organizationId);
  assert.ifError(liveError);
  await service.from("ai_settings").insert({ organization_id: organizationId, ai_enabled: true });

  // conv-1: answered 30 min ago, then two unanswered customer messages (9 and 2 minutes ago).
  conversationIds.one = await contactAndConversation("One", "+15555019001", false, true);
  await message(conversationIds.one, "outbound", 30);
  await message(conversationIds.one, "inbound", 9);
  await message(conversationIds.one, "inbound", 2);
  // conv-2: 25 unanswered inbound messages - the embedded read must stop at the newest 20, per conversation.
  conversationIds.two = await contactAndConversation("Two", "+15555019002", false, true);
  for (let i = 1; i <= 25; i++) await message(conversationIds.two, "inbound", i);
  // conv-3: opted out, AI turned off.
  conversationIds.three = await contactAndConversation("Three", "+15555019003", true, false);
  await message(conversationIds.three, "inbound", 3);
});

after(async () => {
  await service.from("opportunities").delete().eq("organization_id", organizationId);
  await service.from("messages").delete().eq("organization_id", organizationId);
  await service.from("conversations").delete().eq("organization_id", organizationId);
  await service.from("contacts").delete().eq("organization_id", organizationId);
  await service.from("ai_settings").delete().eq("organization_id", organizationId);
  await service.from("automation_settings").delete().eq("organization_id", organizationId);
  await service.from("organizations").delete().eq("id", organizationId);
});

const waiting = (id: string) => ({ id: `reply-${id}`, kind: "awaiting_reply" as const, title: "Ctx", detail: "Waiting", value: null, href: `/conversations/${id}`, conversationId: id });

test("real reads: AI flag, contact opt-out and the first unanswered inbound message per conversation, with the embedded message limit applied per conversation", async () => {
  const context = await getDecisionContext(service, organizationId, { attentionItems: [waiting(conversationIds.one), waiting(conversationIds.two), waiting(conversationIds.three)], timeZone: "UTC" });
  assert.equal(context.organizationEligible, true);
  assert.equal(context.aiSettingsEnabled, true);
  assert.equal(context.waitingCapReached, false);

  const one = context.waitingConversations.get(conversationIds.one)!;
  assert.deepEqual([one.aiEnabled, one.smsOptOut], [true, false]);
  assert.ok(Math.abs(Date.now() - 9 * MIN - Date.parse(one.firstUnansweredInboundAt!)) < 60 * 1000, "the first unanswered (9 min), not the latest (2 min)");

  const two = context.waitingConversations.get(conversationIds.two)!;
  assert.ok(Math.abs(Date.now() - 20 * MIN - Date.parse(two.firstUnansweredInboundAt!)) < 60 * 1000, "the oldest of the newest 20 messages - the limit is per conversation, newest first");

  const three = context.waitingConversations.get(conversationIds.three)!;
  assert.deepEqual([three.aiEnabled, three.smsOptOut], [false, true]);
});

test("real reads: a paused organization and an explicitly disabled inbound-customer-reply are reflected", async () => {
  await service.from("organizations").update({ automation_paused: true }).eq("id", organizationId);
  await service.from("automation_settings").insert({ organization_id: organizationId, automation_id: "inbound-customer-reply", enabled: false, config: {} });
  try {
    const context = await getDecisionContext(service, organizationId, { attentionItems: [waiting(conversationIds.one)], timeZone: "UTC" });
    assert.equal(context.organizationEligible, false);
    assert.equal(context.inboundReplyEnabled, false);
  } finally {
    await service.from("organizations").update({ automation_paused: false }).eq("id", organizationId);
    await service.from("automation_settings").delete().eq("organization_id", organizationId);
  }
});

test("Phase 2-4a, real reads: pending-estimate contacts whose open SMS conversation has AI off - from the shared open-opportunities read plus one AI-off conversation read", async () => {
  // Pending estimates for contact One (open SMS conversation, AI on) and contact Three (open SMS conversation, AI off).
  const opp = (contactId: string, type: string, key: string) => ({ organization_id: organizationId, type, status: "open", source_entity_type: "lead", source_entity_id: crypto.randomUUID(), contact_id: contactId, title: `Ctx ${key}`, metadata: {} });
  const { error } = await service.from("opportunities").insert([opp(contactIds.One, "pending_estimate", "est-one"), opp(contactIds.Three, "pending_estimate", "est-three")]);
  assert.ifError(error);
  try {
    const context = await getDecisionContext(service, organizationId, { attentionItems: [], timeZone: "UTC" });
    assert.deepEqual([...context.estimateContactAiDisabled], [contactIds.Three]);
  } finally {
    await service.from("opportunities").delete().eq("organization_id", organizationId);
  }
});

test("Phase 2-11 (G4), real reads: with a pending estimate 72h+ old, the latest successful outbound message per contact - outbound only, inbound-only contacts absent", async () => {
  const { error } = await service.from("opportunities").insert([
    { organization_id: organizationId, type: "pending_estimate", status: "open", source_entity_type: "estimate", source_entity_id: crypto.randomUUID(), contact_id: contactIds.One, title: "Ctx old estimate", metadata: { sent_at: new Date(Date.now() - 80 * 60 * MIN).toISOString() } },
  ]);
  assert.ifError(error);
  try {
    const context = await getDecisionContext(service, organizationId, { attentionItems: [], timeZone: "UTC" });
    const latest = context.latestOutboundMsByContact!;
    assert.ok(latest, "the read ran");
    // conv-1 (contact One) has a delivered outbound 30 minutes ago; contact Three only ever sent inbound.
    assert.ok(Math.abs(latest.get(contactIds.One)! - (Date.now() - 30 * MIN)) < 60 * 1000);
    assert.equal(latest.has(contactIds.Three), false);
  } finally {
    await service.from("opportunities").delete().eq("organization_id", organizationId);
  }
});

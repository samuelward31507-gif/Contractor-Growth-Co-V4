/**
 * Phase 3 (W1): against real PostgREST on TEST, with the pending
 * dashboard_conversation_attention_successful_reply.sql applied there, the
 * SQL path and the legacy app path (the default; Agency) classify "waiting on
 * a reply" and "went quiet" identically on the canonical evidence: inbound or
 * sent/delivered outbound. One disposable organization, removed afterwards.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/dashboard/queries.waiting-rule.integration.test.ts
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
if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("lwofqffxagxiqodqvcfr")) throw new Error("This integration test runs against the TEST project only.");

const { createServiceRoleClient }: typeof import("@/lib/supabase/service") = require(path.join(REPO_ROOT, "lib/supabase/service.ts"));
const { getDashboardData }: typeof import("./queries") = require(path.join(REPO_ROOT, "lib/dashboard/queries.ts"));
const { getDashboardConversationAttention }: typeof import("./sql") = require(path.join(REPO_ROOT, "lib/dashboard/sql.ts"));

const service = createServiceRoleClient();
const H = 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
let organizationId = "";
const names = new Map<string, string>();

async function conversation(label: string, messages: [direction: "inbound" | "outbound", status: string, msAgo: number][]) {
  const { data: contact, error: contactError } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "WR", last_name: label, phone: `+1555530${String(names.size).padStart(4, "0")}` }).select("id").single();
  assert.ifError(contactError);
  const { data, error } = await service.from("conversations").insert({ organization_id: organizationId, contact_id: contact!.id, channel: "sms", status: "open", ai_enabled: true, created_at: ago(30 * 24 * H), updated_at: ago(30 * 24 * H) }).select("id").single();
  assert.ifError(error);
  names.set(data!.id, label);
  for (const [direction, status, msAgo] of messages) {
    const { error: messageError } = await service.from("messages").insert({ organization_id: organizationId, conversation_id: data!.id, direction, sender_type: direction === "inbound" ? "customer" : "ai", body: label, status, created_at: ago(msAgo) });
    assert.ifError(messageError);
  }
}

before(async () => {
  const { data, error } = await service.from("organizations").insert({ name: "Waiting Rule Dashboard Test Org (Phase 3)" }).select("id").single();
  assert.ifError(error);
  organizationId = data!.id;
  await conversation("failed", [["inbound", "received", 80 * H], ["outbound", "failed", 79 * H]]); // waiting (old rule: went quiet)
  await conversation("note", [["inbound", "received", 5 * H], ["outbound", "logged", 4 * H]]); // waiting
  await conversation("queued", [["inbound", "received", 6 * H], ["outbound", "queued", 5.9 * H]]); // waiting
  await conversation("undelivered", [["inbound", "received", 7 * H], ["outbound", "undelivered", 6.9 * H]]); // waiting
  await conversation("quiet", [["inbound", "received", 120 * H], ["outbound", "delivered", 110 * H], ["outbound", "failed", 72 * H]]); // went quiet
  await conversation("failedOnly", [["outbound", "failed", 96 * H]]); // neither (old rule: went quiet)
  await conversation("answered", [["inbound", "received", 3 * H], ["outbound", "delivered", 2 * H]]); // neither
});

after(async () => {
  for (const table of ["messages", "conversations", "contacts"]) await service.from(table).delete().eq("organization_id", organizationId);
  await service.from("organizations").delete().eq("id", organizationId);
});

const labelsOf = (items: { id: string }[]) => items.map((item) => names.get(item.id.replace(/^(reply|abandoned)-/, "")) ?? item.id).sort();

test("real reads: the SQL classifies on inbound + successful outbound evidence - failed / logged / queued / undelivered after the customer are waiting; answered-then-failed is went quiet", async () => {
  const sql = await getDashboardConversationAttention(service, organizationId);
  assert.deepEqual(labelsOf(sql.awaitingReply), ["failed", "note", "queued", "undelivered"]);
  assert.deepEqual(labelsOf(sql.abandonedConversations), ["quiet"]);
});

test("real reads: the legacy app path (the default; Agency) agrees with the SQL exactly", async () => {
  const [legacy, sql] = await Promise.all([getDashboardData(service, organizationId), getDashboardConversationAttention(service, organizationId)]);
  assert.deepEqual(labelsOf(legacy.attentionItems.filter((i) => i.kind === "awaiting_reply")), labelsOf(sql.awaitingReply));
  assert.deepEqual(labelsOf(legacy.attentionItems.filter((i) => i.kind === "abandoned_conversation")), labelsOf(sql.abandonedConversations));
});

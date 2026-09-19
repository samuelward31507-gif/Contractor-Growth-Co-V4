/**
 * Integration tests for the messages_provider_message_id_unique index -
 * production-readiness audit finding (HIGH, matches the known "messages
 * INSERT integrity" backlog item). Proves the race-safety guarantee the
 * inbound SMS webhook now relies on (app/api/webhooks/sms/inbound/route.ts's
 * 23505 handling) actually exists at the database level, and stress-tests it
 * under real concurrency the same way the Automation Health service's own
 * dedup guarantee was proven (lib/automation-health/service.integration.test.ts).
 * Against an isolated, fully-cleaned-up test organization on the real
 * Supabase project. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/messaging/messages-idempotency.integration.test.ts
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

const service = createServiceRoleClient();
let organizationId: string;
let conversationId: string;

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Messages Idempotency Integration Test Org" }).select("id").single();
  organizationId = org!.id;

  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "Idempotency", last_name: "Test", phone: "+15555551234" }).select("id").single();

  const { data: conversation } = await service.from("conversations").insert({ organization_id: organizationId, contact_id: contact!.id, channel: "sms", status: "open" }).select("id").single();
  conversationId = conversation!.id;
});

after(async () => {
  await service.from("messages").delete().eq("organization_id", organizationId);
  await service.from("conversations").delete().eq("organization_id", organizationId);
  await service.from("contacts").delete().eq("organization_id", organizationId);
  await service.from("organizations").delete().eq("id", organizationId);
});

function makeMessage(providerMessageId: string) {
  return service.from("messages").insert({
    organization_id: organizationId,
    conversation_id: conversationId,
    direction: "inbound",
    sender_type: "customer",
    body: "test",
    status: "received",
    provider_message_id: providerMessageId,
  });
}

test("two sequential inserts with the same provider_message_id: the second is rejected with 23505", async () => {
  const sid = `SM_IDEMPOTENCY_SEQUENTIAL_${Date.now()}`;
  const first = await makeMessage(sid);
  assert.equal(first.error, null);

  const second = await makeMessage(sid);
  assert.ok(second.error, "a duplicate provider_message_id must be rejected at the database level");
  assert.equal(second.error?.code, "23505");

  const { count } = await service.from("messages").select("id", { count: "exact", head: true }).eq("provider_message_id", sid);
  assert.equal(count, 1);
});

test("25 CONCURRENT inserts with the same provider_message_id (simulating Twilio webhook retries racing) produce exactly ONE stored message row", async () => {
  const sid = `SM_IDEMPOTENCY_CONCURRENT_${Date.now()}`;
  const CONCURRENCY = 25;

  const results = await Promise.all(Array.from({ length: CONCURRENCY }, () => makeMessage(sid)));

  const successes = results.filter((r) => r.error === null);
  const conflicts = results.filter((r) => r.error?.code === "23505");

  assert.equal(successes.length, 1, "exactly one concurrent insert must win");
  assert.equal(conflicts.length, CONCURRENCY - 1, "every other concurrent insert must lose with a 23505 conflict, never silently duplicate");

  const { count } = await service.from("messages").select("id", { count: "exact", head: true }).eq("provider_message_id", sid);
  assert.equal(count, 1, "the database must contain exactly one row for this physical SMS, regardless of how many concurrent webhook deliveries raced to insert it");
});

test("outbound messages (provider_message_id starts NULL, then gets set) are never blocked by the unique index while queued", async () => {
  const { error: firstQueued } = await service.from("messages").insert({
    organization_id: organizationId,
    conversation_id: conversationId,
    direction: "outbound",
    sender_type: "ai",
    body: "queued message 1",
    status: "queued",
  });
  const { error: secondQueued } = await service.from("messages").insert({
    organization_id: organizationId,
    conversation_id: conversationId,
    direction: "outbound",
    sender_type: "ai",
    body: "queued message 2",
    status: "queued",
  });

  assert.equal(firstQueued, null, "multiple NULL provider_message_id rows must remain allowed - the partial index only applies where provider_message_id IS NOT NULL");
  assert.equal(secondQueued, null);
});

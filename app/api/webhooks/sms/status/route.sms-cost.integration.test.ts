/**
 * Phase 5D-4 - focused test for the SMS cost-capture addition to
 * app/api/webhooks/sms/status/route.ts. New file, not an extension of any
 * existing suite (none existed for this route before this phase).
 *
 * Real, unmodified-except-for-this-addition POST(), a real Twilio-signature
 * HMAC (same technique as
 * app/api/webhooks/sms/inbound/route.integration.test.ts), and a
 * deliberately unconfigured TWILIO_ACCOUNT_SID so cost capture's own Twilio
 * fetch always resolves to a typed failure without ever making a real
 * network call (see lib/automation/sms-fetch.ts). This suite verifies WHEN
 * cost capture is attempted (only on a genuine terminal transition) and
 * that it never affects the existing delivery-status update itself.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/api/webhooks/sms/status/route.sms-cost.integration.test.ts"
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
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

if (!process.env.TWILIO_AUTH_TOKEN) process.env.TWILIO_AUTH_TOKEN = "test-auth-token-for-sms-cost-status-tests";
// Deliberately never set TWILIO_ACCOUNT_SID - this suite must never make a
// real Twilio network call.
delete process.env.TWILIO_ACCOUNT_SID;

const { createServiceRoleClient }: typeof import("@/lib/supabase/service") = require(path.join(REPO_ROOT, "lib/supabase/service.ts"));
const { NextRequest } = require("next/server");
const { POST }: typeof import("./route") = require(path.join(REPO_ROOT, "app/api/webhooks/sms/status/route.ts"));

const service = createServiceRoleClient();
const WEBHOOK_URL = "http://localhost/api/webhooks/sms/status";

function twilioSignature(url: string, params: Record<string, string>, authToken: string): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}

async function sendStatus(messageSid: string, messageStatus: string) {
  const params: Record<string, string> = { MessageSid: messageSid, MessageStatus: messageStatus };
  const signature = twilioSignature(WEBHOOK_URL, params, process.env.TWILIO_AUTH_TOKEN!);
  const request = new NextRequest(WEBHOOK_URL, {
    method: "POST",
    headers: { "x-twilio-signature": signature },
    body: new URLSearchParams(params),
  });
  return POST(request);
}

let organizationId: string;
let conversationId: string;

async function insertOutboundMessage(providerMessageId: string, status: string): Promise<string> {
  const { data } = await service
    .from("messages")
    .insert({ organization_id: organizationId, conversation_id: conversationId, direction: "outbound", sender_type: "system", body: "test", status, provider_message_id: providerMessageId })
    .select("id")
    .single();
  return data!.id as string;
}

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "SMS Cost Status Test Org" }).select("id").single();
  organizationId = org!.id;
  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, phone: "+15550002222" }).select("id").single();
  const { data: conversation } = await service.from("conversations").insert({ organization_id: organizationId, contact_id: contact!.id, channel: "sms", status: "open" }).select("id").single();
  conversationId = conversation!.id;
});

after(async () => {
  await service.from("sms_cost_events").delete().eq("organization_id", organizationId);
  await service.from("messages").delete().eq("organization_id", organizationId);
  await service.from("audit_log").delete().eq("organization_id", organizationId);
  await service.from("conversations").delete().eq("organization_id", organizationId);
  await service.from("contacts").delete().eq("organization_id", organizationId);
  await service.from("organizations").delete().eq("id", organizationId);
});

test("1. reaching 'delivered' still updates messages.status exactly as before, and the webhook still returns 200 even though cost capture cannot resolve a price", async () => {
  const sid = `SM-status-cost-${Date.now()}-1`;
  await insertOutboundMessage(sid, "sent");

  const response = await sendStatus(sid, "delivered");
  assert.equal(response.status, 200);

  const { data: message } = await service.from("messages").select("status").eq("provider_message_id", sid).single();
  assert.equal(message?.status, "delivered", "the existing delivery-status update itself must be completely unaffected");

  const { count } = await service.from("sms_cost_events").select("id", { count: "exact" }).eq("provider_message_id", sid);
  assert.equal(count, 0, "no sms_cost_events row must ever be created when the provider fetch cannot succeed - never a fabricated $0");
});

test("2. cost capture is only attempted on a genuine terminal transition (delivered/failed/undelivered), never on a non-terminal one (e.g. queued -> sent)", async () => {
  const sid = `SM-status-cost-${Date.now()}-2`;
  await insertOutboundMessage(sid, "queued");

  const originalError = console.error;
  const logs: unknown[][] = [];
  console.error = (...args: unknown[]) => logs.push(args);

  try {
    await sendStatus(sid, "sent");
    const costLogAfterNonTerminal = logs.find((entry) => typeof entry[0] === "string" && entry[0].includes("[sms][status] failed to capture SMS cost"));
    assert.equal(costLogAfterNonTerminal, undefined, "a non-terminal transition (queued -> sent, rank 1) must never attempt cost capture");

    logs.length = 0;
    await sendStatus(sid, "delivered");
    const costLogAfterTerminal = logs.find((entry) => typeof entry[0] === "string" && entry[0].includes("[sms][status] failed to capture SMS cost"));
    assert.ok(costLogAfterTerminal, "reaching a genuine terminal status must attempt cost capture");
  } finally {
    console.error = originalError;
  }
});

test("3. a failed outbound message still gets a real cost-capture attempt - status is never used as a shortcut to skip it", async () => {
  const sid = `SM-status-cost-${Date.now()}-3`;
  await insertOutboundMessage(sid, "sent");

  const originalError = console.error;
  const logs: unknown[][] = [];
  console.error = (...args: unknown[]) => logs.push(args);

  try {
    await sendStatus(sid, "failed");
    const costLog = logs.find((entry) => typeof entry[0] === "string" && entry[0].includes("[sms][status] failed to capture SMS cost"));
    assert.ok(costLog, "a failed message must still get a real cost-capture attempt, exactly like a delivered one");
  } finally {
    console.error = originalError;
  }

  const { data: message } = await service.from("messages").select("status").eq("provider_message_id", sid).single();
  assert.equal(message?.status, "failed");
});

test("4. an undelivered outbound message still gets a real cost-capture attempt", async () => {
  const sid = `SM-status-cost-${Date.now()}-4`;
  await insertOutboundMessage(sid, "sent");

  const originalError = console.error;
  const logs: unknown[][] = [];
  console.error = (...args: unknown[]) => logs.push(args);

  try {
    await sendStatus(sid, "undelivered");
    const costLog = logs.find((entry) => typeof entry[0] === "string" && entry[0].includes("[sms][status] failed to capture SMS cost"));
    assert.ok(costLog, "an undelivered message must still get a real cost-capture attempt");
  } finally {
    console.error = originalError;
  }
});

test("5. a duplicate terminal webhook (Twilio redelivery of an already-applied status) never attempts a second cost capture - existing idempotency unchanged", async () => {
  const sid = `SM-status-cost-${Date.now()}-5`;
  await insertOutboundMessage(sid, "sent");
  await sendStatus(sid, "delivered");

  const originalError = console.error;
  const logs: unknown[][] = [];
  console.error = (...args: unknown[]) => logs.push(args);

  try {
    const response = await sendStatus(sid, "delivered");
    assert.equal(response.status, 200);
    const costLog = logs.find((entry) => typeof entry[0] === "string" && entry[0].includes("[sms][status] failed to capture SMS cost"));
    assert.equal(costLog, undefined, "a duplicate delivery of an already-applied terminal status must resolve to 'no_change'/'ignored_downgrade' and never re-attempt cost capture");
  } finally {
    console.error = originalError;
  }
});

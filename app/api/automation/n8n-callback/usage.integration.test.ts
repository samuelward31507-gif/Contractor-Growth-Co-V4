/**
 * Integration tests for Growth System Completion Pass 2, Part 4: AI token
 * usage capture in app/api/automation/n8n-callback/route.ts. Calls POST()
 * directly with a real, constructed NextRequest - see
 * booking.integration.test.ts's own established precedent for why this
 * works for this specific route (no next/headers dependency).
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test app/api/automation/n8n-callback/usage.integration.test.ts
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
const { findOrCreateOpenConversation }: typeof import("@/lib/conversations/queries") = require(path.join(REPO_ROOT, "lib/conversations/queries.ts"));
const { NextRequest } = require("next/server");
const { POST }: typeof import("./route") = require(path.join(REPO_ROOT, "app/api/automation/n8n-callback/route.ts"));

const service = createServiceRoleClient();
const SECRET = process.env.N8N_WEBHOOK_SECRET!;
const CALLBACK_URL = "http://localhost/api/automation/n8n-callback";

function callback(body: unknown) {
  return new NextRequest(CALLBACK_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-trackpr-webhook-secret": SECRET },
    body: JSON.stringify(body),
  });
}

let organizationId: string;
let contactId: string;

async function makeExecution() {
  const conversation = await findOrCreateOpenConversation(service, organizationId, contactId, "sms");
  const { data: event } = await service
    .from("automation_events")
    .insert({ organization_id: organizationId, event_type: "customer.message.received", entity_type: "conversation", entity_id: conversation!.id, status: "processing", payload: { contact_id: contactId, conversation_id: conversation!.id, lead_id: null } })
    .select("id")
    .single();
  const { data: execution } = await service
    .from("workflow_executions")
    .insert({ organization_id: organizationId, automation_event_id: event!.id, workflow_name: "customer_reply_followup", status: "running", attempt: 1 })
    .select("id")
    .single();
  return { executionId: execution!.id as string, eventId: event!.id as string };
}

function baseAiResult(overrides: Record<string, unknown> = {}) {
  return {
    should_send: false,
    response_message: null,
    qualification_status: "qualified",
    missing_information: [],
    urgency: "normal",
    needs_human: false,
    model: "test-model",
    intent: "general",
    summary: "test summary",
    booking_intent: null,
    usage: null,
    ...overrides,
  };
}

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "n8n Usage Callback Test Org", payment_status: "active", automation_mode: "live" }).select("id").single();
  organizationId = org!.id;
  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, phone: "+15555550501" }).select("id").single();
  contactId = contact!.id;
});

after(async () => {
  await service.from("ai_interactions").delete().eq("organization_id", organizationId);
  await service.from("workflow_executions").delete().eq("organization_id", organizationId);
  await service.from("automation_events").delete().eq("organization_id", organizationId);
  await service.from("conversations").delete().eq("organization_id", organizationId);
  await service.from("contacts").delete().eq("organization_id", organizationId);
  await service.from("organizations").delete().eq("id", organizationId);
});

test("1. a real usage object is captured into ai_interactions.tokens_used (the total)", async () => {
  const { executionId, eventId } = await makeExecution();
  await POST(
    callback({
      execution_id: executionId,
      event_id: eventId,
      organization_id: organizationId,
      ai_result: baseAiResult({ usage: { input_tokens: 120, output_tokens: 80, total_tokens: 200 } }),
    }),
  );

  const { data: interaction } = await service.from("ai_interactions").select("tokens_used, output").eq("workflow_execution_id", executionId).single();
  assert.equal(interaction?.tokens_used, 200);
  const output = interaction?.output as { usage?: { input_tokens: number; output_tokens: number; total_tokens: number } };
  assert.equal(output.usage?.input_tokens, 120);
  assert.equal(output.usage?.output_tokens, 80);
});

test("2. a null usage (provider metadata unavailable) stores tokens_used as null - never invented as 0", async () => {
  const { executionId, eventId } = await makeExecution();
  await POST(callback({ execution_id: executionId, event_id: eventId, organization_id: organizationId, ai_result: baseAiResult({ usage: null }) }));

  const { data: interaction } = await service.from("ai_interactions").select("tokens_used").eq("workflow_execution_id", executionId).single();
  assert.equal(interaction?.tokens_used, null);
});

test("3. usage entirely absent from the callback body (omitted field, not even present) behaves exactly like usage: null", async () => {
  const { executionId, eventId } = await makeExecution();
  const body = baseAiResult();
  delete (body as Record<string, unknown>).usage;
  await POST(callback({ execution_id: executionId, event_id: eventId, organization_id: organizationId, ai_result: body }));

  const { data: interaction } = await service.from("ai_interactions").select("tokens_used").eq("workflow_execution_id", executionId).single();
  assert.equal(interaction?.tokens_used, null);
});

test("4. partial usage (only total_tokens reported, input/output unknown) is accepted and stored correctly", async () => {
  const { executionId, eventId } = await makeExecution();
  await POST(callback({ execution_id: executionId, event_id: eventId, organization_id: organizationId, ai_result: baseAiResult({ usage: { input_tokens: null, output_tokens: null, total_tokens: 50 } }) }));

  const { data: interaction } = await service.from("ai_interactions").select("tokens_used").eq("workflow_execution_id", executionId).single();
  assert.equal(interaction?.tokens_used, 50);
});

test("5. an invalid usage shape (negative tokens) is rejected with a 400, and nothing is recorded", async () => {
  const { executionId, eventId } = await makeExecution();
  const response = await POST(callback({ execution_id: executionId, event_id: eventId, organization_id: organizationId, ai_result: baseAiResult({ usage: { input_tokens: -5, output_tokens: 0, total_tokens: 0 } }) }));
  assert.equal(response.status, 400);

  const { data: interaction } = await service.from("ai_interactions").select("id").eq("workflow_execution_id", executionId).maybeSingle();
  assert.equal(interaction, null);
});

test("6. an invalid usage shape (non-integer tokens) is rejected with a 400", async () => {
  const { executionId, eventId } = await makeExecution();
  const response = await POST(callback({ execution_id: executionId, event_id: eventId, organization_id: organizationId, ai_result: baseAiResult({ usage: { input_tokens: 1.5, output_tokens: 0, total_tokens: 1.5 } }) }));
  assert.equal(response.status, 400);
});

test("7. no API key, credential, or secret is ever present in the stored ai_interactions.output", async () => {
  const { executionId, eventId } = await makeExecution();
  await POST(callback({ execution_id: executionId, event_id: eventId, organization_id: organizationId, ai_result: baseAiResult({ usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } }) }));

  const { data: interaction } = await service.from("ai_interactions").select("output").eq("workflow_execution_id", executionId).single();
  const raw = JSON.stringify(interaction?.output ?? {});
  assert.doesNotMatch(raw, /sk-|api[_-]?key|Bearer |ANTHROPIC_API_KEY/i);
});

/**
 * Integration tests for lib/costs/sms-cost-events.ts and sms_cost_events'
 * own DB-level constraints - real database, real INSERT ... ON CONFLICT DO
 * NOTHING idempotency, real FK/RESTRICT behavior. Never calls the real
 * Twilio API (forbidden for this phase's tests) - every test injects a
 * deterministic fetchFn, exactly mirroring lib/costs/ai-cost-events.
 * integration.test.ts's own "test the DB, not the live provider" split.
 *
 * REQUIRES supabase/migrations/20260928000000_sms_cost_intelligence.sql to
 * already be applied.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/costs/sms-cost-events.integration.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
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
const { recordSmsCostEventForMessage }: typeof import("./sms-cost-events") = require(path.join(REPO_ROOT, "lib/costs/sms-cost-events.ts"));

const service = createServiceRoleClient();

function fakeFetchFn(overrides: Partial<{ price: string | null; priceUnit: string | null; status: string }> = {}) {
  return async () => ({
    ok: true as const,
    message: {
      price: overrides.price ?? "-0.0075",
      priceUnit: overrides.priceUnit ?? "usd",
      numSegments: "1",
      numMedia: "0",
      status: overrides.status ?? "delivered",
      dateSent: new Date("2026-06-01T00:00:00Z"),
      dateCreated: new Date("2026-06-01T00:00:00Z"),
      direction: "outbound-api",
    },
  });
}

let organizationId: string;
let conversationId: string;
let messageId: string;

async function insertDisposableMessage(orgId: string, convId: string, sid: string) {
  const { data } = await service
    .from("messages")
    .insert({ organization_id: orgId, conversation_id: convId, direction: "outbound", sender_type: "system", body: "test", status: "delivered", provider_message_id: sid })
    .select("id")
    .single();
  return data!.id as string;
}

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "SMS Cost Events Test Org" }).select("id").single();
  organizationId = org!.id;

  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, phone: "+15550001111" }).select("id").single();
  const { data: conversation } = await service.from("conversations").insert({ organization_id: organizationId, contact_id: contact!.id, channel: "sms", status: "open" }).select("id").single();
  conversationId = conversation!.id;

  messageId = await insertDisposableMessage(organizationId, conversationId, `SM_test_${Date.now()}`);
});

after(async () => {
  await service.from("sms_cost_events").delete().eq("organization_id", organizationId);
  await service.from("messages").delete().eq("organization_id", organizationId);
  await service.from("conversations").delete().eq("organization_id", organizationId);
  await service.from("contacts").delete().eq("organization_id", organizationId);
  await service.from("organizations").delete().eq("id", organizationId);
});

test("1. a normal insertion creates exactly one sms_cost_events row with the correct cost", async () => {
  const result = await recordSmsCostEventForMessage(service, {
    organizationId,
    sourceMessageId: messageId,
    providerMessageId: "SM_test_normal",
    direction: "outbound",
    fetchFn: fakeFetchFn(),
  });
  assert.equal(result.outcome, "known");

  const { data, count } = await service.from("sms_cost_events").select("*", { count: "exact" }).eq("source_message_id", messageId);
  assert.equal(count, 1);
  assert.ok(Math.abs((data![0].price as number) - 0.0075) < 1e-9);
  assert.equal(data![0].currency, "usd");
});

test("2. repeated processing of the SAME message never creates a second row (idempotency)", async () => {
  const second = await recordSmsCostEventForMessage(service, {
    organizationId,
    sourceMessageId: messageId,
    providerMessageId: "SM_test_normal",
    direction: "outbound",
    fetchFn: fakeFetchFn(),
  });
  assert.equal(second.outcome, "known", "a replay must still report success, never an error, even though no new row is written");

  const { count } = await service.from("sms_cost_events").select("id", { count: "exact" }).eq("source_message_id", messageId);
  assert.equal(count, 1, "exactly one cost event must exist per source message, regardless of replay count");
});

test("3. concurrent processing of the same message still resolves to exactly one row", async () => {
  const concurrentMessageId = await insertDisposableMessage(organizationId, conversationId, `SM_test_concurrent_${Date.now()}`);

  const input = {
    organizationId,
    sourceMessageId: concurrentMessageId,
    providerMessageId: "SM_test_concurrent",
    direction: "outbound" as const,
    fetchFn: fakeFetchFn(),
  };
  const [a, b, c] = await Promise.all([
    recordSmsCostEventForMessage(service, input),
    recordSmsCostEventForMessage(service, input),
    recordSmsCostEventForMessage(service, input),
  ]);
  for (const result of [a, b, c]) assert.equal(result.outcome, "known");

  const { count } = await service.from("sms_cost_events").select("id", { count: "exact" }).eq("source_message_id", concurrentMessageId);
  assert.equal(count, 1, "three genuinely concurrent calls for the same message must still resolve to exactly one row");
});

test("4. source_message_id has a real FK to messages - a non-existent message id is rejected at the database level", async () => {
  const result = await recordSmsCostEventForMessage(service, {
    organizationId,
    sourceMessageId: "00000000-0000-0000-0000-000000000000",
    providerMessageId: "SM_test_fk",
    direction: "outbound",
    fetchFn: fakeFetchFn(),
  });
  assert.equal(result.outcome, "error", "an FK violation must surface as a real error, never a silently-accepted row");
});

test("5. deleting a message with an existing cost event is rejected (ON DELETE RESTRICT, not CASCADE)", async () => {
  const { error } = await service.from("messages").delete().eq("id", messageId);
  assert.ok(error, "a message that already produced a real historical cost event must not be deletable out from under it");
});

test("6. a failed/undelivered message still records a real known cost when Twilio reports one - status never gates the cost decision", async () => {
  const failedMessageId = await insertDisposableMessage(organizationId, conversationId, `SM_test_failed_${Date.now()}`);
  const result = await recordSmsCostEventForMessage(service, {
    organizationId,
    sourceMessageId: failedMessageId,
    providerMessageId: "SM_test_failed",
    direction: "outbound",
    fetchFn: fakeFetchFn({ status: "undelivered" }),
  });
  assert.equal(result.outcome, "known");

  const { data } = await service.from("sms_cost_events").select("provider_status, price").eq("source_message_id", failedMessageId).single();
  assert.equal(data?.provider_status, "undelivered");
  assert.ok(Math.abs((data?.price as number) - 0.0075) < 1e-9);
});

test("7. RLS: a normal organization member cannot read sms_cost_events directly via PostgREST", async () => {
  const stamp = Date.now();
  const { data: userData } = await service.auth.admin.createUser({ email: `sms-cost-rls-test-${stamp}@example.com`, password: "Rls-Test-Aa1!", email_confirm: true });
  const userId = userData!.user!.id;
  await service.from("organization_members").insert({ organization_id: organizationId, user_id: userId, role: "owner" });

  try {
    const anon = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
    await anon.auth.signInWithPassword({ email: `sms-cost-rls-test-${stamp}@example.com`, password: "Rls-Test-Aa1!" });

    const { data, error } = await anon.from("sms_cost_events").select("*").eq("organization_id", organizationId);
    assert.equal(error, null);
    assert.equal(data?.length ?? 0, 0, "a normal organization member must never see any sms_cost_events row, even for their own organization");
  } finally {
    await service.from("organization_members").delete().eq("organization_id", organizationId).eq("user_id", userId);
    await service.auth.admin.deleteUser(userId);
  }
});

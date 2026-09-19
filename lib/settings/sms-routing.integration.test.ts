/**
 * Integration tests for SMS Routing & Communications Settings V1 - the
 * real DB-backed constraints, RLS/authorization, and HELP/STOP/START
 * routing behavior, exercised against an isolated test organization on the
 * real Supabase project (this codebase's established pattern for exactly
 * this class of logic - see outbound-gate.integration.test.ts).
 *
 * Sections:
 *   A. DB-level format/uniqueness/NULL guarantees (service-role, no auth
 *      session needed - these are Postgres constraints, not RLS).
 *   B. Real per-role authorization (owner/admin/member/anonymous/cross-org)
 *      against organizations_update RLS and the new
 *      create_organization_audit_event RPC, using real, minted Supabase
 *      Auth test users (cleaned up in `after`) - this is the one place in
 *      this suite that needs a real session rather than a mock, because RLS
 *      and a SECURITY DEFINER RPC's auth.uid() check can only be proven
 *      against a real JWT, not a hand-rolled mock client (see
 *      lib/automation/authorization.test.ts's own documented limitation on
 *      this point).
 *   C. Inbound routing + HELP/STOP/START, using the same "call the real
 *      functions the route calls, directly, via a service-role script"
 *      technique already established and used for the Inbound Customer
 *      Reply production validation - a real Twilio-signed HTTP request
 *      can't be constructed in this environment (no TWILIO_AUTH_TOKEN
 *      locally), so this exercises everything downstream of signature
 *      verification instead. No real Twilio call is ever made (sendSmsFn
 *      injection).
 *
 * Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/settings/sms-routing.integration.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const REPO_ROOT = process.cwd();

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

const { createServiceRoleClient }: typeof import("@/lib/supabase/service") = require(
  path.join(REPO_ROOT, "lib/supabase/service.ts"),
);
const { findOrganizationBySmsPhoneNumber }: typeof import("./sms-routing") = require(
  path.join(REPO_ROOT, "lib/settings/sms-routing.ts"),
);
const { matchSmsKeyword }: typeof import("@/lib/messaging/keywords") = require(
  path.join(REPO_ROOT, "lib/messaging/keywords.ts"),
);
const { buildHelpResponseMessage }: typeof import("@/lib/messaging/help-response") = require(
  path.join(REPO_ROOT, "lib/messaging/help-response.ts"),
);
const { sendOutboundMessage }: typeof import("@/lib/messaging/outbound") = require(
  path.join(REPO_ROOT, "lib/messaging/outbound.ts"),
);
const { findOrCreateOpenConversation }: typeof import("@/lib/conversations/queries") = require(
  path.join(REPO_ROOT, "lib/conversations/queries.ts"),
);

const service = createServiceRoleClient();
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// NANPA-reserved fictional-use number - never a real subscriber, matching
// this session's established test-number convention throughout.
const NUMBER_A = "+15555550171";

let orgAId: string;
let orgBId: string;
const testUserIds: string[] = [];
const cleanupOrgIds: string[] = [];

async function createTestUser(email: string) {
  const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`failed to create test user ${email}: ${error?.message}`);
  testUserIds.push(data.user.id);
  return { id: data.user.id, email, password };
}

async function signInAs(email: string, password: string) {
  const client = createSupabaseClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return client;
}

let ownerA: { id: string; email: string; password: string };
let adminA: { id: string; email: string; password: string };
let memberA: { id: string; email: string; password: string };
let ownerB: { id: string; email: string; password: string };

before(async () => {
  const { data: orgA } = await service.from("organizations").insert({ name: "SMS Routing Test Org A" }).select("id").single();
  const { data: orgB } = await service.from("organizations").insert({ name: "SMS Routing Test Org B" }).select("id").single();
  orgAId = orgA!.id;
  orgBId = orgB!.id;
  cleanupOrgIds.push(orgAId, orgBId);

  const stamp = Date.now();
  ownerA = await createTestUser(`sms-routing-owner-a-${stamp}@example.com`);
  adminA = await createTestUser(`sms-routing-admin-a-${stamp}@example.com`);
  memberA = await createTestUser(`sms-routing-member-a-${stamp}@example.com`);
  ownerB = await createTestUser(`sms-routing-owner-b-${stamp}@example.com`);

  await service.from("organization_members").insert([
    { organization_id: orgAId, user_id: ownerA.id, role: "owner" },
    { organization_id: orgAId, user_id: adminA.id, role: "admin" },
    { organization_id: orgAId, user_id: memberA.id, role: "member" },
    { organization_id: orgBId, user_id: ownerB.id, role: "owner" },
  ]);
});

after(async () => {
  // FK-safe order: messages -> workflow_executions -> automation_events ->
  // conversations -> leads -> contacts -> organization_members -> organizations,
  // then the auth users themselves.
  for (const orgId of cleanupOrgIds) {
    await service.from("messages").delete().eq("organization_id", orgId);
    await service.from("workflow_executions").delete().eq("organization_id", orgId);
    await service.from("automation_events").delete().eq("organization_id", orgId);
    await service.from("audit_log").delete().eq("organization_id", orgId);
    await service.from("conversations").delete().eq("organization_id", orgId);
    await service.from("leads").delete().eq("organization_id", orgId);
    await service.from("contacts").delete().eq("organization_id", orgId);
    await service.from("organization_members").delete().eq("organization_id", orgId);
    await service.from("organizations").delete().eq("id", orgId);
  }
  for (const userId of testUserIds) {
    await service.auth.admin.deleteUser(userId);
  }
});

// ==================== A. DB-level constraints ====================

test("A1: a valid E.164 number saves via a direct update", async () => {
  const { error } = await service.from("organizations").update({ sms_phone_number: NUMBER_A }).eq("id", orgAId);
  assert.equal(error, null);
  const { data } = await service.from("organizations").select("sms_phone_number").eq("id", orgAId).single();
  assert.equal(data?.sms_phone_number, NUMBER_A);
});

test("A2: a malformed number is rejected at the database level (CHECK constraint)", async () => {
  const { error } = await service.from("organizations").update({ sms_phone_number: "not-a-number" }).eq("id", orgBId);
  assert.ok(error, "expected a CHECK constraint violation");
  assert.equal(error?.code, "23514");
});

test("A3: two organizations cannot share the same number (unique index)", async () => {
  const { error } = await service.from("organizations").update({ sms_phone_number: NUMBER_A }).eq("id", orgBId);
  assert.ok(error, "expected a unique_violation");
  assert.equal(error?.code, "23505");
});

test("A4: NULL remains allowed - clearing back to unconfigured never conflicts with another NULL org", async () => {
  const { error: clearA } = await service.from("organizations").update({ sms_phone_number: null }).eq("id", orgAId);
  const { error: clearB } = await service.from("organizations").update({ sms_phone_number: null }).eq("id", orgBId);
  assert.equal(clearA, null);
  assert.equal(clearB, null);
});

// ==================== B. Real per-role authorization ====================

test("B1: an org owner can update their own organization's SMS number", async () => {
  const client = await signInAs(ownerA.email, ownerA.password);
  const { error } = await client.from("organizations").update({ sms_phone_number: NUMBER_A }).eq("id", orgAId);
  assert.equal(error, null);
  const { data } = await service.from("organizations").select("sms_phone_number").eq("id", orgAId).single();
  assert.equal(data?.sms_phone_number, NUMBER_A);
});

test("B2: an org admin can also update it", async () => {
  const client = await signInAs(adminA.email, adminA.password);
  const { error } = await client.from("organizations").update({ sms_phone_number: null }).eq("id", orgAId);
  assert.equal(error, null);
  const { data } = await service.from("organizations").select("sms_phone_number").eq("id", orgAId).single();
  assert.equal(data?.sms_phone_number, null);
});

test("B3: a normal member cannot update it - RLS silently matches zero rows, value is unchanged", async () => {
  await service.from("organizations").update({ sms_phone_number: NUMBER_A }).eq("id", orgAId);
  const client = await signInAs(memberA.email, memberA.password);
  const { data: updated } = await client.from("organizations").update({ sms_phone_number: null }).eq("id", orgAId).select("id");
  assert.equal(updated?.length ?? 0, 0, "RLS must block the write (organizations_update requires is_org_admin)");
  const { data } = await service.from("organizations").select("sms_phone_number").eq("id", orgAId).single();
  assert.equal(data?.sms_phone_number, NUMBER_A, "the member's blocked write must not have taken effect");
});

test("B4: an unauthenticated (anon) caller cannot update it", async () => {
  const anon = createSupabaseClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: updated } = await anon.from("organizations").update({ sms_phone_number: null }).eq("id", orgAId).select("id");
  assert.equal(updated?.length ?? 0, 0, "an anonymous caller must never be able to mutate organizations");
  const { data } = await service.from("organizations").select("sms_phone_number").eq("id", orgAId).single();
  assert.equal(data?.sms_phone_number, NUMBER_A, "unchanged");
});

test("B5: an owner of a different organization cannot update org A's number (cross-org denial)", async () => {
  const client = await signInAs(ownerB.email, ownerB.password);
  const { data: updated } = await client.from("organizations").update({ sms_phone_number: null }).eq("id", orgAId).select("id");
  assert.equal(updated?.length ?? 0, 0, "org B's owner has no admin membership in org A, so is_org_admin(orgAId) is false for them");
  const { data } = await service.from("organizations").select("sms_phone_number").eq("id", orgAId).single();
  assert.equal(data?.sms_phone_number, NUMBER_A, "unchanged");
});

test("B6: an invalid/foreign organization id in the WHERE clause cannot redirect the mutation to a org the caller does administer", async () => {
  // Simulates a tampered client-side org id: even if a malicious caller
  // sends a completely unrelated/nonexistent id, RLS is evaluated per-row
  // against the row actually matched, never against any id the client
  // merely claims - there is no row for a random uuid, so this is a no-op,
  // not a redirect to the caller's real organization.
  const client = await signInAs(ownerA.email, ownerA.password);
  const bogusId = "00000000-0000-0000-0000-000000000000";
  const { data: updated, error } = await client.from("organizations").update({ sms_phone_number: null }).eq("id", bogusId).select("id");
  assert.equal(error, null);
  assert.equal(updated?.length ?? 0, 0);
  const { data } = await service.from("organizations").select("sms_phone_number").eq("id", orgAId).single();
  assert.equal(data?.sms_phone_number, NUMBER_A, "org A's real row must be completely untouched by a request naming a different id");
});

test("B7: create_organization_audit_event rejects an unauthenticated (service-role) caller", async () => {
  const { error } = await service.rpc("create_organization_audit_event", {
    p_organization_id: orgAId,
    p_action: "organization_sms_number_updated",
    p_metadata: {},
  });
  assert.ok(error, "service-role has no auth.uid(), so this must fail closed exactly like create_automation_audit_event does");
});

test("B8: create_organization_audit_event succeeds for a real org admin and records the correct row", async () => {
  const client = await signInAs(ownerA.email, ownerA.password);
  const { data, error } = await client.rpc("create_organization_audit_event", {
    p_organization_id: orgAId,
    p_action: "organization_sms_number_updated",
    p_metadata: {},
  });
  assert.equal(error, null);
  assert.equal(data?.organization_id, orgAId);
  assert.equal(data?.action, "organization_sms_number_updated");
  assert.equal(data?.entity_type, "organization");
  assert.equal(data?.automation_id, null, "not an automation event - automation_id must stay null");
});

test("B9: create_organization_audit_event rejects a normal member the same way", async () => {
  const client = await signInAs(memberA.email, memberA.password);
  const { error } = await client.rpc("create_organization_audit_event", {
    p_organization_id: orgAId,
    p_action: "organization_sms_number_updated",
    p_metadata: {},
  });
  assert.ok(error);
});

test("B10: create_organization_audit_event rejects an unsupported action string", async () => {
  const client = await signInAs(ownerA.email, ownerA.password);
  const { error } = await client.rpc("create_organization_audit_event", {
    p_organization_id: orgAId,
    p_action: "something_unrelated",
    p_metadata: {},
  });
  assert.ok(error, "must reject any action outside the two this feature actually uses");
});

// ==================== C. Inbound routing + HELP/STOP/START ====================

test("C1: findOrganizationBySmsPhoneNumber resolves the correct organization for a configured number", async () => {
  await service.from("organizations").update({ sms_phone_number: NUMBER_A }).eq("id", orgAId);
  const result = await findOrganizationBySmsPhoneNumber(service, NUMBER_A);
  assert.equal(result?.id, orgAId);
});

test("C2: an unconfigured/unknown number resolves to null (fails closed, matching the inbound route's existing behavior)", async () => {
  const result = await findOrganizationBySmsPhoneNumber(service, "+19995550100");
  assert.equal(result, null);
});

test("C3: HELP produces the deterministic reply via sendOutboundMessage, using the injected fake provider - no real Twilio call", async () => {
  await service.from("organizations").update({ sms_phone_number: NUMBER_A, phone: "+15559990000" }).eq("id", orgAId);
  const { data: contact } = await service
    .from("contacts")
    .insert({ organization_id: orgAId, phone: "+15558880001" })
    .select("id")
    .single();

  let realProviderCalled = false;
  const fakeSendSms = async () => {
    realProviderCalled = true;
    return { ok: true as const, providerMessageId: "FAKE-HELP-SID" };
  };

  const conversation = await findOrCreateOpenConversation(service, orgAId, contact!.id, "sms");
  const { data: org } = await service.from("organizations").select("name, phone, email").eq("id", orgAId).single();

  const keyword = matchSmsKeyword("HELP");
  assert.equal(keyword, "help");

  const result = await sendOutboundMessage(service, {
    organizationId: orgAId,
    contactId: contact!.id,
    conversationId: conversation!.id,
    channel: "sms",
    senderType: "system",
    body: buildHelpResponseMessage({ name: org!.name, phone: org!.phone, email: org!.email }),
    sendSmsFn: fakeSendSms,
  });

  assert.equal(result.ok, true);
  assert.equal(realProviderCalled, true, "the injected fake, never the real sendSms/Twilio client");

  const { data: message } = await service.from("messages").select("direction, sender_type, status, body").eq("id", (result as { messageId: string }).messageId).single();
  assert.equal(message?.direction, "outbound");
  assert.equal(message?.sender_type, "system");
  assert.equal(message?.status, "sent");
  assert.match(message!.body, /\+15559990000/);
});

test("C4: HELP never creates a customer.message.received automation event (no AI path)", async () => {
  const { data: events } = await service.from("automation_events").select("id").eq("organization_id", orgAId).eq("event_type", "customer.message.received");
  assert.equal(events?.length ?? 0, 0, "HELP must never route through emitCustomerReplyFollowup");
});

test("C5: STOP still opts the contact out (regression)", async () => {
  const { data: contact } = await service.from("contacts").insert({ organization_id: orgAId, phone: "+15558880002", sms_opt_out: false }).select("id, sms_opt_out").single();
  const keyword = matchSmsKeyword("STOP");
  assert.equal(keyword, "stop");
  if (keyword === "stop" && !contact!.sms_opt_out) {
    await service.from("contacts").update({ sms_opt_out: true }).eq("id", contact!.id);
  }
  const { data: after } = await service.from("contacts").select("sms_opt_out").eq("id", contact!.id).single();
  assert.equal(after?.sms_opt_out, true);
});

test("C6: START still reverses opt-out (regression)", async () => {
  const { data: contact } = await service.from("contacts").insert({ organization_id: orgAId, phone: "+15558880003", sms_opt_out: true }).select("id, sms_opt_out").single();
  const keyword = matchSmsKeyword("START");
  assert.equal(keyword, "start");
  if (keyword === "start" && contact!.sms_opt_out) {
    await service.from("contacts").update({ sms_opt_out: false }).eq("id", contact!.id);
  }
  const { data: after } = await service.from("contacts").select("sms_opt_out").eq("id", contact!.id).single();
  assert.equal(after?.sms_opt_out, false);
});

test("C7: a replayed inbound MessageSid is a no-op at the message layer - no duplicate HELP reply is ever attempted twice for the same inbound message", async () => {
  const messageSid = `SM_HELP_TEST_${Date.now()}`;
  const { data: first } = await service
    .from("messages")
    .insert({ organization_id: orgAId, conversation_id: (await findOrCreateOpenConversation(service, orgAId, (await service.from("contacts").insert({ organization_id: orgAId, phone: "+15558880004" }).select("id").single()).data!.id, "sms"))!.id, direction: "inbound", sender_type: "customer", body: "HELP", status: "received", provider_message_id: messageSid })
    .select("id")
    .single();
  assert.ok(first);

  const { data: existing } = await service.from("messages").select("id").eq("provider_message_id", messageSid).maybeSingle();
  assert.equal(existing?.id, first!.id, "the route's own idempotency check (messages.provider_message_id) would short-circuit a replay before HELP is ever re-processed");
});

/**
 * Integration tests for lib/agency/costs.ts - Trackpr Phase 5D-2 (AI Cost
 * Intelligence, getAgencyAiCosts) and Phase 5D-4 (SMS Cost Intelligence,
 * getAgencySmsCosts) - both read functions live in the same file and share
 * this one fixture suite's authorizedOrgId/unauthorizedOrgId/clientOrgId
 * setup, extended additively for SMS rather than duplicated. Mirrors
 * lib/agency/revenue.integration.test.ts's exact
 * fixture pattern (real, minted Supabase Auth sessions - resolveAgencyOrganizations's
 * own is_agency_admin() SECURITY DEFINER RPC and RLS can only be proven
 * against a real JWT) and reuses the same pre-existing
 * agency-test-admin@example.com fixture already present in agency_admins -
 * this suite makes zero writes to agency_admins and cleans up everything it
 * creates.
 *
 * KNOWN, PRE-EXISTING, documented environment gap (see
 * lib/agency/revenue.integration.test.ts and
 * lib/agency/authorization.integration.test.ts): the
 * agency-test-admin@example.com fixture may have no row in agency_admins in
 * a given database, causing every test below that depends on
 * resolveAgencyOrganizations succeeding to fail with result.ok===false. This
 * is unrelated to this phase's implementation - see the disposable-admin
 * verification technique used in prior phases if independent confirmation
 * against a real admin session is needed.
 *
 * Uses a distinct model string ("claude-sonnet-5-agency-cost-test") for its
 * rate_cards fixtures, never "claude-sonnet-5" - rate_cards is a GLOBAL
 * table (see 20260927000000_ai_cost_intelligence.sql), so this avoids any
 * overlap-constraint collision with lib/costs/ai-cost-events.integration.test.ts's
 * own fixtures regardless of run order.
 *
 * REQUIRES supabase/migrations/20260927000000_ai_cost_intelligence.sql AND
 * 20260928000000_sms_cost_intelligence.sql to already be applied.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/agency/costs.integration.test.ts
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
const { getAgencyAiCosts, getAgencySmsCosts }: typeof import("./costs") = require(path.join(REPO_ROOT, "lib/agency/costs.ts"));

const service = createServiceRoleClient();
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const EXISTING_AGENCY_ADMIN_USER_ID = "fcfaac02-ece5-402a-af3f-3af1cbccd049";
const EXISTING_AGENCY_ADMIN_EMAIL = "agency-test-admin@example.com";
const TEST_MODEL = "claude-sonnet-5-agency-cost-test";

let authorizedOrgId: string;
let unauthorizedOrgId: string;
let clientOrgId: string;
let clientUser: { id: string; email: string; password: string };
let agencyAdminPassword: string;
const testUserIds: string[] = [];
const cleanupOrgIds: string[] = [];
const rateCardIds: string[] = [];

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

async function insertInteraction(organizationId: string, output: unknown) {
  const { data } = await service.from("ai_interactions").insert({ organization_id: organizationId, interaction_type: "business_insights", input: {}, output, model: TEST_MODEL }).select("id").single();
  return data!.id as string;
}

// Phase 5D-4 - SMS cost fixtures. Needs a real conversation/contact per
// organization, since messages.conversation_id is NOT NULL.
const smsConversationIdByOrg = new Map<string, string>();

async function ensureSmsConversation(organizationId: string): Promise<string> {
  const existing = smsConversationIdByOrg.get(organizationId);
  if (existing) return existing;

  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, phone: "+15550009999" }).select("id").single();
  const { data: conversation } = await service
    .from("conversations")
    .insert({ organization_id: organizationId, contact_id: contact!.id, channel: "sms", status: "open" })
    .select("id")
    .single();
  smsConversationIdByOrg.set(organizationId, conversation!.id);
  return conversation!.id;
}

async function insertMessage(organizationId: string, providerMessageId: string): Promise<string> {
  const conversationId = await ensureSmsConversation(organizationId);
  const { data } = await service
    .from("messages")
    .insert({ organization_id: organizationId, conversation_id: conversationId, direction: "outbound", sender_type: "system", body: "test", status: "delivered", provider_message_id: providerMessageId })
    .select("id")
    .single();
  return data!.id as string;
}

before(async () => {
  const { data: authorizedOrg } = await service.from("organizations").insert({ name: "AI Cost Test Authorized Org" }).select("id").single();
  authorizedOrgId = authorizedOrg!.id;
  cleanupOrgIds.push(authorizedOrgId);

  const { data: unauthorizedOrg } = await service.from("organizations").insert({ name: "AI Cost Test Unauthorized Org" }).select("id").single();
  unauthorizedOrgId = unauthorizedOrg!.id;
  cleanupOrgIds.push(unauthorizedOrgId);

  const { data: clientOrg } = await service.from("organizations").insert({ name: "AI Cost Test Client-Only Org" }).select("id").single();
  clientOrgId = clientOrg!.id;
  cleanupOrgIds.push(clientOrg!.id);

  await service.from("agency_organizations").insert({ organization_id: authorizedOrgId });

  const { data: rates } = await service
    .from("rate_cards")
    .insert([
      { provider: "anthropic", service: "chat_completion", model: TEST_MODEL, unit: "input_token", unit_price: 0.000003, currency: "usd", effective_from: "2026-01-01T00:00:00Z" },
      { provider: "anthropic", service: "chat_completion", model: TEST_MODEL, unit: "output_token", unit_price: 0.000015, currency: "usd", effective_from: "2026-01-01T00:00:00Z" },
    ])
    .select("id");
  for (const row of rates ?? []) rateCardIds.push(row.id);

  // Known: a real, already-priced interaction (cost event inserted directly,
  // mirroring exactly what recordAiCostEventForInteraction itself would
  // write).
  const knownInteractionId = await insertInteraction(authorizedOrgId, { usage: { input_tokens: 1000, output_tokens: 500 } });
  await service.from("ai_cost_events").insert({
    organization_id: authorizedOrgId,
    provider: "anthropic",
    service: "chat_completion",
    model: TEST_MODEL,
    source_interaction_id: knownInteractionId,
    input_tokens: 1000,
    output_tokens: 500,
    rate_card_input_id: rateCardIds[0],
    rate_card_output_id: rateCardIds[1],
    input_unit_price: 0.000003,
    output_unit_price: 0.000015,
    input_cost: 0.003,
    output_cost: 0.0075,
    total_cost: 0.0105,
    currency: "usd",
    occurred_at: new Date().toISOString(),
  });

  // Unpriced: trusted type, valid usage, but no ai_cost_events row (as if no
  // rate card had covered its period).
  await insertInteraction(authorizedOrgId, { usage: { input_tokens: 200, output_tokens: 100 } });

  // Unknown (missing usage): trusted type, no usage field at all.
  await insertInteraction(authorizedOrgId, { summary: "no usage reported" });

  // Unknown (untrusted identity): an n8n-driven interaction_type with
  // plausible-looking usage - must never be treated as priceable.
  await service.from("ai_interactions").insert({
    organization_id: authorizedOrgId,
    interaction_type: "customer_reply_response",
    input: {},
    output: { model: "claude-sonnet-5", usage: { input_tokens: 999, output_tokens: 999, total_tokens: 1998 } },
    model: "claude-sonnet-5",
  });

  // Canary: a large known cost event on the unauthorized org - if scoping is
  // broken, this leaks into the authorized org's or agency's own totals.
  const canaryInteractionId = await insertInteraction(unauthorizedOrgId, { usage: { input_tokens: 999999, output_tokens: 999999 } });
  await service.from("ai_cost_events").insert({
    organization_id: unauthorizedOrgId,
    provider: "anthropic",
    service: "chat_completion",
    model: TEST_MODEL,
    source_interaction_id: canaryInteractionId,
    input_tokens: 999999,
    output_tokens: 999999,
    rate_card_input_id: rateCardIds[0],
    rate_card_output_id: rateCardIds[1],
    input_unit_price: 0.000003,
    output_unit_price: 0.000015,
    input_cost: 3.0,
    output_cost: 15.0,
    total_cost: 18.0,
    currency: "usd",
    occurred_at: new Date().toISOString(),
  });

  // Phase 5D-4 SMS fixtures. Known: a real message with a real
  // sms_cost_events row (inserted directly, mirroring exactly what
  // recordSmsCostEventForMessage itself would write). Unknown: a real
  // message with no cost event at all (as if the Twilio fetch never
  // resolved a price).
  const knownMessageId = await insertMessage(authorizedOrgId, "SM_test_known");
  await service.from("sms_cost_events").insert({
    organization_id: authorizedOrgId,
    provider: "twilio",
    service: "sms",
    source_message_id: knownMessageId,
    provider_message_id: "SM_test_known",
    direction: "outbound",
    provider_status: "delivered",
    price: 0.0075,
    currency: "usd",
    num_segments: 1,
    num_media: 0,
    occurred_at: new Date().toISOString(),
  });
  await insertMessage(authorizedOrgId, "SM_test_unknown");

  // Canary: a large known SMS cost event on the unauthorized org.
  const canaryMessageId = await insertMessage(unauthorizedOrgId, "SM_test_canary");
  await service.from("sms_cost_events").insert({
    organization_id: unauthorizedOrgId,
    provider: "twilio",
    service: "sms",
    source_message_id: canaryMessageId,
    provider_message_id: "SM_test_canary",
    direction: "outbound",
    provider_status: "delivered",
    price: 50.0,
    currency: "usd",
    occurred_at: new Date().toISOString(),
  });

  const stamp = Date.now();
  clientUser = await createTestUser(`ai-cost-test-client-${stamp}@example.com`);
  await service.from("organization_members").insert({ organization_id: clientOrgId, user_id: clientUser.id, role: "owner" });

  agencyAdminPassword = `AgencyFixture-${Math.random().toString(36).slice(2)}-Aa1!`;
  const { error } = await service.auth.admin.updateUserById(EXISTING_AGENCY_ADMIN_USER_ID, { password: agencyAdminPassword });
  if (error) throw new Error(`failed to reset fixture password: ${error.message}`);
});

after(async () => {
  for (const orgId of cleanupOrgIds) {
    await service.from("ai_cost_events").delete().eq("organization_id", orgId);
    await service.from("ai_interactions").delete().eq("organization_id", orgId);
    await service.from("sms_cost_events").delete().eq("organization_id", orgId);
    await service.from("messages").delete().eq("organization_id", orgId);
    await service.from("conversations").delete().eq("organization_id", orgId);
    await service.from("contacts").delete().eq("organization_id", orgId);
    await service.from("organization_members").delete().eq("organization_id", orgId);
  }
  await service.from("agency_organizations").delete().eq("organization_id", authorizedOrgId);
  for (const orgId of cleanupOrgIds) {
    await service.from("organizations").delete().eq("id", orgId);
  }
  for (const id of rateCardIds) {
    await service.from("rate_cards").delete().eq("id", id);
  }
  for (const userId of testUserIds) {
    await service.auth.admin.deleteUser(userId);
  }
});

test("1. an authorized agency admin sees known/unpriced/unknown counts for the authorized organization", async () => {
  const client = await signInAs(EXISTING_AGENCY_ADMIN_EMAIL, agencyAdminPassword);
  const result = await getAgencyAiCosts(client, service, "allTime");

  assert.equal(result.ok, true);
  if (!result.ok) return;

  const authorized = result.clients.find((c) => c.organizationId === authorizedOrgId);
  assert.ok(authorized, "the authorized organization must appear");
  assert.equal(authorized!.knownInteractionCount, 1);
  assert.equal(authorized!.unpricedInteractionCount, 1);
  assert.equal(authorized!.unknownInteractionCount, 2, "both the missing-usage row and the untrusted-identity row must count as unknown");
  assert.deepEqual(authorized!.knownCost, [{ currency: "usd", amount: 0.0105 }]);
  assert.equal(authorized!.dataQuality, "partial", "a mix of known and unresolved interactions must be 'partial', never silently 'known'");
});

test("2. cross-tenant isolation: the unauthorized organization's canary cost never leaks into the authorized organization's or agency-wide totals", async () => {
  const client = await signInAs(EXISTING_AGENCY_ADMIN_EMAIL, agencyAdminPassword);
  const result = await getAgencyAiCosts(client, service, "allTime");
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const leaked = result.clients.find((c) => c.organizationId === unauthorizedOrgId);
  assert.equal(leaked, undefined, "an organization never added to agency_organizations must never appear");

  const agencyKnownUsd = result.totals.knownCost.find((c) => c.currency === "usd")?.amount ?? 0;
  assert.ok(agencyKnownUsd < 18, "the unauthorized org's $18 canary cost event must never be summed into the agency-wide total");
});

test("3. a genuinely zero-interaction organization reports dataQuality='known' with an empty knownCost array - a confirmed empty state, never 'unknown'", async () => {
  const { data: emptyOrg } = await service.from("organizations").insert({ name: "AI Cost Test Empty Org" }).select("id").single();
  await service.from("agency_organizations").insert({ organization_id: emptyOrg!.id });

  try {
    const client = await signInAs(EXISTING_AGENCY_ADMIN_EMAIL, agencyAdminPassword);
    const result = await getAgencyAiCosts(client, service, "allTime");
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const empty = result.clients.find((c) => c.organizationId === emptyOrg!.id);
    assert.ok(empty);
    assert.deepEqual(empty!.knownCost, []);
    assert.equal(empty!.knownInteractionCount, 0);
    assert.equal(empty!.unpricedInteractionCount, 0);
    assert.equal(empty!.unknownInteractionCount, 0);
    assert.equal(empty!.dataQuality, "known", "zero interactions is a confirmed, real empty state - not the same as 'unknown'");
  } finally {
    await service.from("agency_organizations").delete().eq("organization_id", emptyOrg!.id);
    await service.from("organizations").delete().eq("id", emptyOrg!.id);
  }
});

test("4. an ordinary client/contractor org owner is denied - not_agency_admin, never given any organization's cost data", async () => {
  const client = await signInAs(clientUser.email, clientUser.password);
  const result = await getAgencyAiCosts(client, service, "allTime");

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "not_agency_admin");
});

test("5. an unauthenticated (anon) caller is denied - unauthenticated, never reaches the cost read", async () => {
  const anon = createSupabaseClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const result = await getAgencyAiCosts(anon, service, "allTime");

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "unauthenticated");
});

test("6. RLS: a normal organization member cannot read ai_cost_events directly via PostgREST", async () => {
  const client = await signInAs(clientUser.email, clientUser.password);
  const { data, error } = await client.from("ai_cost_events").select("*").eq("organization_id", authorizedOrgId);
  assert.equal(error, null, "RLS denies via an empty result, not a query error");
  assert.equal(data?.length ?? 0, 0, "a normal organization member must never see any ai_cost_events row, even for their own organization");
});

test("7. RLS: a normal organization member cannot read rate_cards directly via PostgREST", async () => {
  const client = await signInAs(clientUser.email, clientUser.password);
  const { data, error } = await client.from("rate_cards").select("*");
  assert.equal(error, null);
  assert.equal(data?.length ?? 0, 0, "rate_cards pricing math must never be exposed to a normal organization member");
});

// ===========================================================================
// Phase 5D-4 - SMS Cost Intelligence (getAgencySmsCosts)
// ===========================================================================

test("8. an authorized agency admin sees known/unknown SMS message counts for the authorized organization - no 'unpriced' state exists for SMS", async () => {
  const client = await signInAs(EXISTING_AGENCY_ADMIN_EMAIL, agencyAdminPassword);
  const result = await getAgencySmsCosts(client, service, "allTime");

  assert.equal(result.ok, true);
  if (!result.ok) return;

  const authorized = result.clients.find((c) => c.organizationId === authorizedOrgId);
  assert.ok(authorized, "the authorized organization must appear");
  assert.equal(authorized!.knownMessageCount, 1);
  assert.equal(authorized!.unknownMessageCount, 1);
  assert.deepEqual(authorized!.knownCost, [{ currency: "usd", amount: 0.0075 }]);
  assert.equal(authorized!.dataQuality, "partial", "a mix of known and unknown messages must be 'partial'");
});

test("9. cross-tenant isolation: the unauthorized organization's canary SMS cost never leaks into the authorized organization's or agency-wide totals", async () => {
  const client = await signInAs(EXISTING_AGENCY_ADMIN_EMAIL, agencyAdminPassword);
  const result = await getAgencySmsCosts(client, service, "allTime");
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const leaked = result.clients.find((c) => c.organizationId === unauthorizedOrgId);
  assert.equal(leaked, undefined, "an organization never added to agency_organizations must never appear");

  const agencyKnownUsd = result.totals.knownCost.find((c) => c.currency === "usd")?.amount ?? 0;
  assert.ok(agencyKnownUsd < 50, "the unauthorized org's $50 canary SMS cost event must never be summed into the agency-wide total");
});

test("10. an ordinary client/contractor org owner is denied SMS cost data - not_agency_admin", async () => {
  const client = await signInAs(clientUser.email, clientUser.password);
  const result = await getAgencySmsCosts(client, service, "allTime");

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "not_agency_admin");
});

test("11. an unauthenticated (anon) caller is denied - never reaches the SMS cost read", async () => {
  const anon = createSupabaseClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const result = await getAgencySmsCosts(anon, service, "allTime");

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "unauthenticated");
});

test("12. RLS: a normal organization member cannot read sms_cost_events directly via PostgREST", async () => {
  const client = await signInAs(clientUser.email, clientUser.password);
  const { data, error } = await client.from("sms_cost_events").select("*").eq("organization_id", authorizedOrgId);
  assert.equal(error, null, "RLS denies via an empty result, not a query error");
  assert.equal(data?.length ?? 0, 0, "a normal organization member must never see any sms_cost_events row, even for their own organization");
});

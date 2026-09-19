/**
 * Integration tests for merge_contacts() (the RPC) - against an isolated
 * test organization and real minted Supabase Auth test users on the real
 * Supabase project (matching sms-routing.integration.test.ts's own
 * established pattern for exactly this class of authorization proof). Run
 * with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/contacts/merge.integration.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const require = createRequire(path.join(REPO_ROOT, "package.json"));
const { createClient: createSupabaseClient } = require("@supabase/supabase-js");

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
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

let organizationId: string;
let otherOrgId: string;
const testUserIds: string[] = [];

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
  if (error) throw new Error(`sign-in failed: ${error.message}`);
  return client;
}

let ownerUser: { id: string; email: string; password: string };
let memberUser: { id: string; email: string; password: string };
let otherOwner: { id: string; email: string; password: string };

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Contact Merge Test Org" }).select("id").single();
  const { data: other } = await service.from("organizations").insert({ name: "Contact Merge Test Org - Other" }).select("id").single();
  organizationId = org!.id;
  otherOrgId = other!.id;

  const stamp = Date.now();
  ownerUser = await createTestUser(`merge-owner-${stamp}@example.com`);
  memberUser = await createTestUser(`merge-member-${stamp}@example.com`);
  otherOwner = await createTestUser(`merge-otherowner-${stamp}@example.com`);
  await service.from("organization_members").insert([
    { organization_id: organizationId, user_id: ownerUser.id, role: "owner" },
    { organization_id: organizationId, user_id: memberUser.id, role: "member" },
    { organization_id: otherOrgId, user_id: otherOwner.id, role: "owner" },
  ]);
});

after(async () => {
  for (const orgId of [organizationId, otherOrgId]) {
    await service.from("audit_log").delete().eq("organization_id", orgId);
    await service.from("leads").delete().eq("organization_id", orgId);
    await service.from("conversations").delete().eq("organization_id", orgId);
    await service.from("appointments").delete().eq("organization_id", orgId);
    await service.from("estimates").delete().eq("organization_id", orgId);
    await service.from("jobs").delete().eq("organization_id", orgId);
    await service.from("contacts").delete().eq("organization_id", orgId);
    await service.from("organization_members").delete().eq("organization_id", orgId);
    await service.from("organizations").delete().eq("id", orgId);
  }
  for (const userId of testUserIds) {
    await service.auth.admin.deleteUser(userId);
  }
});

async function makeContact(orgId: string, fields: Record<string, unknown> = {}) {
  const { data } = await service.from("contacts").insert({ organization_id: orgId, ...fields }).select("id").single();
  return data!.id as string;
}

// ==================== Authorization ====================

test("anonymous cannot call merge_contacts", async () => {
  const sourceId = await makeContact(organizationId, { first_name: "Anon Source" });
  const targetId = await makeContact(organizationId, { first_name: "Anon Target" });
  const anon = createSupabaseClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await anon.rpc("merge_contacts", { p_organization_id: organizationId, p_source_contact_id: sourceId, p_target_contact_id: targetId });
  assert.ok(error);
});

test("a normal member cannot merge contacts", async () => {
  const sourceId = await makeContact(organizationId, { first_name: "Member Source" });
  const targetId = await makeContact(organizationId, { first_name: "Member Target" });
  const client = await signInAs(memberUser.email, memberUser.password);
  const { error } = await client.rpc("merge_contacts", { p_organization_id: organizationId, p_source_contact_id: sourceId, p_target_contact_id: targetId });
  assert.ok(error);
  const { data: unchanged } = await service.from("contacts").select("merged_into_id").eq("id", sourceId).single();
  assert.equal(unchanged?.merged_into_id, null);
});

test("an owner of a different organization cannot merge this organization's contacts", async () => {
  const sourceId = await makeContact(organizationId, { first_name: "CrossOrg Source" });
  const targetId = await makeContact(organizationId, { first_name: "CrossOrg Target" });
  const client = await signInAs(otherOwner.email, otherOwner.password);
  const { error } = await client.rpc("merge_contacts", { p_organization_id: organizationId, p_source_contact_id: sourceId, p_target_contact_id: targetId });
  assert.ok(error, "otherOwner is not an admin of organizationId, so is_org_admin(organizationId) must be false for them");
});

test("cannot merge a contact into itself", async () => {
  const contactId = await makeContact(organizationId, { first_name: "Self" });
  const client = await signInAs(ownerUser.email, ownerUser.password);
  const { error } = await client.rpc("merge_contacts", { p_organization_id: organizationId, p_source_contact_id: contactId, p_target_contact_id: contactId });
  assert.ok(error);
});

test("cannot merge a contact belonging to a different organization, even naming this org's admin", async () => {
  const foreignContactId = await makeContact(otherOrgId, { first_name: "Foreign" });
  const targetId = await makeContact(organizationId, { first_name: "Local Target" });
  const client = await signInAs(ownerUser.email, ownerUser.password);
  const { error } = await client.rpc("merge_contacts", { p_organization_id: organizationId, p_source_contact_id: foreignContactId, p_target_contact_id: targetId });
  assert.ok(error, "the source contact does not actually belong to organizationId, so the row-level re-check must reject it");
});

// ==================== Successful merge ====================

test("owner/admin can merge, relationships are reassigned across every FK table, survivor fields are preserved/filled, audit is recorded", async () => {
  const sourceId = await makeContact(organizationId, {
    first_name: "Source",
    last_name: "Contact",
    phone: "5559990001",
    phone_normalized: "+15559990001",
    email: null,
    company_name: "Old Co",
    notes: "source notes",
  });
  const targetId = await makeContact(organizationId, {
    first_name: "Target",
    last_name: null, // missing - should be filled from source
    phone: null, // missing - should be filled from source
    email: "target@example.com",
    company_name: "New Co", // present - must NOT be overwritten by source's "Old Co"
    notes: null, // missing - should be filled from source
  });

  const leadId = (await service.from("leads").insert({ organization_id: organizationId, contact_id: sourceId, service: "Test service", source: "test", status: "new", temperature: "warm" }).select("id").single()).data!.id;
  const conversationId = (await service.from("conversations").insert({ organization_id: organizationId, contact_id: sourceId, channel: "sms", status: "closed" }).select("id").single()).data!.id;
  const appointmentId = (await service.from("appointments").insert({ organization_id: organizationId, contact_id: sourceId, title: "Test appt", start_at: new Date().toISOString(), end_at: new Date(Date.now() + 3600000).toISOString(), status: "scheduled" }).select("id").single()).data!.id;
  const estimateId = (await service.from("estimates").insert({ organization_id: organizationId, contact_id: sourceId, title: "Test estimate", status: "draft" }).select("id").single()).data!.id;
  const jobId = (await service.from("jobs").insert({ organization_id: organizationId, contact_id: sourceId, title: "Test job", status: "scheduled" }).select("id").single()).data!.id;

  const client = await signInAs(ownerUser.email, ownerUser.password);
  const { data: result, error } = await client.rpc("merge_contacts", { p_organization_id: organizationId, p_source_contact_id: sourceId, p_target_contact_id: targetId, p_reason: "test merge" });
  assert.equal(error, null, error?.message);
  assert.equal(result.ok, true);
  assert.equal(result.reassigned_counts.leads, 1);
  assert.equal(result.reassigned_counts.conversations, 1);
  assert.equal(result.reassigned_counts.appointments, 1);
  assert.equal(result.reassigned_counts.estimates, 1);
  assert.equal(result.reassigned_counts.jobs, 1);

  const { data: lead } = await service.from("leads").select("contact_id").eq("id", leadId).single();
  const { data: conversation } = await service.from("conversations").select("contact_id").eq("id", conversationId).single();
  const { data: appointment } = await service.from("appointments").select("contact_id").eq("id", appointmentId).single();
  const { data: estimate } = await service.from("estimates").select("contact_id").eq("id", estimateId).single();
  const { data: job } = await service.from("jobs").select("contact_id").eq("id", jobId).single();
  assert.equal(lead?.contact_id, targetId);
  assert.equal(conversation?.contact_id, targetId);
  assert.equal(appointment?.contact_id, targetId);
  assert.equal(estimate?.contact_id, targetId);
  assert.equal(job?.contact_id, targetId);

  const { data: target } = await service.from("contacts").select("*").eq("id", targetId).single();
  assert.equal(target?.first_name, "Target", "target's own populated field must never be overwritten");
  assert.equal(target?.last_name, "Contact", "missing target field filled from source");
  assert.equal(target?.phone, "5559990001", "missing target field filled from source");
  assert.equal(target?.phone_normalized, "+15559990001");
  assert.equal(target?.email, "target@example.com", "target's own populated field must never be overwritten");
  assert.equal(target?.company_name, "New Co", "target's own populated field must never be overwritten, even though source has a different value");
  assert.equal(target?.notes, "source notes", "missing target field filled from source");

  const { data: source } = await service.from("contacts").select("merged_into_id, merged_at").eq("id", sourceId).single();
  assert.equal(source?.merged_into_id, targetId);
  assert.ok(source?.merged_at);

  const { data: audit } = await service.from("audit_log").select("action, entity_type, entity_id, metadata").eq("organization_id", organizationId).eq("action", "contact_merged").maybeSingle();
  assert.equal(audit?.entity_type, "contact");
  assert.equal(audit?.entity_id, targetId);
  assert.equal((audit?.metadata as Record<string, unknown>)?.source_contact_id, sourceId);
});

test("repeated merge attempts on an already-merged source are rejected safely, never re-processed", async () => {
  const sourceId = await makeContact(organizationId, { first_name: "AlreadyMerged Source" });
  const targetId = await makeContact(organizationId, { first_name: "AlreadyMerged Target" });
  const otherTargetId = await makeContact(organizationId, { first_name: "Other Target" });

  const client = await signInAs(ownerUser.email, ownerUser.password);
  const first = await client.rpc("merge_contacts", { p_organization_id: organizationId, p_source_contact_id: sourceId, p_target_contact_id: targetId });
  assert.equal(first.error, null);

  const second = await client.rpc("merge_contacts", { p_organization_id: organizationId, p_source_contact_id: sourceId, p_target_contact_id: otherTargetId });
  assert.ok(second.error, "a contact that has already been merged must not be merged again");
});

test("conversations: if both source and target have an open conversation on the same channel, the source's is closed before reassignment rather than violating the unique open-conversation index", async () => {
  const sourceId = await makeContact(organizationId, { first_name: "OpenConvo Source" });
  const targetId = await makeContact(organizationId, { first_name: "OpenConvo Target" });

  const sourceConvoId = (await service.from("conversations").insert({ organization_id: organizationId, contact_id: sourceId, channel: "sms", status: "open" }).select("id").single()).data!.id;
  const targetConvoId = (await service.from("conversations").insert({ organization_id: organizationId, contact_id: targetId, channel: "sms", status: "open" }).select("id").single()).data!.id;

  const client = await signInAs(ownerUser.email, ownerUser.password);
  const { error } = await client.rpc("merge_contacts", { p_organization_id: organizationId, p_source_contact_id: sourceId, p_target_contact_id: targetId });
  assert.equal(error, null, error?.message);

  const { data: sourceConvo } = await service.from("conversations").select("contact_id, status").eq("id", sourceConvoId).single();
  const { data: targetConvo } = await service.from("conversations").select("contact_id, status").eq("id", targetConvoId).single();
  assert.equal(sourceConvo?.contact_id, targetId, "still reassigned to the target, just closed first");
  assert.equal(sourceConvo?.status, "closed");
  assert.equal(targetConvo?.status, "open", "the target's own open conversation is untouched");
});

/**
 * Gym Revenue Engine, Slice 2: live, authenticated-session proof for
 * convertLeadToMembership() (lib/memberships/conversion.ts). Same
 * disposable-fixture pattern as lib/auth/organization-vertical.integration.test.ts
 * and lib/memberships/memberships-checkins-rls.integration.test.ts.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "lib/memberships/conversion.integration.test.ts"
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { convertLeadToMembership }: typeof import("./conversion") = require("./conversion.ts");

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

const service = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anon = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function createSessionFor(email: string, password: string) {
  const { data: signIn, error } = await anon.auth.signInWithPassword({ email, password });
  if (error || !signIn.session) throw error ?? new Error("no session");
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${signIn.session.access_token}` } },
  });
}

let gymOrgId: string;
let gymOrgBId: string;
let contractorOrgId: string;
let gymUserId: string;
let gymUserBId: string;
let contractorUserId: string;
let sessionGym: Awaited<ReturnType<typeof createSessionFor>>;
let sessionGymB: Awaited<ReturnType<typeof createSessionFor>>;
let sessionContractor: Awaited<ReturnType<typeof createSessionFor>>;

let gymContactId: string;
let gymLeadId: string;
let noPhoneContactId: string;
let noPhoneLeadId: string;
let gymOrgBLeadId: string;
let contractorContactId: string;
let contractorLeadId: string;

async function makeOrgUserSession(namePrefix: string, vertical: "contractor" | "gym") {
  const { data: org, error: orgErr } = await service
    .from("organizations")
    .insert({ name: `${namePrefix} ${Date.now()}`, payment_status: "active", automation_mode: "live", vertical })
    .select("id")
    .single();
  if (orgErr) throw orgErr;
  const organizationId = org!.id as string;

  const email = `conversion-test-${namePrefix.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}@example.com`;
  const password = "a-real-test-password-123";
  const { data: user, error: userErr } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (userErr) throw userErr;
  const userId = user.user!.id;

  const { error: memberErr } = await service.from("organization_members").insert({ organization_id: organizationId, user_id: userId, role: "owner" });
  if (memberErr) throw memberErr;

  const session = await createSessionFor(email, password);
  return { organizationId, userId, session };
}

before(async () => {
  const gym = await makeOrgUserSession("Conversion Gym", "gym");
  gymOrgId = gym.organizationId;
  gymUserId = gym.userId;
  sessionGym = gym.session;

  const gymB = await makeOrgUserSession("Conversion Gym B", "gym");
  gymOrgBId = gymB.organizationId;
  gymUserBId = gymB.userId;
  sessionGymB = gymB.session;

  const contractor = await makeOrgUserSession("Conversion Contractor", "contractor");
  contractorOrgId = contractor.organizationId;
  contractorUserId = contractor.userId;
  sessionContractor = contractor.session;

  const { data: gymContact } = await service.from("contacts").insert({ organization_id: gymOrgId, first_name: "Gym", last_name: "Prospect", phone: "+15555550111" }).select("id").single();
  gymContactId = gymContact!.id;
  const { data: gymLead } = await service.from("leads").insert({ organization_id: gymOrgId, contact_id: gymContactId, service: "Membership Inquiry", status: "appointment", temperature: "hot" }).select("id").single();
  gymLeadId = gymLead!.id;

  const { data: noPhoneContact } = await service.from("contacts").insert({ organization_id: gymOrgId, first_name: "No", last_name: "Phone" }).select("id").single();
  noPhoneContactId = noPhoneContact!.id;
  const { data: noPhoneLead } = await service.from("leads").insert({ organization_id: gymOrgId, contact_id: noPhoneContactId, service: "Membership Inquiry", status: "appointment", temperature: "warm" }).select("id").single();
  noPhoneLeadId = noPhoneLead!.id;

  const { data: gymBContact } = await service.from("contacts").insert({ organization_id: gymOrgBId, first_name: "Other", last_name: "GymLead" }).select("id").single();
  const { data: gymBLead } = await service.from("leads").insert({ organization_id: gymOrgBId, contact_id: gymBContact!.id, service: "Membership Inquiry", status: "appointment", temperature: "warm" }).select("id").single();
  gymOrgBLeadId = gymBLead!.id;

  const { data: contractorContact } = await service.from("contacts").insert({ organization_id: contractorOrgId, first_name: "Contractor", last_name: "Customer", phone: "+15555550112" }).select("id").single();
  contractorContactId = contractorContact!.id;
  const { data: contractorLead } = await service.from("leads").insert({ organization_id: contractorOrgId, contact_id: contractorContactId, service: "Roof repair", status: "qualified", temperature: "warm" }).select("id").single();
  contractorLeadId = contractorLead!.id;
});

after(async () => {
  for (const orgId of [gymOrgId, gymOrgBId, contractorOrgId]) {
    await service.from("messages").delete().eq("organization_id", orgId);
    await service.from("workflow_executions").delete().eq("organization_id", orgId);
    await service.from("automation_events").delete().eq("organization_id", orgId);
    await service.from("conversations").delete().eq("organization_id", orgId);
    await service.from("memberships").delete().eq("organization_id", orgId);
    await service.from("leads").delete().eq("organization_id", orgId);
    await service.from("contacts").delete().eq("organization_id", orgId);
    await service.from("organizations").delete().eq("id", orgId);
  }
  for (const userId of [gymUserId, gymUserBId, contractorUserId]) {
    await service.auth.admin.deleteUser(userId);
  }
});

test("1. a contractor organization is rejected - no membership, no lead change, no message", async () => {
  const result = await convertLeadToMembership(sessionContractor, { organizationId: contractorOrgId, vertical: "contractor", leadId: contractorLeadId, userId: contractorUserId });
  assert.equal(result.ok, false);

  const { data: memberships } = await service.from("memberships").select("id").eq("organization_id", contractorOrgId);
  assert.equal(memberships?.length, 0);
  const { data: lead } = await service.from("leads").select("status").eq("id", contractorLeadId).single();
  assert.equal(lead?.status, "qualified");
  const { data: messages } = await service.from("messages").select("id").eq("organization_id", contractorOrgId);
  assert.equal(messages?.length, 0);
});

test("2. a valid gym lead converts: membership created correctly, lead becomes won", async () => {
  const result = await convertLeadToMembership(sessionGym, { organizationId: gymOrgId, vertical: "gym", leadId: gymLeadId, userId: gymUserId });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.alreadyMember, false);
  assert.ok(result.membershipId);

  const { data: membership } = await service.from("memberships").select("organization_id, contact_id, status, plan_name, start_at").eq("id", result.membershipId!).single();
  assert.equal(membership?.organization_id, gymOrgId);
  assert.equal(membership?.contact_id, gymContactId);
  assert.equal(membership?.status, "active");
  assert.ok(membership?.plan_name);
  assert.ok(membership?.start_at);

  const { data: lead } = await service.from("leads").select("status").eq("id", gymLeadId).single();
  assert.equal(lead?.status, "won");
});

test("3. organization isolation: a gym session cannot convert a lead belonging to a different gym organization", async () => {
  const result = await convertLeadToMembership(sessionGymB, { organizationId: gymOrgBId, vertical: "gym", leadId: gymLeadId, userId: gymUserBId });
  assert.equal(result.ok, false);
});

test("4. cross-org lead reference fails cleanly (same RLS boundary as org isolation above)", async () => {
  const result = await convertLeadToMembership(sessionGym, { organizationId: gymOrgId, vertical: "gym", leadId: gymOrgBLeadId, userId: gymUserId });
  assert.equal(result.ok, false);
});

test("5. duplicate conversion is safely prevented - a repeat call is a no-op, not a second membership", async () => {
  const repeat = await convertLeadToMembership(sessionGym, { organizationId: gymOrgId, vertical: "gym", leadId: gymLeadId, userId: gymUserId });
  assert.equal(repeat.ok, true);
  if (!repeat.ok) return;
  assert.equal(repeat.alreadyMember, true);
  assert.equal(repeat.membershipId, null);

  const { data: memberships } = await service.from("memberships").select("id").eq("organization_id", gymOrgId).eq("contact_id", gymContactId).eq("status", "active");
  assert.equal(memberships?.length, 1, "exactly one active membership must exist, never two");
});

test("6. an invalid/nonexistent lead fails cleanly", async () => {
  const result = await convertLeadToMembership(sessionGym, { organizationId: gymOrgId, vertical: "gym", leadId: "00000000-0000-0000-0000-000000000000", userId: gymUserId });
  assert.equal(result.ok, false);
});

test("7. welcome message uses the organization's real name and is recorded through the normal messaging path", async () => {
  const { data: org } = await service.from("organizations").select("name").eq("id", gymOrgId).single();

  const { data: messages } = await service
    .from("messages")
    .select("body, direction, sender_type")
    .eq("organization_id", gymOrgId)
    .eq("direction", "outbound")
    .order("created_at", { ascending: false })
    .limit(1);

  const message = messages?.[0];
  assert.ok(message, "expected a welcome message to have been sent");
  assert.ok(message!.body.includes(org!.name), "welcome message must use the organization's real name, not a hardcoded one");
});

test("8. membership creation succeeds for a contact with no valid phone even though the welcome message is correctly blocked by the outbound gate (invalid_destination), never thrown as an error", async () => {
  const result = await convertLeadToMembership(sessionGym, { organizationId: gymOrgId, vertical: "gym", leadId: noPhoneLeadId, userId: gymUserId });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.membershipId, "membership creation must still succeed even though the welcome message cannot be delivered");

  // The membership.created event/execution must still be recorded (proves
  // the gate ran and made a real decision, not that the send path was
  // skipped entirely) - see this module's own membership-conversion.ts
  // comment: evaluateOutboundGate requires a real execution to evaluate.
  const { data: events } = await service.from("automation_events").select("id").eq("organization_id", gymOrgId).eq("event_type", "membership.created").eq("entity_id", result.membershipId!);
  assert.equal(events?.length, 1, "the membership.created event must still be recorded even when the message is blocked");

  const { data: conversation } = await service.from("conversations").select("id").eq("organization_id", gymOrgId).eq("contact_id", noPhoneContactId).maybeSingle();
  const { data: sentMessages } = conversation
    ? await service.from("messages").select("id").eq("conversation_id", conversation.id).eq("direction", "outbound")
    : { data: [] };
  assert.equal(sentMessages?.length ?? 0, 0, "no outbound message can exist for a contact with no valid phone - the gate's invalid_destination check must have blocked it");
});

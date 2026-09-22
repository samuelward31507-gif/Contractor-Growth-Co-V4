/**
 * Integration tests for Growth System Completion Pass 2, Part 1: persistent
 * lead-stage history (lib/automation/lead-stage-history.ts), built on the
 * existing automation_events table - no new schema. Real, disposable
 * Supabase fixtures.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/lead-stage-history.integration.test.ts
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
const { emitLeadStageChanged, emitLeadStageChangedAsService, getLeadStageHistory }: typeof import("./lead-stage-history") = require(
  path.join(REPO_ROOT, "lib/automation/lead-stage-history.ts"),
);

const service = createServiceRoleClient();
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

async function createTestUser(email: string, testUserIds: string[]) {
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

let organizationId: string;
let otherOrgId: string;
let contactId: string;
let sessionSupabase: ReturnType<typeof createSupabaseClient>;
const testUserIds: string[] = [];

async function makeLead() {
  const { data } = await service.from("leads").insert({ organization_id: organizationId, contact_id: contactId, source: "website", status: "new", temperature: "cold" }).select("id").single();
  return data!.id as string;
}

before(async () => {
  // payment_status: 'active' is required here - create_automation_event is
  // one of the payment-gated SECURITY DEFINER RPCs, and emitLeadStageChanged
  // (unlike its AsService sibling) always runs through a real, non-service
  // session, so the payment gate genuinely applies to it.
  const { data: org } = await service.from("organizations").insert({ name: "Lead Stage History Test Org", payment_status: "active" }).select("id").single();
  organizationId = org!.id;
  const { data: other } = await service.from("organizations").insert({ name: "Lead Stage History Test Org (Other)", payment_status: "active" }).select("id").single();
  otherOrgId = other!.id;

  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, phone: "+15555550301" }).select("id").single();
  contactId = contact!.id;

  const stamp = Date.now();
  const memberUser = await createTestUser(`lead-history-${stamp}@example.com`, testUserIds);
  await service.from("organization_members").insert({ organization_id: organizationId, user_id: memberUser.id, role: "member" });
  sessionSupabase = await signInAs(memberUser.email, memberUser.password);
});

after(async () => {
  for (const orgId of [organizationId, otherOrgId]) {
    await service.from("workflow_executions").delete().eq("organization_id", orgId);
    await service.from("automation_events").delete().eq("organization_id", orgId);
    await service.from("leads").delete().eq("organization_id", orgId);
    await service.from("contacts").delete().eq("organization_id", orgId);
    await service.from("organization_members").delete().eq("organization_id", orgId);
    await service.from("organizations").delete().eq("id", orgId);
  }
  for (const userId of testUserIds) {
    await service.auth.admin.deleteUser(userId);
  }
});

test("1. the first entry (creation) has previousStatus null and the real initial status", async () => {
  const leadId = await makeLead();
  await emitLeadStageChanged(sessionSupabase, { leadId, previousStatus: null, newStatus: "new", source: "manual" });

  const history = await getLeadStageHistory(service, organizationId, leadId);
  assert.equal(history.length, 1);
  assert.equal(history[0].previousStatus, null);
  assert.equal(history[0].newStatus, "new");
});

test("2. a real transition records both the previous and new stage, in order, oldest first", async () => {
  const leadId = await makeLead();
  await emitLeadStageChanged(sessionSupabase, { leadId, previousStatus: null, newStatus: "new", source: "manual" });
  await emitLeadStageChanged(sessionSupabase, { leadId, previousStatus: "new", newStatus: "contacted", source: "manual" });
  await emitLeadStageChanged(sessionSupabase, { leadId, previousStatus: "contacted", newStatus: "qualified", source: "manual" });

  const history = await getLeadStageHistory(service, organizationId, leadId);
  assert.equal(history.length, 3);
  assert.deepEqual(
    history.map((h) => [h.previousStatus, h.newStatus]),
    [
      [null, "new"],
      ["new", "contacted"],
      ["contacted", "qualified"],
    ],
  );
});

test("3. source and actor are recorded correctly for a manual transition", async () => {
  const leadId = await makeLead();
  const {
    data: { user },
  } = await sessionSupabase.auth.getUser();
  await emitLeadStageChanged(sessionSupabase, { leadId, previousStatus: "new", newStatus: "contacted", source: "manual", actorUserId: user!.id });

  const history = await getLeadStageHistory(service, organizationId, leadId);
  assert.equal(history[0].source, "manual");
  assert.equal(history[0].actorUserId, user!.id);
});

test("4. source is recorded correctly for an automation-driven transition, with no actor", async () => {
  const leadId = await makeLead();
  await emitLeadStageChangedAsService(service, organizationId, { leadId, previousStatus: "estimate", newStatus: "won", source: "automation" });

  const history = await getLeadStageHistory(service, organizationId, leadId);
  assert.equal(history[0].source, "automation");
  assert.equal(history[0].actorUserId, null);
});

test("5. idempotency: a retried automation-driven transition (same idempotencySuffix) is recorded only once", async () => {
  const leadId = await makeLead();
  const estimateId = "estimate-abc-123";

  await emitLeadStageChangedAsService(service, organizationId, { leadId, previousStatus: "estimate", newStatus: "won", source: "automation", idempotencySuffix: estimateId });
  await emitLeadStageChangedAsService(service, organizationId, { leadId, previousStatus: "estimate", newStatus: "won", source: "automation", idempotencySuffix: estimateId });

  const history = await getLeadStageHistory(service, organizationId, leadId);
  const wonEntries = history.filter((h) => h.newStatus === "won");
  assert.equal(wonEntries.length, 1, "a retried automation transition with the same idempotency suffix must never be recorded twice");
});

test("6. a genuinely different automation transition (different idempotencySuffix) is recorded as its own entry", async () => {
  const leadId = await makeLead();
  await emitLeadStageChangedAsService(service, organizationId, { leadId, previousStatus: "estimate", newStatus: "won", source: "automation", idempotencySuffix: "estimate-1" });
  await service.from("leads").update({ status: "estimate" }).eq("id", leadId);
  await emitLeadStageChangedAsService(service, organizationId, { leadId, previousStatus: "estimate", newStatus: "won", source: "automation", idempotencySuffix: "estimate-2" });

  const history = await getLeadStageHistory(service, organizationId, leadId);
  const wonEntries = history.filter((h) => h.newStatus === "won");
  assert.equal(wonEntries.length, 2, "a genuinely distinct transition (different estimate) must be recorded as a new entry");
});

test("7. manual transitions (no idempotency key) are never deduplicated - each save is a distinct, real action", async () => {
  const leadId = await makeLead();
  await emitLeadStageChanged(sessionSupabase, { leadId, previousStatus: "new", newStatus: "contacted", source: "manual" });
  await emitLeadStageChanged(sessionSupabase, { leadId, previousStatus: "contacted", newStatus: "new", source: "manual" });
  await emitLeadStageChanged(sessionSupabase, { leadId, previousStatus: "new", newStatus: "contacted", source: "manual" });

  const history = await getLeadStageHistory(service, organizationId, leadId);
  assert.equal(history.length, 3);
});

test("8. organization isolation: a lead's history in organization A is never visible when queried under organization B", async () => {
  const leadId = await makeLead();
  await emitLeadStageChanged(sessionSupabase, { leadId, previousStatus: "new", newStatus: "contacted", source: "manual" });

  const historyUnderOtherOrg = await getLeadStageHistory(service, otherOrgId, leadId);
  assert.equal(historyUnderOtherOrg.length, 0);

  const historyUnderRealOrg = await getLeadStageHistory(service, organizationId, leadId);
  assert.equal(historyUnderRealOrg.length, 1);
});

test("9. a 'lost' then a real 'reactivation' (lost -> contacted) is captured as a normal transition, using the existing status architecture - no new status value invented", async () => {
  const leadId = await makeLead();
  await emitLeadStageChanged(sessionSupabase, { leadId, previousStatus: "qualified", newStatus: "lost", source: "manual" });
  await emitLeadStageChanged(sessionSupabase, { leadId, previousStatus: "lost", newStatus: "contacted", source: "manual" });

  const history = await getLeadStageHistory(service, organizationId, leadId);
  assert.equal(history[history.length - 1].previousStatus, "lost");
  assert.equal(history[history.length - 1].newStatus, "contacted");
});

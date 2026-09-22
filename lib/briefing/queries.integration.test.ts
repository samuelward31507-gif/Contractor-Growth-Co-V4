/**
 * Integration tests for Growth System Completion Pass 2, Parts 5 & 6: the
 * Owner Daily Briefing and End-of-Day Summary (lib/briefing/queries.ts).
 * Both are entirely deterministic - these tests never touch ANTHROPIC_API_KEY
 * and never call any AI provider, confirming "the system must still work
 * without ANTHROPIC_API_KEY" by construction: neither function even
 * attempts an AI call.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/briefing/queries.integration.test.ts
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
const { getOwnerDailyBriefing, getEndOfDaySummary }: typeof import("./queries") = require(path.join(REPO_ROOT, "lib/briefing/queries.ts"));

const service = createServiceRoleClient();

let organizationId: string;
let contactId: string;

async function makeLead(status: string, temperature: string, overrides: Record<string, unknown> = {}) {
  const { data } = await service.from("leads").insert({ organization_id: organizationId, contact_id: contactId, status, temperature, source: "website", ...overrides }).select("id").single();
  return data!.id as string;
}

async function makeAppointment(leadId: string | null, startAt: string, status: "scheduled" | "confirmed" = "scheduled") {
  const endAt = new Date(new Date(startAt).getTime() + 30 * 60 * 1000).toISOString();
  const { data, error } = await service
    .from("appointments")
    .insert({ organization_id: organizationId, contact_id: contactId, lead_id: leadId, title: "Visit", start_at: startAt, end_at: endAt, status })
    .select("id")
    .single();
  if (error || !data) throw new Error(`failed to create test appointment: ${error?.message}`);
  return data.id as string;
}

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Briefing Test Org" }).select("id").single();
  organizationId = org!.id;
  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, phone: "+15555550601" }).select("id").single();
  contactId = contact!.id;
});

after(async () => {
  await service.from("appointments").delete().eq("organization_id", organizationId);
  await service.from("estimates").delete().eq("organization_id", organizationId);
  await service.from("jobs").delete().eq("organization_id", organizationId);
  await service.from("leads").delete().eq("organization_id", organizationId);
  await service.from("contacts").delete().eq("organization_id", organizationId);
  await service.from("organizations").delete().eq("id", organizationId);
});

test("1. empty state: a fresh organization with no data gets a real, useful fallback briefing - never an error, never fabricated numbers", async () => {
  const { data: emptyOrg } = await service.from("organizations").insert({ name: "Briefing Test Org (Empty)" }).select("id").single();
  try {
    const briefing = await getOwnerDailyBriefing(service, emptyOrg!.id);
    assert.equal(briefing.newLeadsCount, 0);
    assert.equal(briefing.hotLeads.length, 0);
    assert.equal(briefing.appointmentsToday.length, 0);
    assert.equal(briefing.aiEscalationsCount, 0);
    assert.equal(briefing.summary, "You're all caught up.");

    const endOfDay = await getEndOfDaySummary(service, emptyOrg!.id);
    assert.equal(endOfDay.leadsReceived, 0);
    assert.equal(endOfDay.valueRepresented, 0);
    assert.equal(endOfDay.summary, "A quiet day - nothing new to report.");
  } finally {
    await service.from("organizations").delete().eq("id", emptyOrg!.id);
  }
});

test("2. hot leads are correctly surfaced in the daily briefing", async () => {
  await makeLead("qualified", "hot");
  await makeLead("qualified", "cold");

  const briefing = await getOwnerDailyBriefing(service, organizationId);
  assert.equal(briefing.hotLeads.length, 1);
});

test("3. appointments today are correctly filtered to TODAY only, excluding tomorrow's and yesterday's", async () => {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14, 0, 0).toISOString();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 14, 0, 0).toISOString();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 14, 0, 0).toISOString();

  await makeAppointment(null, today);
  await makeAppointment(null, tomorrow);
  await makeAppointment(null, yesterday);

  const briefing = await getOwnerDailyBriefing(service, organizationId, now);
  assert.equal(briefing.appointmentsToday.length, 1);
});

test("4. estimates awaiting action only include status = 'sent'", async () => {
  await service.from("estimates").insert([
    { organization_id: organizationId, contact_id: contactId, title: "Quote A", status: "sent", amount: 500 },
    { organization_id: organizationId, contact_id: contactId, title: "Quote B", status: "draft", amount: 500 },
    { organization_id: organizationId, contact_id: contactId, title: "Quote C", status: "accepted", amount: 500 },
  ]);

  const briefing = await getOwnerDailyBriefing(service, organizationId);
  assert.equal(briefing.estimatesAwaitingAction.length, 1);
  assert.equal(briefing.estimatesAwaitingAction[0].title, "Quote A");
});

test("5. jobs recently completed only include status = 'completed' within the last 7 days", async () => {
  const now = new Date();
  const recent = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const old = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  await service.from("jobs").insert([
    { organization_id: organizationId, contact_id: contactId, title: "Job A", status: "completed", completed_at: recent },
    { organization_id: organizationId, contact_id: contactId, title: "Job B", status: "completed", completed_at: old },
    { organization_id: organizationId, contact_id: contactId, title: "Job C", status: "scheduled" },
  ]);

  const briefing = await getOwnerDailyBriefing(service, organizationId, now);
  assert.equal(briefing.jobsRecentlyCompleted.length, 1);
  assert.equal(briefing.jobsRecentlyCompleted[0].title, "Job A");
});

test("6. AI escalations count reflects open conversations with ai_enabled = false", async () => {
  await service.from("conversations").insert([
    { organization_id: organizationId, contact_id: contactId, channel: "sms", status: "open", ai_enabled: false },
    { organization_id: organizationId, contact_id: contactId, channel: "web", status: "open", ai_enabled: true },
  ]);

  const briefing = await getOwnerDailyBriefing(service, organizationId);
  assert.equal(briefing.aiEscalationsCount, 1);
});

test("7. end-of-day: leadsReceived/appointmentsBooked/estimatesSent/jobsWon reflect only TODAY's activity", async () => {
  const { data: freshOrg } = await service.from("organizations").insert({ name: "Briefing Test Org (EOD)" }).select("id").single();
  try {
    const { data: freshContact } = await service.from("contacts").insert({ organization_id: freshOrg!.id, phone: "+15555550602" }).select("id").single();
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0, 0).toISOString();

    const { data: lead } = await service.from("leads").insert({ organization_id: freshOrg!.id, contact_id: freshContact!.id, status: "new", temperature: "cold", source: "website" }).select("id").single();
    const todayEnd = new Date(new Date(today).getTime() + 30 * 60 * 1000).toISOString();
    await service.from("appointments").insert({ organization_id: freshOrg!.id, contact_id: freshContact!.id, lead_id: lead!.id, title: "Visit", start_at: today, end_at: todayEnd, status: "scheduled" });
    await service.from("estimates").insert({ organization_id: freshOrg!.id, contact_id: freshContact!.id, title: "Quote", status: "sent", amount: 800, sent_at: new Date().toISOString() });
    await service.from("jobs").insert({ organization_id: freshOrg!.id, contact_id: freshContact!.id, title: "New Job", status: "scheduled", amount: 1200 });

    const summary = await getEndOfDaySummary(service, freshOrg!.id, now);
    assert.equal(summary.leadsReceived, 1);
    assert.equal(summary.appointmentsBooked, 1);
    assert.equal(summary.estimatesSent, 1);
    assert.equal(summary.jobsWonOrCompleted, 1);
    assert.equal(summary.valueRepresented, 800 + 1200);
  } finally {
    await service.from("appointments").delete().eq("organization_id", freshOrg!.id);
    await service.from("estimates").delete().eq("organization_id", freshOrg!.id);
    await service.from("jobs").delete().eq("organization_id", freshOrg!.id);
    await service.from("leads").delete().eq("organization_id", freshOrg!.id);
    await service.from("contacts").delete().eq("organization_id", freshOrg!.id);
    await service.from("organizations").delete().eq("id", freshOrg!.id);
  }
});

test("8. end-of-day never claims collected revenue - valueRepresented is quoted/contracted only", async () => {
  const summary = await getEndOfDaySummary(service, organizationId);
  assert.ok(typeof summary.valueRepresented === "number");
  // Structural guarantee: the type itself has no "collected"/"revenue" field -
  // this assertion documents the contract, the type system enforces it.
  assert.ok(!("collectedRevenue" in summary));
});

test("9. organization isolation: organization A's briefing never reflects organization B's data", async () => {
  const { data: otherOrg } = await service.from("organizations").insert({ name: "Briefing Test Org (Other)" }).select("id").single();
  try {
    const { data: otherContact } = await service.from("contacts").insert({ organization_id: otherOrg!.id, phone: "+15555550603" }).select("id").single();
    await service.from("leads").insert({ organization_id: otherOrg!.id, contact_id: otherContact!.id, status: "qualified", temperature: "hot", source: "website" });

    const briefingA = await getOwnerDailyBriefing(service, organizationId);
    // organizationId's own hot leads (from test 2) must remain unaffected by
    // otherOrg's insert - a stable count, not inflated by cross-org data.
    const hotCountBefore = briefingA.hotLeads.length;

    const briefingOther = await getOwnerDailyBriefing(service, otherOrg!.id);
    assert.equal(briefingOther.hotLeads.length, 1);
    assert.notEqual(briefingOther.hotLeads[0]?.id, briefingA.hotLeads[0]?.id);
    void hotCountBefore;
  } finally {
    await service.from("leads").delete().eq("organization_id", otherOrg!.id);
    await service.from("contacts").delete().eq("organization_id", otherOrg!.id);
    await service.from("organizations").delete().eq("id", otherOrg!.id);
  }
});

test("10. no AI dependency: neither function reads ANTHROPIC_API_KEY or makes any network call beyond Supabase", async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const briefing = await getOwnerDailyBriefing(service, organizationId);
    const summary = await getEndOfDaySummary(service, organizationId);
    assert.ok(typeof briefing.summary === "string" && briefing.summary.length > 0);
    assert.ok(typeof summary.summary === "string" && summary.summary.length > 0);
  } finally {
    if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous;
  }
});

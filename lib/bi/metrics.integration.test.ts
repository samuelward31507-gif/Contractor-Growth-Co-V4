/**
 * Integration tests for Growth System Completion Pass 2, Parts 2, 3 & 4:
 * Lead -> Booking conversion rate (BiLeadMetrics.leadToBookingRate),
 * Revenue Opportunity (BiRevenueOpportunity), and AI token usage
 * aggregation (BiAiMetrics.totalTokensUsed/averageTokensPerInteraction/
 * interactionsWithUsageData), all computed by getBusinessMetricsSnapshot
 * (lib/bi/metrics.ts). Real, disposable Supabase fixtures against the real
 * project - no mocking layer for a Supabase client exists in this codebase
 * (see this session's own established pattern).
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/bi/metrics.integration.test.ts
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
const { getBusinessMetricsSnapshot }: typeof import("./metrics") = require(path.join(REPO_ROOT, "lib/bi/metrics.ts"));

const service = createServiceRoleClient();

let organizationId: string;
let otherOrgId: string;

async function makeContact(orgId: string, phone: string) {
  const { data } = await service.from("contacts").insert({ organization_id: orgId, phone }).select("id").single();
  return data!.id as string;
}

async function makeLead(orgId: string, contactId: string, status: string, overrides: Record<string, unknown> = {}) {
  const { data } = await service.from("leads").insert({ organization_id: orgId, contact_id: contactId, status, temperature: "cold", source: "website", ...overrides }).select("id").single();
  return data!.id as string;
}

let apptHour = 9;
async function makeAppointment(orgId: string, contactId: string, leadId: string | null, status: "scheduled" | "completed" = "scheduled") {
  const hour = apptHour++;
  const { data } = await service
    .from("appointments")
    .insert({ organization_id: orgId, contact_id: contactId, lead_id: leadId, title: "Visit", start_at: `2027-03-01T${String(hour % 24).padStart(2, "0")}:00:00.000Z`, end_at: `2027-03-01T${String(hour % 24).padStart(2, "0")}:30:00.000Z`, status })
    .select("id")
    .single();
  return data!.id as string;
}

async function makeEstimate(orgId: string, contactId: string, leadId: string | null, status: string, amount: number | null) {
  const { data } = await service.from("estimates").insert({ organization_id: orgId, contact_id: contactId, lead_id: leadId, title: "Quote", status, amount }).select("id").single();
  return data!.id as string;
}

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "BI Metrics Test Org" }).select("id").single();
  organizationId = org!.id;
  const { data: other } = await service.from("organizations").insert({ name: "BI Metrics Test Org (Other)" }).select("id").single();
  otherOrgId = other!.id;
});

after(async () => {
  for (const orgId of [organizationId, otherOrgId]) {
    await service.from("estimates").delete().eq("organization_id", orgId);
    await service.from("appointments").delete().eq("organization_id", orgId);
    await service.from("leads").delete().eq("organization_id", orgId);
    await service.from("contacts").delete().eq("organization_id", orgId);
    await service.from("organizations").delete().eq("id", orgId);
  }
});

// ==================== Part 2: Lead -> Booking rate ====================

test("1. zero leads: leadToBookingRate is null, never a fabricated 0%", async () => {
  const { data: emptyOrg } = await service.from("organizations").insert({ name: "BI Metrics Test Org (Empty)" }).select("id").single();
  try {
    const snapshot = await getBusinessMetricsSnapshot(service, emptyOrg!.id, "allTime");
    assert.equal(snapshot.leadMetrics.leadToBookingRate, null);
  } finally {
    await service.from("organizations").delete().eq("id", emptyOrg!.id);
  }
});

test("2. leads with no appointments at all: leadToBookingRate is 0%, not null (a real, calculable zero)", async () => {
  const contactId = await makeContact(organizationId, "+15555550401");
  await makeLead(organizationId, contactId, "new");
  await makeLead(organizationId, contactId, "contacted");

  const snapshot = await getBusinessMetricsSnapshot(service, organizationId, "allTime");
  assert.equal(snapshot.leadMetrics.leadToBookingRate, 0);
});

test("3. some leads booked, some not: leadToBookingRate reflects the real fraction", async () => {
  const { data: freshOrg } = await service.from("organizations").insert({ name: "BI Metrics Test Org (Booking Rate)" }).select("id").single();
  try {
    const contactId = await makeContact(freshOrg!.id, "+15555550402");
    const leadA = await makeLead(freshOrg!.id, contactId, "qualified");
    const leadB = await makeLead(freshOrg!.id, contactId, "qualified");
    await makeLead(freshOrg!.id, contactId, "new"); // never booked
    await makeAppointment(freshOrg!.id, contactId, leadA);
    await makeAppointment(freshOrg!.id, contactId, leadB);

    const snapshot = await getBusinessMetricsSnapshot(service, freshOrg!.id, "allTime");
    assert.ok(snapshot.leadMetrics.leadToBookingRate !== null);
    assert.ok(Math.abs((snapshot.leadMetrics.leadToBookingRate as number) - (2 / 3) * 100) < 0.01, `expected ~66.67%, got ${snapshot.leadMetrics.leadToBookingRate}`);
  } finally {
    await service.from("estimates").delete().eq("organization_id", freshOrg!.id);
    await service.from("appointments").delete().eq("organization_id", freshOrg!.id);
    await service.from("leads").delete().eq("organization_id", freshOrg!.id);
    await service.from("contacts").delete().eq("organization_id", freshOrg!.id);
    await service.from("organizations").delete().eq("id", freshOrg!.id);
  }
});

test("4. organization isolation: an appointment in organization B never counts toward organization A's leadToBookingRate", async () => {
  const { data: freshOrgA } = await service.from("organizations").insert({ name: "BI Metrics Test Org (Isolation Booking A)" }).select("id").single();
  try {
    const contactA = await makeContact(freshOrgA!.id, "+15555550403");
    await makeLead(freshOrgA!.id, contactA, "qualified");

    const contactB = await makeContact(otherOrgId, "+15555550404");
    // A real appointment in organization B, for organization B's own
    // contact - deliberately never referencing organization A's lead at
    // all (appointments.lead_id is itself org-scoped by its own FK/RLS;
    // there is no way to legitimately point it at another org's lead), so
    // organization A's lead genuinely has zero appointments anywhere.
    await makeAppointment(otherOrgId, contactB, null);

    const snapshot = await getBusinessMetricsSnapshot(service, freshOrgA!.id, "allTime");
    assert.equal(snapshot.leadMetrics.leadToBookingRate, 0, "organization A's only lead has no appointment of its own - organization B's unrelated appointment must never inflate this rate");
  } finally {
    await service.from("appointments").delete().eq("organization_id", otherOrgId);
    await service.from("leads").delete().eq("organization_id", freshOrgA!.id);
    await service.from("contacts").delete().eq("organization_id", freshOrgA!.id);
    await service.from("organizations").delete().eq("id", freshOrgA!.id);
  }
});

test("5. date filtering: a lead created outside the requested range is excluded from leadToBookingRate's denominator", async () => {
  const { data: freshOrg } = await service.from("organizations").insert({ name: "BI Metrics Test Org (Date Filter)" }).select("id").single();
  try {
    const contactId = await makeContact(freshOrg!.id, "+15555550405");
    const oldLeadId = await makeLead(freshOrg!.id, contactId, "new");
    await service.from("leads").update({ created_at: "2020-01-01T00:00:00.000Z" }).eq("id", oldLeadId);

    const snapshot = await getBusinessMetricsSnapshot(service, freshOrg!.id, "today");
    assert.equal(snapshot.leadMetrics.leadToBookingRate, null, "a lead created far outside 'today' must not appear in today's denominator at all");
  } finally {
    await service.from("leads").delete().eq("organization_id", freshOrg!.id);
    await service.from("contacts").delete().eq("organization_id", freshOrg!.id);
    await service.from("organizations").delete().eq("id", freshOrg!.id);
  }
});

// ==================== Part 3: Revenue Opportunity ====================

test("6. openEstimateValue sums only 'sent' estimates, expiredEstimateValue only 'expired', lostEstimateValue only 'declined'", async () => {
  const { data: freshOrg } = await service.from("organizations").insert({ name: "BI Metrics Test Org (Revenue Opportunity)" }).select("id").single();
  try {
    const contactId = await makeContact(freshOrg!.id, "+15555550406");
    await makeEstimate(freshOrg!.id, contactId, null, "sent", 1000);
    await makeEstimate(freshOrg!.id, contactId, null, "sent", 500);
    await makeEstimate(freshOrg!.id, contactId, null, "expired", 300);
    await makeEstimate(freshOrg!.id, contactId, null, "declined", 200);
    await makeEstimate(freshOrg!.id, contactId, null, "draft", 9999); // must never be counted anywhere

    const snapshot = await getBusinessMetricsSnapshot(service, freshOrg!.id, "allTime");
    assert.equal(snapshot.revenueOpportunity.openEstimateValue, 1500);
    assert.equal(snapshot.revenueOpportunity.expiredEstimateValue, 300);
    assert.equal(snapshot.revenueOpportunity.lostEstimateValue, 200);
    assert.equal(snapshot.revenueOpportunity.recoverableEstimateValue, 1800, "recoverable = open + expired, never including the declined (lost) amount");
  } finally {
    await service.from("estimates").delete().eq("organization_id", freshOrg!.id);
    await service.from("contacts").delete().eq("organization_id", freshOrg!.id);
    await service.from("organizations").delete().eq("id", freshOrg!.id);
  }
});

test("7. zero estimates: every revenue-opportunity value field is a real 0, never null or fabricated", async () => {
  const { data: emptyOrg } = await service.from("organizations").insert({ name: "BI Metrics Test Org (Empty Opportunity)" }).select("id").single();
  try {
    const snapshot = await getBusinessMetricsSnapshot(service, emptyOrg!.id, "allTime");
    assert.equal(snapshot.revenueOpportunity.openEstimateValue, 0);
    assert.equal(snapshot.revenueOpportunity.expiredEstimateValue, 0);
    assert.equal(snapshot.revenueOpportunity.lostEstimateValue, 0);
    assert.equal(snapshot.revenueOpportunity.recoverableEstimateValue, 0);
    assert.equal(snapshot.revenueOpportunity.qualifiedLeadsWithoutAppointment, 0);
    assert.equal(snapshot.revenueOpportunity.completedAppointmentsWithoutEstimate, 0);
  } finally {
    await service.from("organizations").delete().eq("id", emptyOrg!.id);
  }
});

test("8. qualifiedLeadsWithoutAppointment counts only qualified leads with no appointment - never leads in other statuses, never a qualified lead that IS booked", async () => {
  const { data: freshOrg } = await service.from("organizations").insert({ name: "BI Metrics Test Org (Qualified No Appt)" }).select("id").single();
  try {
    const contactId = await makeContact(freshOrg!.id, "+15555550407");
    const qualifiedNoAppt = await makeLead(freshOrg!.id, contactId, "qualified");
    const qualifiedWithAppt = await makeLead(freshOrg!.id, contactId, "qualified");
    await makeLead(freshOrg!.id, contactId, "new"); // not qualified - must never count
    await makeAppointment(freshOrg!.id, contactId, qualifiedWithAppt);
    void qualifiedNoAppt;

    const snapshot = await getBusinessMetricsSnapshot(service, freshOrg!.id, "allTime");
    assert.equal(snapshot.revenueOpportunity.qualifiedLeadsWithoutAppointment, 1);
  } finally {
    await service.from("appointments").delete().eq("organization_id", freshOrg!.id);
    await service.from("leads").delete().eq("organization_id", freshOrg!.id);
    await service.from("contacts").delete().eq("organization_id", freshOrg!.id);
    await service.from("organizations").delete().eq("id", freshOrg!.id);
  }
});

test("9. completedAppointmentsWithoutEstimate counts only COMPLETED appointments whose lead has no estimate at all", async () => {
  const { data: freshOrg } = await service.from("organizations").insert({ name: "BI Metrics Test Org (Completed No Estimate)" }).select("id").single();
  try {
    const contactId = await makeContact(freshOrg!.id, "+15555550408");
    const leadNoEstimate = await makeLead(freshOrg!.id, contactId, "estimate");
    const leadWithEstimate = await makeLead(freshOrg!.id, contactId, "estimate");
    await makeAppointment(freshOrg!.id, contactId, leadNoEstimate, "completed");
    await makeAppointment(freshOrg!.id, contactId, leadWithEstimate, "completed");
    await makeEstimate(freshOrg!.id, contactId, leadWithEstimate, "sent", 400);
    // A scheduled (not completed) appointment for a lead with no estimate must never count.
    const leadScheduled = await makeLead(freshOrg!.id, contactId, "appointment");
    await makeAppointment(freshOrg!.id, contactId, leadScheduled, "scheduled");

    const snapshot = await getBusinessMetricsSnapshot(service, freshOrg!.id, "allTime");
    assert.equal(snapshot.revenueOpportunity.completedAppointmentsWithoutEstimate, 1);
  } finally {
    await service.from("estimates").delete().eq("organization_id", freshOrg!.id);
    await service.from("appointments").delete().eq("organization_id", freshOrg!.id);
    await service.from("leads").delete().eq("organization_id", freshOrg!.id);
    await service.from("contacts").delete().eq("organization_id", freshOrg!.id);
    await service.from("organizations").delete().eq("id", freshOrg!.id);
  }
});

test("10. organization isolation: revenue opportunity for organization A never includes organization B's estimates or appointments", async () => {
  const { data: orgA } = await service.from("organizations").insert({ name: "BI Metrics Test Org (Isolation A)" }).select("id").single();
  const { data: orgB } = await service.from("organizations").insert({ name: "BI Metrics Test Org (Isolation B)" }).select("id").single();
  try {
    const contactB = await makeContact(orgB!.id, "+15555550409");
    await makeEstimate(orgB!.id, contactB, null, "sent", 5000);

    const snapshotA = await getBusinessMetricsSnapshot(service, orgA!.id, "allTime");
    assert.equal(snapshotA.revenueOpportunity.openEstimateValue, 0);
  } finally {
    await service.from("estimates").delete().eq("organization_id", orgB!.id);
    await service.from("contacts").delete().eq("organization_id", orgB!.id);
    await service.from("organizations").delete().eq("id", orgA!.id);
    await service.from("organizations").delete().eq("id", orgB!.id);
  }
});

// ==================== Part 4: AI token usage aggregation ====================

async function makeAiInteraction(orgId: string, tokensUsed: number | null, interactionType = "lead_followup_response") {
  await service.from("ai_interactions").insert({ organization_id: orgId, interaction_type: interactionType, input: {}, output: {}, model: "test-model", tokens_used: tokensUsed });
}

test("11. zero ai_interactions: totalTokensUsed/averageTokensPerInteraction are null, interactionsWithUsageData is 0, dataQuality.aiTokenUsageUnavailable is true", async () => {
  const { data: emptyOrg } = await service.from("organizations").insert({ name: "BI Metrics Test Org (No AI)" }).select("id").single();
  try {
    const snapshot = await getBusinessMetricsSnapshot(service, emptyOrg!.id, "allTime");
    assert.equal(snapshot.aiMetrics.totalTokensUsed, null);
    assert.equal(snapshot.aiMetrics.averageTokensPerInteraction, null);
    assert.equal(snapshot.aiMetrics.interactionsWithUsageData, 0);
    assert.equal(snapshot.dataQuality.aiTokenUsageUnavailable, true);
  } finally {
    await service.from("organizations").delete().eq("id", emptyOrg!.id);
  }
});

test("12. interactions exist but none report usage: totalTokensUsed stays null (never a fabricated 0) - missing provider usage is stored as null, not invented", async () => {
  const { data: org } = await service.from("organizations").insert({ name: "BI Metrics Test Org (No Usage Data)" }).select("id").single();
  try {
    await makeAiInteraction(org!.id, null);
    await makeAiInteraction(org!.id, null);

    const snapshot = await getBusinessMetricsSnapshot(service, org!.id, "allTime");
    assert.equal(snapshot.aiMetrics.aiInteractions, 2);
    assert.equal(snapshot.aiMetrics.totalTokensUsed, null);
    assert.equal(snapshot.aiMetrics.interactionsWithUsageData, 0);
    assert.equal(snapshot.dataQuality.aiTokenUsageUnavailable, true);
  } finally {
    await service.from("ai_interactions").delete().eq("organization_id", org!.id);
    await service.from("organizations").delete().eq("id", org!.id);
  }
});

test("13. a mix of interactions with and without usage: totals/averages are computed ONLY over the real data, and interactionsWithUsageData reflects the true count", async () => {
  const { data: org } = await service.from("organizations").insert({ name: "BI Metrics Test Org (Mixed Usage)" }).select("id").single();
  try {
    await makeAiInteraction(org!.id, 100);
    await makeAiInteraction(org!.id, 300);
    await makeAiInteraction(org!.id, null);

    const snapshot = await getBusinessMetricsSnapshot(service, org!.id, "allTime");
    assert.equal(snapshot.aiMetrics.aiInteractions, 3);
    assert.equal(snapshot.aiMetrics.totalTokensUsed, 400);
    assert.equal(snapshot.aiMetrics.averageTokensPerInteraction, 200);
    assert.equal(snapshot.aiMetrics.interactionsWithUsageData, 2);
    assert.equal(snapshot.dataQuality.aiTokenUsageUnavailable, false, "at least one real usage row exists, so this must flip to false");
  } finally {
    await service.from("ai_interactions").delete().eq("organization_id", org!.id);
    await service.from("organizations").delete().eq("id", org!.id);
  }
});

test("14. organization isolation: organization A's token totals never include organization B's ai_interactions", async () => {
  const { data: orgA } = await service.from("organizations").insert({ name: "BI Metrics Test Org (Token Isolation A)" }).select("id").single();
  const { data: orgB } = await service.from("organizations").insert({ name: "BI Metrics Test Org (Token Isolation B)" }).select("id").single();
  try {
    await makeAiInteraction(orgB!.id, 5000);

    const snapshotA = await getBusinessMetricsSnapshot(service, orgA!.id, "allTime");
    assert.equal(snapshotA.aiMetrics.totalTokensUsed, null);
  } finally {
    await service.from("ai_interactions").delete().eq("organization_id", orgB!.id);
    await service.from("organizations").delete().eq("id", orgA!.id);
    await service.from("organizations").delete().eq("id", orgB!.id);
  }
});

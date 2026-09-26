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
const { emitLeadStageChangedAsService }: typeof import("@/lib/automation/lead-stage-history") = require(path.join(REPO_ROOT, "lib/automation/lead-stage-history.ts"));

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

test("11. Pass 3 fix: revenueOpportunity reflects true current state, never scoped down by the caller's requested date range", async () => {
  const { data: freshOrg } = await service.from("organizations").insert({ name: "BI Metrics Test Org (Current State Not Range-Scoped)" }).select("id").single();
  try {
    const contactId = await makeContact(freshOrg!.id, "+15555550410");
    const staleDate = "2020-01-01T00:00:00.000Z"; // far outside any "today" window
    await makeLead(freshOrg!.id, contactId, "qualified", { created_at: staleDate });
    await service.from("estimates").insert({ organization_id: freshOrg!.id, contact_id: contactId, title: "Quote", status: "sent", amount: 750, created_at: staleDate });

    // Requesting "today" must not hide opportunity data created long ago - per MetricTemporality, revenueOpportunity is current-state, not a date-range metric.
    const snapshot = await getBusinessMetricsSnapshot(service, freshOrg!.id, "today");
    assert.equal(snapshot.revenueOpportunity.qualifiedLeadsWithoutAppointment, 1, "a qualified, still-unbooked lead from outside the requested range must still count");
    assert.equal(snapshot.revenueOpportunity.openEstimateValue, 750, "a still-open estimate from outside the requested range must still count");
    // The requested range itself must still genuinely scope leadMetrics - a "today"-scoped call finds zero leads created today.
    assert.equal(snapshot.leadMetrics.totalLeads, 0);
  } finally {
    await service.from("estimates").delete().eq("organization_id", freshOrg!.id);
    await service.from("leads").delete().eq("organization_id", freshOrg!.id);
    await service.from("contacts").delete().eq("organization_id", freshOrg!.id);
    await service.from("organizations").delete().eq("id", freshOrg!.id);
  }
});

// ==================== Part 4: AI token usage aggregation ====================

async function makeAiInteraction(orgId: string, tokensUsed: number | null, interactionType = "lead_followup_response") {
  await service.from("ai_interactions").insert({ organization_id: orgId, interaction_type: interactionType, input: {}, output: {}, model: "test-model", tokens_used: tokensUsed });
}

test("12. zero ai_interactions: totalTokensUsed/averageTokensPerInteraction are null, interactionsWithUsageData is 0, dataQuality.aiTokenUsageUnavailable is true", async () => {
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

test("13. interactions exist but none report usage: totalTokensUsed stays null (never a fabricated 0) - missing provider usage is stored as null, not invented", async () => {
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

test("14. a mix of interactions with and without usage: totals/averages are computed ONLY over the real data, and interactionsWithUsageData reflects the true count", async () => {
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

test("15. organization isolation: organization A's token totals never include organization B's ai_interactions", async () => {
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

// ==================== Pass 5C Batch 3B: leadStageFunnel/responseTime wiring ====================
//
// getBusinessMetricsSnapshot now also computes leadStageFunnel (transitions
// + timing, lib/bi/funnel.ts) and responseTime (same file) - these tests
// prove the wiring itself (the snapshot exposes real, correctly-scoped
// values matching what the underlying, already-independently-tested
// funnel.ts functions produce), not the underlying logic a second time
// (see lib/bi/funnel.integration.test.ts's own 19 tests for that). Each
// test uses its own dedicated, disposable organization - these are
// aggregate, snapshot-wide counts, and the file's own shared
// organizationId/otherOrgId would contaminate an exact-count assertion
// (the same lesson already applied in this pass's dashboard/funnel test
// files).

function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

async function makeConversation(orgId: string, contactId: string) {
  const { data } = await service.from("conversations").insert({ organization_id: orgId, contact_id: contactId, channel: "sms", status: "open" }).select("id").single();
  return data!.id as string;
}

async function makeMessage(orgId: string, conversationId: string, direction: "inbound" | "outbound", status: string, createdAt?: string) {
  const payload: Record<string, unknown> = { organization_id: orgId, conversation_id: conversationId, direction, sender_type: direction === "outbound" ? "ai" : "customer", body: "test", status };
  if (createdAt) payload.created_at = createdAt;
  await service.from("messages").insert(payload);
}

async function cleanupSnapshotOrg(orgId: string) {
  await service.from("messages").delete().eq("organization_id", orgId);
  await service.from("conversations").delete().eq("organization_id", orgId);
  await service.from("workflow_executions").delete().eq("organization_id", orgId);
  await service.from("automation_events").delete().eq("organization_id", orgId);
  await service.from("estimates").delete().eq("organization_id", orgId);
  await service.from("appointments").delete().eq("organization_id", orgId);
  await service.from("leads").delete().eq("organization_id", orgId);
  await service.from("contacts").delete().eq("organization_id", orgId);
  await service.from("organizations").delete().eq("id", orgId);
}

test("16 (A/B/C). the snapshot exposes leadStageFunnel and responseTime, with real values matching the underlying funnel.ts functions", async () => {
  const { data: org } = await service.from("organizations").insert({ name: "BI Metrics Test Org (Batch 3B - 16)" }).select("id").single();
  const orgId = org!.id;
  try {
    const contactId = await makeContact(orgId, "+15555710001");
    const leadCreatedAt = minutesAgoIso(120);
    const leadId = await makeLead(orgId, contactId, "new", { created_at: leadCreatedAt });
    await emitLeadStageChangedAsService(service, orgId, { leadId, previousStatus: null, newStatus: "new", source: "automation" });
    await emitLeadStageChangedAsService(service, orgId, { leadId, previousStatus: "new", newStatus: "qualified", source: "automation" });
    const conversationId = await makeConversation(orgId, contactId);
    await makeMessage(orgId, conversationId, "outbound", "sent", minutesAgoIso(100));

    const snapshot = await getBusinessMetricsSnapshot(service, orgId, "allTime");

    assert.ok(snapshot.leadStageFunnel, "expected leadStageFunnel on the snapshot");
    assert.equal(snapshot.leadStageFunnel.transitions.leadsTransitionedToQualified, 1);
    assert.equal(snapshot.leadStageFunnel.transitions.totalTransitions, 2);
    assert.equal(snapshot.leadStageFunnel.timing.leadsWithRecordedHistory, 1);
    assert.equal(snapshot.leadStageFunnel.timing.leadsWithQualifiedTiming, 1);
    assert.ok(snapshot.leadStageFunnel.timing.averageTimeToQualifiedMs! > 0);

    assert.ok(snapshot.responseTime, "expected responseTime on the snapshot");
    assert.equal(snapshot.responseTime.totalLeadsInPopulation, 1);
    assert.equal(snapshot.responseTime.leadsContacted, 1);
    assert.equal(snapshot.responseTime.leadsNeverContacted, 0);
  } finally {
    await cleanupSnapshotOrg(orgId);
  }
});

test("17 (D). organization isolation: organization A's real transitions/messages never appear in organization B's snapshot", async () => {
  const { data: orgA } = await service.from("organizations").insert({ name: "BI Metrics Test Org (Batch 3B - 17A)" }).select("id").single();
  const { data: orgB } = await service.from("organizations").insert({ name: "BI Metrics Test Org (Batch 3B - 17B)" }).select("id").single();
  try {
    const contactId = await makeContact(orgA!.id, "+15555710002");
    const leadId = await makeLead(orgA!.id, contactId, "new");
    await emitLeadStageChangedAsService(service, orgA!.id, { leadId, previousStatus: "new", newStatus: "qualified", source: "automation" });
    const conversationId = await makeConversation(orgA!.id, contactId);
    await makeMessage(orgA!.id, conversationId, "outbound", "sent");

    const snapshotB = await getBusinessMetricsSnapshot(service, orgB!.id, "allTime");
    assert.equal(snapshotB.leadStageFunnel.transitions.totalTransitions, 0);
    assert.equal(snapshotB.leadStageFunnel.transitions.leadsTransitionedToQualified, 0);
    assert.equal(snapshotB.responseTime.totalLeadsInPopulation, 0);
    assert.equal(snapshotB.responseTime.leadsContacted, 0);
  } finally {
    await cleanupSnapshotOrg(orgA!.id);
    await cleanupSnapshotOrg(orgB!.id);
  }
});

test("18 (E/F). empty population: zero leads never crashes, every average/rate is null, never fabricated", async () => {
  const { data: org } = await service.from("organizations").insert({ name: "BI Metrics Test Org (Batch 3B - 18)" }).select("id").single();
  const orgId = org!.id;
  try {
    const snapshot = await getBusinessMetricsSnapshot(service, orgId, "allTime");

    assert.equal(snapshot.leadStageFunnel.timing.leadsInRange, 0);
    assert.equal(snapshot.leadStageFunnel.timing.averageTimeToQualifiedMs, null);
    assert.equal(snapshot.leadStageFunnel.timing.medianTimeToQualifiedMs, null);
    assert.equal(snapshot.leadStageFunnel.timing.averageTimeToWonMs, null);

    assert.equal(snapshot.responseTime.totalLeadsInPopulation, 0);
    assert.equal(snapshot.responseTime.contactRate, null, "a zero-denominator rate must be null, never a fabricated 0%");
    assert.equal(snapshot.responseTime.averageResponseTimeMs, null);
    assert.equal(snapshot.responseTime.medianResponseTimeMs, null);
  } finally {
    await cleanupSnapshotOrg(orgId);
  }
});

test("18b (F). NULL-safe timing: leads exist but none have a recorded transition - timing averages stay null, never fabricated from the current 'qualified' status", async () => {
  const { data: org } = await service.from("organizations").insert({ name: "BI Metrics Test Org (Batch 3B - 18b)" }).select("id").single();
  const orgId = org!.id;
  try {
    const contactId = await makeContact(orgId, "+15555710003");
    // Inserted directly at 'qualified' status with no emitLeadStageChangedAsService
    // call at all - no automation_events row exists for this lead.
    await makeLead(orgId, contactId, "qualified");

    const snapshot = await getBusinessMetricsSnapshot(service, orgId, "allTime");
    assert.equal(snapshot.leadStageFunnel.timing.leadsInRange, 1);
    assert.equal(snapshot.leadStageFunnel.timing.leadsWithRecordedHistory, 0);
    assert.equal(snapshot.leadStageFunnel.timing.leadsWithQualifiedTiming, 0);
    assert.equal(snapshot.leadStageFunnel.timing.averageTimeToQualifiedMs, null);
  } finally {
    await cleanupSnapshotOrg(orgId);
  }
});

test("19 (G/H/I). leadsTransitionedToQualified/leadsTransitionedToWon/leadsContacted comparisons reflect current vs. previous equivalent period", async () => {
  const { data: org } = await service.from("organizations").insert({ name: "BI Metrics Test Org (Batch 3B - 19)" }).select("id").single();
  const orgId = org!.id;
  try {
    // Previous period: a lead created ~45 days ago, transitioned to
    // qualified at that time, and successfully contacted then.
    const previousContact = await makeContact(orgId, "+15555710004");
    const previousLeadCreatedAt = minutesAgoIso(45 * 24 * 60);
    const previousLeadId = await makeLead(orgId, previousContact, "new", { created_at: previousLeadCreatedAt });
    await emitLeadStageChangedAsService(service, orgId, { leadId: previousLeadId, previousStatus: "new", newStatus: "qualified", source: "automation" });
    // emitLeadStageChangedAsService always timestamps the real transition
    // event at "now" (a genuine, real-time recording - there is no
    // backdating parameter on the real function, by design). To simulate a
    // transition that genuinely happened 45 days ago for this test, the
    // resulting automation_events row's own created_at is backdated
    // directly afterward - automation_events carries no BEFORE UPDATE
    // trigger protecting created_at (unlike appointments.updated_at), so
    // this update is not silently overwritten.
    await service.from("automation_events").update({ created_at: minutesAgoIso(45 * 24 * 60) }).eq("organization_id", orgId).eq("entity_id", previousLeadId).eq("event_type", "lead.stage_changed");
    const previousConversationId = await makeConversation(orgId, previousContact);
    await makeMessage(orgId, previousConversationId, "outbound", "sent", minutesAgoIso(45 * 24 * 60 - 10));

    // Current period: two leads, both created within the last day and
    // transitioned to qualified, one also transitioned to won, both
    // successfully contacted.
    const currentContactA = await makeContact(orgId, "+15555710005");
    const currentLeadA = await makeLead(orgId, currentContactA, "new", { created_at: minutesAgoIso(60) });
    await emitLeadStageChangedAsService(service, orgId, { leadId: currentLeadA, previousStatus: "new", newStatus: "qualified", source: "automation" });
    await emitLeadStageChangedAsService(service, orgId, { leadId: currentLeadA, previousStatus: "qualified", newStatus: "won", source: "automation", idempotencySuffix: "est-1" });
    const conversationA = await makeConversation(orgId, currentContactA);
    await makeMessage(orgId, conversationA, "outbound", "sent", minutesAgoIso(50));

    const currentContactB = await makeContact(orgId, "+15555710006");
    const currentLeadB = await makeLead(orgId, currentContactB, "new", { created_at: minutesAgoIso(30) });
    await emitLeadStageChangedAsService(service, orgId, { leadId: currentLeadB, previousStatus: "new", newStatus: "qualified", source: "automation" });
    const conversationB = await makeConversation(orgId, currentContactB);
    await makeMessage(orgId, conversationB, "outbound", "sent", minutesAgoIso(20));

    const snapshot = await getBusinessMetricsSnapshot(service, orgId, "last7Days");

    assert.equal(snapshot.comparisons.leadsTransitionedToQualified.current, 2, "2 leads qualified in the current (last 7 days) period");
    assert.equal(snapshot.comparisons.leadsTransitionedToWon.current, 1);
    assert.equal(snapshot.comparisons.leadsContacted.current, 2);
    // The previous-period lead/transition/message all sit ~45 days ago -
    // well outside last7Days' own previous-equivalent-period window (the
    // 7 days immediately before the current 7-day window) - so the
    // previous counts for this specific comparison are correctly 0, not
    // the ~45-day-old activity above. This proves the comparison is
    // genuinely period-scoped, not merely "any earlier activity."
    assert.equal(snapshot.comparisons.leadsTransitionedToQualified.previous, 0);
    assert.equal(snapshot.comparisons.leadsTransitionedToWon.previous, 0);
    assert.equal(snapshot.comparisons.leadsContacted.previous, 0);
  } finally {
    await cleanupSnapshotOrg(orgId);
  }
});

test("20 (J). open-ended range (allTime): all three new comparisons have previous:null, matching the existing leadCount/estimateCount/jobCount behavior", async () => {
  const { data: org } = await service.from("organizations").insert({ name: "BI Metrics Test Org (Batch 3B - 20)" }).select("id").single();
  const orgId = org!.id;
  try {
    const contactId = await makeContact(orgId, "+15555710007");
    const leadId = await makeLead(orgId, contactId, "new");
    await emitLeadStageChangedAsService(service, orgId, { leadId, previousStatus: "new", newStatus: "qualified", source: "automation" });

    const snapshot = await getBusinessMetricsSnapshot(service, orgId, "allTime");

    assert.equal(snapshot.comparisons.leadCount.previous, null, "existing behavior: allTime has no previous period");
    assert.equal(snapshot.comparisons.leadsTransitionedToQualified.previous, null);
    assert.equal(snapshot.comparisons.leadsTransitionedToWon.previous, null);
    assert.equal(snapshot.comparisons.leadsContacted.previous, null);
    assert.equal(snapshot.comparisons.leadsTransitionedToQualified.percentageChange, null);
  } finally {
    await cleanupSnapshotOrg(orgId);
  }
});

test("21 (K). the data-quality note contains the precise partial-history coverage warning, with the real counts", async () => {
  const { data: org } = await service.from("organizations").insert({ name: "BI Metrics Test Org (Batch 3B - 21)" }).select("id").single();
  const orgId = org!.id;
  try {
    const contactA = await makeContact(orgId, "+15555710008");
    const leadA = await makeLead(orgId, contactA, "new");
    await emitLeadStageChangedAsService(service, orgId, { leadId: leadA, previousStatus: "new", newStatus: "qualified", source: "automation" });
    // A second lead with NO recorded transition - partial coverage.
    const contactB = await makeContact(orgId, "+15555710009");
    await makeLead(orgId, contactB, "new");

    const snapshot = await getBusinessMetricsSnapshot(service, orgId, "allTime");

    assert.equal(snapshot.dataQuality.stageHistoryUnavailable, false, "at least one real transition exists, so the flag itself is correctly false");
    const coverageNote = snapshot.dataQuality.notes.find((note) => note.includes("Historical stage timing"));
    assert.ok(coverageNote, "expected a data-quality note describing historical stage timing coverage");
    assert.ok(coverageNote!.includes("1 of 2"), `expected the note to state the real coverage fraction (1 of 2), got: ${coverageNote}`);
    // The note is allowed to contain the word "complete" as part of an
    // explicit NEGATION ("not a complete historical record") - what must
    // never appear is an affirmative claim of completeness.
    assert.ok(!/\bis a complete\b|\bfully complete\b|\bcomplete coverage\b/i.test(coverageNote!), `must never affirmatively claim complete coverage, got: ${coverageNote}`);
    assert.ok(coverageNote!.toLowerCase().includes("not a complete"), "must explicitly state coverage is not complete");
  } finally {
    await cleanupSnapshotOrg(orgId);
  }
});

test("22 (L). the consolidated shared-leads fetch produces identical results to calling the underlying funnel.ts functions directly", async () => {
  const { data: org } = await service.from("organizations").insert({ name: "BI Metrics Test Org (Batch 3B - 22)" }).select("id").single();
  const orgId = org!.id;
  try {
    const contactId = await makeContact(orgId, "+15555710010");
    const leadId = await makeLead(orgId, contactId, "new", { created_at: minutesAgoIso(90) });
    await emitLeadStageChangedAsService(service, orgId, { leadId, previousStatus: "new", newStatus: "qualified", source: "automation" });
    const conversationId = await makeConversation(orgId, contactId);
    await makeMessage(orgId, conversationId, "outbound", "sent", minutesAgoIso(80));

    const require2 = createRequire(path.join(REPO_ROOT, "package.json"));
    const { getLeadsForRange, getLeadStageTimingMetrics, getLeadResponseTimeMetrics }: typeof import("./funnel") = require2(path.join(REPO_ROOT, "lib/bi/funnel.ts"));
    const { resolveDateRange }: typeof import("./queries") = require2(path.join(REPO_ROOT, "lib/bi/queries.ts"));

    const range = resolveDateRange("allTime");
    const sharedLeads = await getLeadsForRange(service, orgId, range);
    const directTiming = await getLeadStageTimingMetrics(service, orgId, sharedLeads);
    const directResponseTime = await getLeadResponseTimeMetrics(service, orgId, sharedLeads);

    const snapshot = await getBusinessMetricsSnapshot(service, orgId, "allTime");

    assert.deepEqual(snapshot.leadStageFunnel.timing, directTiming, "the snapshot's own timing metrics must exactly match calling the underlying function directly with the same shared leads");
    assert.deepEqual(snapshot.responseTime, directResponseTime, "the snapshot's own response-time metrics must exactly match calling the underlying function directly");
  } finally {
    await cleanupSnapshotOrg(orgId);
  }
});

// ==================== Phase 4B, P1 #1: pipeline is current-state ====================
//
// Real-database proof (unlike lib/bi/queries.partial-data.test.ts's mocked
// unit tests) that an open lead genuinely created outside the requested
// date range still counts toward pipelineMetrics.pipelineValue/
// openOpportunityCount - the exact verified bug this phase fixes.

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

test("P1 #1: an open lead created 90 days ago still counts toward pipeline value and open opportunity count under the 'today' range", async () => {
  const { data: org } = await service.from("organizations").insert({ name: "BI Metrics Test Org (P1-1 Pipeline)" }).select("id").single();
  const orgId = org!.id;
  try {
    const contactId = await makeContact(orgId, "+15555720001");
    await makeLead(orgId, contactId, "qualified", { estimated_value: 8000, created_at: daysAgoIso(90) });

    const snapshot = await getBusinessMetricsSnapshot(service, orgId, "today");

    assert.equal(snapshot.pipelineMetrics.pipelineValue, 8000, "pipeline value must include an open lead regardless of when it was created - Pipeline is current-state, never a date-range question");
    assert.equal(snapshot.pipelineMetrics.openOpportunityCount, 1);
  } finally {
    await cleanupSnapshotOrg(orgId);
  }
});

test("P1 #1: pipeline excludes a lead created 90 days ago once it reaches a terminal (won/lost) status, exactly as it would if created today", async () => {
  const { data: org } = await service.from("organizations").insert({ name: "BI Metrics Test Org (P1-1 Terminal)" }).select("id").single();
  const orgId = org!.id;
  try {
    const contactId = await makeContact(orgId, "+15555720002");
    await makeLead(orgId, contactId, "won", { estimated_value: 9000, created_at: daysAgoIso(90) });
    await makeLead(orgId, contactId, "lost", { estimated_value: 4000, created_at: daysAgoIso(90) });

    const snapshot = await getBusinessMetricsSnapshot(service, orgId, "today");

    assert.equal(snapshot.pipelineMetrics.pipelineValue, 0, "a won/lost lead is not open pipeline regardless of its age - this fix only removes the date-range filter, it never changes which STATUSES count as open");
    assert.equal(snapshot.pipelineMetrics.openOpportunityCount, 0);
  } finally {
    await cleanupSnapshotOrg(orgId);
  }
});

test("P1 #1: legitimately period-scoped lead metrics (newLeads, totalLeads) remain scoped to the requested range - unaffected by the pipeline fix", async () => {
  const { data: org } = await service.from("organizations").insert({ name: "BI Metrics Test Org (P1-1 Period Scope)" }).select("id").single();
  const orgId = org!.id;
  try {
    const contactId = await makeContact(orgId, "+15555720003");
    // Old, outside 'today' - must still count toward pipeline (proven above) but must NOT count toward today's newLeads/totalLeads.
    await makeLead(orgId, contactId, "qualified", { estimated_value: 5000, created_at: daysAgoIso(90) });
    // Created today - must count toward today's newLeads/totalLeads.
    const todayLeadId = await makeLead(orgId, contactId, "new", { estimated_value: 1000 });
    void todayLeadId;

    const snapshot = await getBusinessMetricsSnapshot(service, orgId, "today");

    assert.equal(snapshot.leadMetrics.totalLeads, 1, "the 90-day-old lead must not count toward today's totalLeads - that remains a genuinely period-scoped question");
    assert.equal(snapshot.leadMetrics.newLeads, 1);
    // Both leads are open, so pipeline (current-state, unbounded) reflects both.
    assert.equal(snapshot.pipelineMetrics.pipelineValue, 6000);
    assert.equal(snapshot.pipelineMetrics.openOpportunityCount, 2);
  } finally {
    await cleanupSnapshotOrg(orgId);
  }
});

test("P1 #1: organization isolation - organization B's open pipeline never appears in organization A's pipelineMetrics", async () => {
  const { data: orgA } = await service.from("organizations").insert({ name: "BI Metrics Test Org (P1-1 Isolation A)" }).select("id").single();
  const { data: orgB } = await service.from("organizations").insert({ name: "BI Metrics Test Org (P1-1 Isolation B)" }).select("id").single();
  try {
    const contactB = await makeContact(orgB!.id, "+15555720004");
    await makeLead(orgB!.id, contactB, "qualified", { estimated_value: 7000, created_at: daysAgoIso(90) });

    const snapshotA = await getBusinessMetricsSnapshot(service, orgA!.id, "today");
    assert.equal(snapshotA.pipelineMetrics.pipelineValue, 0);
    assert.equal(snapshotA.pipelineMetrics.openOpportunityCount, 0);
  } finally {
    await cleanupSnapshotOrg(orgB!.id);
    await service.from("organizations").delete().eq("id", orgA!.id);
  }
});

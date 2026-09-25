/**
 * Pass 5C, Batch 3A: integration tests for lib/bi/funnel.ts - the historical
 * lead-stage funnel (Part C, built on lib/automation/lead-stage-history.ts's
 * existing lead.stage_changed events) and lead response-time intelligence
 * (Part D, built on the exact evidence hierarchy Pass 5C Batch 2's
 * uncontacted_lead opportunity detector already established). Real,
 * disposable Supabase fixtures against the real project.
 *
 * Each test uses its OWN dedicated, disposable organization rather than one
 * shared org - these functions compute organization-wide aggregate counts
 * scoped by a date range, and a shared org would make exact-count
 * assertions measure cross-test contamination instead of the behavior under
 * test (the exact bug found and fixed in this same pass's dashboard tests -
 * see lib/dashboard/queries.integration.test.ts's own Batch 3A section).
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/bi/funnel.integration.test.ts
 */
import { test } from "node:test";
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
const { emitLeadStageChangedAsService }: typeof import("@/lib/automation/lead-stage-history") = require(path.join(REPO_ROOT, "lib/automation/lead-stage-history.ts"));
const { getLeadStageTransitionMetrics, getLeadStageTimingMetrics, hasAnyLeadStageHistory, getLeadResponseTimeMetrics }: typeof import("./funnel") = require(path.join(REPO_ROOT, "lib/bi/funnel.ts"));

const service = createServiceRoleClient();

const ALL_TIME = { label: "all time", from: null as string | null, to: null as string | null };

async function makeOrg(name: string) {
  const { data } = await service.from("organizations").insert({ name }).select("id").single();
  return data!.id as string;
}

async function makeContact(orgId: string, phone: string) {
  const { data } = await service.from("contacts").insert({ organization_id: orgId, phone }).select("id").single();
  return data!.id as string;
}

async function makeLead(orgId: string, contactId: string, status: string, createdAt?: string) {
  const payload: Record<string, unknown> = { organization_id: orgId, contact_id: contactId, status, temperature: "warm", source: "website" };
  if (createdAt) payload.created_at = createdAt;
  const { data } = await service.from("leads").insert(payload).select("id").single();
  return data!.id as string;
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

function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

async function cleanupOrg(orgId: string) {
  await service.from("messages").delete().eq("organization_id", orgId);
  await service.from("conversations").delete().eq("organization_id", orgId);
  await service.from("workflow_executions").delete().eq("organization_id", orgId);
  await service.from("automation_events").delete().eq("organization_id", orgId);
  await service.from("leads").delete().eq("organization_id", orgId);
  await service.from("contacts").delete().eq("organization_id", orgId);
  await service.from("organizations").delete().eq("id", orgId);
}

// ==================== Part C: historical lead-stage funnel ====================

test("C1. a real recorded transition is counted in transitionCounts and contributes real timing", async () => {
  const orgId = await makeOrg("BI Funnel Test Org (C1)");
  try {
    const contactId = await makeContact(orgId, "+15555700001");
    const leadCreatedAt = minutesAgoIso(120);
    const leadId = await makeLead(orgId, contactId, "new", leadCreatedAt);
    await emitLeadStageChangedAsService(service, orgId, { leadId, previousStatus: null, newStatus: "new", source: "automation" });
    await emitLeadStageChangedAsService(service, orgId, { leadId, previousStatus: "new", newStatus: "qualified", source: "automation" });

    const transitions = await getLeadStageTransitionMetrics(service, orgId, ALL_TIME);
    assert.equal(transitions.totalTransitions, 2);
    assert.equal(transitions.leadsTransitionedToQualified, 1);
    assert.equal(transitions.transitionCounts["new->qualified"], 1);

    const timing = await getLeadStageTimingMetrics(service, orgId, ALL_TIME);
    assert.equal(timing.leadsInRange, 1);
    assert.equal(timing.leadsWithRecordedHistory, 1);
    assert.equal(timing.leadsWithQualifiedTiming, 1);
    assert.ok(timing.averageTimeToQualifiedMs! > 0, "expected a real, positive elapsed duration");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("C2. the transition's own recorded timestamp is preserved and used for timing - not the current wall clock", async () => {
  const orgId = await makeOrg("BI Funnel Test Org (C2)");
  try {
    const contactId = await makeContact(orgId, "+15555700002");
    const leadId = await makeLead(orgId, contactId, "new", minutesAgoIso(60));
    await emitLeadStageChangedAsService(service, orgId, { leadId, previousStatus: null, newStatus: "new", source: "automation" });
    await emitLeadStageChangedAsService(service, orgId, { leadId, previousStatus: "new", newStatus: "qualified", source: "automation" });

    const timing = await getLeadStageTimingMetrics(service, orgId, ALL_TIME);
    // Real elapsed time is roughly 60 minutes (the lead's own backdated
    // created_at to "now", when the transition was actually recorded) -
    // bounded loosely to allow for real test execution time, never exactly
    // 0 (which would indicate the timestamp was ignored/recomputed fresh).
    assert.ok(timing.averageTimeToQualifiedMs! > 59 * 60 * 1000 && timing.averageTimeToQualifiedMs! < 61 * 60 * 1000, `expected ~60 minutes, got ${timing.averageTimeToQualifiedMs}ms`);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("C3. multiple transitions across multiple leads are all counted correctly", async () => {
  const orgId = await makeOrg("BI Funnel Test Org (C3)");
  try {
    const contactA = await makeContact(orgId, "+15555700003");
    const contactB = await makeContact(orgId, "+15555700004");
    const leadA = await makeLead(orgId, contactA, "won");
    const leadB = await makeLead(orgId, contactB, "qualified");

    await emitLeadStageChangedAsService(service, orgId, { leadId: leadA, previousStatus: null, newStatus: "new", source: "automation" });
    await emitLeadStageChangedAsService(service, orgId, { leadId: leadA, previousStatus: "new", newStatus: "qualified", source: "automation" });
    await emitLeadStageChangedAsService(service, orgId, { leadId: leadA, previousStatus: "qualified", newStatus: "won", source: "automation", idempotencySuffix: "est-1" });
    await emitLeadStageChangedAsService(service, orgId, { leadId: leadB, previousStatus: null, newStatus: "new", source: "automation" });
    await emitLeadStageChangedAsService(service, orgId, { leadId: leadB, previousStatus: "new", newStatus: "qualified", source: "automation" });

    const transitions = await getLeadStageTransitionMetrics(service, orgId, ALL_TIME);
    assert.equal(transitions.totalTransitions, 5);
    assert.equal(transitions.leadsTransitionedToQualified, 2);
    assert.equal(transitions.leadsTransitionedToWon, 1);

    const hasHistory = await hasAnyLeadStageHistory(service, orgId, ALL_TIME);
    assert.equal(hasHistory, true);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("C4. a lead with NO recorded transition contributes to the population but NEVER a fabricated timing - even when its current status IS 'qualified'", async () => {
  const orgId = await makeOrg("BI Funnel Test Org (C4)");
  try {
    const contactId = await makeContact(orgId, "+15555700005");
    // Inserted directly with status='qualified' and an old created_at,
    // deliberately bypassing emitLeadStageChangedAsService entirely - no
    // automation_events row is ever created for this lead.
    await makeLead(orgId, contactId, "qualified", minutesAgoIso(500));

    const timing = await getLeadStageTimingMetrics(service, orgId, ALL_TIME);
    assert.equal(timing.leadsInRange, 1);
    assert.equal(timing.leadsWithRecordedHistory, 0, "no automation_events row exists for this lead, so it must never be counted as having history");
    assert.equal(timing.leadsWithQualifiedTiming, 0, "must never infer a qualified timestamp from the lead's current status");
    assert.equal(timing.averageTimeToQualifiedMs, null, "must stay null, never fabricated from leads.updated_at or leads.created_at alone");

    const hasHistory = await hasAnyLeadStageHistory(service, orgId, ALL_TIME);
    assert.equal(hasHistory, false);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("C5. organization isolation: organization A's real transitions never appear in organization B's funnel metrics", async () => {
  const orgA = await makeOrg("BI Funnel Test Org (C5-A)");
  const orgB = await makeOrg("BI Funnel Test Org (C5-B)");
  try {
    const contactId = await makeContact(orgA, "+15555700006");
    const leadId = await makeLead(orgA, contactId, "qualified");
    await emitLeadStageChangedAsService(service, orgA, { leadId, previousStatus: "new", newStatus: "qualified", source: "automation" });

    const transitionsB = await getLeadStageTransitionMetrics(service, orgB, ALL_TIME);
    assert.equal(transitionsB.totalTransitions, 0);
    assert.equal(transitionsB.leadsTransitionedToQualified, 0);

    const hasHistoryB = await hasAnyLeadStageHistory(service, orgB, ALL_TIME);
    assert.equal(hasHistoryB, false);
  } finally {
    await cleanupOrg(orgA);
    await cleanupOrg(orgB);
  }
});

// ==================== Part D: lead response-time intelligence ====================

test("D1. an immediate (under 1 minute) response is bucketed correctly", async () => {
  const orgId = await makeOrg("BI Funnel Test Org (D1)");
  try {
    const contactId = await makeContact(orgId, "+15555700101");
    const leadCreatedAt = minutesAgoIso(10);
    await makeLead(orgId, contactId, "new", leadCreatedAt);
    const conversationId = await makeConversation(orgId, contactId);
    await makeMessage(orgId, conversationId, "outbound", "sent", minutesAgoIso(9.75));

    const metrics = await getLeadResponseTimeMetrics(service, orgId, ALL_TIME);
    assert.equal(metrics.leadsContacted, 1);
    assert.equal(metrics.bucketCounts.under_1_min, 1);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("D2. a several-minute response lands in the 1-5 minute bucket", async () => {
  const orgId = await makeOrg("BI Funnel Test Org (D2)");
  try {
    const contactId = await makeContact(orgId, "+15555700102");
    const leadCreatedAt = minutesAgoIso(30);
    await makeLead(orgId, contactId, "new", leadCreatedAt);
    const conversationId = await makeConversation(orgId, contactId);
    await makeMessage(orgId, conversationId, "outbound", "sent", minutesAgoIso(27));

    const metrics = await getLeadResponseTimeMetrics(service, orgId, ALL_TIME);
    assert.equal(metrics.bucketCounts["1_to_5_min"], 1);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("D3. an hour-level response lands in the 15-60 minute bucket", async () => {
  const orgId = await makeOrg("BI Funnel Test Org (D3)");
  try {
    const contactId = await makeContact(orgId, "+15555700103");
    const leadCreatedAt = minutesAgoIso(120);
    await makeLead(orgId, contactId, "new", leadCreatedAt);
    const conversationId = await makeConversation(orgId, contactId);
    await makeMessage(orgId, conversationId, "outbound", "sent", minutesAgoIso(90));

    const metrics = await getLeadResponseTimeMetrics(service, orgId, ALL_TIME);
    assert.equal(metrics.bucketCounts["15_to_60_min"], 1);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("D4. a response after more than 24 hours lands in the over_24_hours bucket", async () => {
  const orgId = await makeOrg("BI Funnel Test Org (D4)");
  try {
    const contactId = await makeContact(orgId, "+15555700104");
    // Lead created 30 hours ago; the response arrives 5 hours ago - a real
    // ~25-hour gap, past the 24-hour bucket boundary.
    const leadCreatedAt = minutesAgoIso(60 * 30);
    await makeLead(orgId, contactId, "new", leadCreatedAt);
    const conversationId = await makeConversation(orgId, contactId);
    await makeMessage(orgId, conversationId, "outbound", "sent", minutesAgoIso(60 * 5));

    const metrics = await getLeadResponseTimeMetrics(service, orgId, ALL_TIME);
    assert.equal(metrics.bucketCounts.over_24_hours, 1);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("D5. a lead with no outbound message at all is never contacted", async () => {
  const orgId = await makeOrg("BI Funnel Test Org (D5)");
  try {
    const contactId = await makeContact(orgId, "+15555700105");
    await makeLead(orgId, contactId, "new");

    const metrics = await getLeadResponseTimeMetrics(service, orgId, ALL_TIME);
    assert.equal(metrics.leadsContacted, 0);
    assert.equal(metrics.leadsNeverContacted, 1);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("D6. a QUEUED-only outbound message never counts as contact", async () => {
  const orgId = await makeOrg("BI Funnel Test Org (D6)");
  try {
    const contactId = await makeContact(orgId, "+15555700106");
    await makeLead(orgId, contactId, "new");
    const conversationId = await makeConversation(orgId, contactId);
    await makeMessage(orgId, conversationId, "outbound", "queued");

    const metrics = await getLeadResponseTimeMetrics(service, orgId, ALL_TIME);
    assert.equal(metrics.leadsContacted, 0);
    assert.equal(metrics.leadsNeverContacted, 1);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("D7. a FAILED-only outbound message never counts as contact - an attempt is not contact", async () => {
  const orgId = await makeOrg("BI Funnel Test Org (D7)");
  try {
    const contactId = await makeContact(orgId, "+15555700107");
    await makeLead(orgId, contactId, "new");
    const conversationId = await makeConversation(orgId, contactId);
    await makeMessage(orgId, conversationId, "outbound", "failed");

    const metrics = await getLeadResponseTimeMetrics(service, orgId, ALL_TIME);
    assert.equal(metrics.leadsContacted, 0);
    assert.equal(metrics.leadsNeverContacted, 1);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("D8. a DELIVERED outbound message counts as successful contact", async () => {
  const orgId = await makeOrg("BI Funnel Test Org (D8)");
  try {
    const contactId = await makeContact(orgId, "+15555700108");
    const leadCreatedAt = minutesAgoIso(20);
    await makeLead(orgId, contactId, "new", leadCreatedAt);
    const conversationId = await makeConversation(orgId, contactId);
    await makeMessage(orgId, conversationId, "outbound", "delivered", minutesAgoIso(18));

    const metrics = await getLeadResponseTimeMetrics(service, orgId, ALL_TIME);
    assert.equal(metrics.leadsContacted, 1);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("D9. multiple outbound messages use the FIRST successful one, not a later one", async () => {
  const orgId = await makeOrg("BI Funnel Test Org (D9)");
  try {
    const contactId = await makeContact(orgId, "+15555700109");
    const leadCreatedAt = minutesAgoIso(60);
    await makeLead(orgId, contactId, "new", leadCreatedAt);
    const conversationId = await makeConversation(orgId, contactId);
    await makeMessage(orgId, conversationId, "outbound", "failed", minutesAgoIso(55));
    await makeMessage(orgId, conversationId, "outbound", "sent", minutesAgoIso(50));
    await makeMessage(orgId, conversationId, "outbound", "sent", minutesAgoIso(10));

    const metrics = await getLeadResponseTimeMetrics(service, orgId, ALL_TIME);
    assert.equal(metrics.leadsContacted, 1);
    // ~10 minutes from creation (60) to the first SUCCESSFUL send (50) - not
    // the failed attempt at 55, and not the second successful send at 10.
    assert.ok(metrics.averageResponseTimeMs! > 9 * 60 * 1000 && metrics.averageResponseTimeMs! < 11 * 60 * 1000, `expected ~10 minutes, got ${metrics.averageResponseTimeMs}ms`);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("D10. an inbound message alone never counts as outbound contact", async () => {
  const orgId = await makeOrg("BI Funnel Test Org (D10)");
  try {
    const contactId = await makeContact(orgId, "+15555700110");
    await makeLead(orgId, contactId, "new");
    const conversationId = await makeConversation(orgId, contactId);
    await makeMessage(orgId, conversationId, "inbound", "received");

    const metrics = await getLeadResponseTimeMetrics(service, orgId, ALL_TIME);
    assert.equal(metrics.leadsContacted, 0);
    assert.equal(metrics.leadsNeverContacted, 1);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("D11. organization isolation: organization A's real successful outbound message never counts toward organization B's response-time metrics", async () => {
  const orgA = await makeOrg("BI Funnel Test Org (D11-A)");
  const orgB = await makeOrg("BI Funnel Test Org (D11-B)");
  try {
    const contactA = await makeContact(orgA, "+15555700111");
    await makeLead(orgA, contactA, "new");
    const conversationA = await makeConversation(orgA, contactA);
    await makeMessage(orgA, conversationA, "outbound", "sent");

    const contactB = await makeContact(orgB, "+15555700112");
    await makeLead(orgB, contactB, "new");

    const metricsB = await getLeadResponseTimeMetrics(service, orgB, ALL_TIME);
    assert.equal(metricsB.totalLeadsInPopulation, 1);
    assert.equal(metricsB.leadsContacted, 0, "organization A's message must never count toward organization B's population");
  } finally {
    await cleanupOrg(orgA);
    await cleanupOrg(orgB);
  }
});

test("D12. date boundary: leads.created_at is scoped [from, to) - a lead exactly at `to` is excluded, a lead exactly at `from` is included", async () => {
  const orgId = await makeOrg("BI Funnel Test Org (D12)");
  try {
    const contact1 = await makeContact(orgId, "+15555700113");
    const contact2 = await makeContact(orgId, "+15555700114");
    const fromIso = "2027-04-01T00:00:00.000Z";
    const toIso = "2027-04-02T00:00:00.000Z";
    await makeLead(orgId, contact1, "new", fromIso);
    await makeLead(orgId, contact2, "new", toIso);

    const metrics = await getLeadResponseTimeMetrics(service, orgId, { label: "custom", from: fromIso, to: toIso });
    assert.equal(metrics.totalLeadsInPopulation, 1, "the lead created exactly at `from` must be included, and the one exactly at `to` must be excluded");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("D13. empty population: zero leads in range never crashes and returns real zeroed/null values", async () => {
  const orgId = await makeOrg("BI Funnel Test Org (D13)");
  try {
    const metrics = await getLeadResponseTimeMetrics(service, orgId, ALL_TIME);
    assert.equal(metrics.totalLeadsInPopulation, 0);
    assert.equal(metrics.leadsContacted, 0);
    assert.equal(metrics.leadsNeverContacted, 0);
    assert.equal(metrics.contactRate, null, "a zero-denominator rate must be null, never a fabricated 0%");
    assert.equal(metrics.averageResponseTimeMs, null);
    assert.equal(metrics.medianResponseTimeMs, null);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("D14. NULL-safe metrics: averageResponseTimeMs/medianResponseTimeMs stay null when leadsContacted is 0, even with real leads present", async () => {
  const orgId = await makeOrg("BI Funnel Test Org (D14)");
  try {
    const contactId = await makeContact(orgId, "+15555700115");
    await makeLead(orgId, contactId, "new");

    const metrics = await getLeadResponseTimeMetrics(service, orgId, ALL_TIME);
    assert.equal(metrics.totalLeadsInPopulation, 1);
    assert.equal(metrics.leadsContacted, 0);
    assert.equal(metrics.averageResponseTimeMs, null);
    assert.equal(metrics.medianResponseTimeMs, null);
    assert.deepEqual(metrics.bucketCounts, { under_1_min: 0, "1_to_5_min": 0, "5_to_15_min": 0, "15_to_60_min": 0, "1_to_24_hours": 0, over_24_hours: 0 });
  } finally {
    await cleanupOrg(orgId);
  }
});

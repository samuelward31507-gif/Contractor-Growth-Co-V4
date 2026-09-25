/**
 * Pass 5C, Batch 2: integration tests for the uncontacted_lead opportunity
 * detector - real, disposable Supabase fixtures against the real project
 * (service-role client), mirroring
 * lib/opportunities/detect.review-rebooking.integration.test.ts's own
 * established pattern exactly (per-test org, try/finally cleanup,
 * detectAllOpportunityCandidates/syncOpportunities called directly).
 *
 * REQUIRES supabase/migrations/20260925090000_opportunities_uncontacted_lead_type.sql.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/opportunities/detect.uncontacted-lead.integration.test.ts
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
const { syncOpportunities, detectAllOpportunityCandidates }: typeof import("./detect") = require(path.join(REPO_ROOT, "lib/opportunities/detect.ts"));

const service = createServiceRoleClient();

/** eligible = automation_mode 'live', payment_status 'active', automation_paused false - the baseline "happy path" org for this detector, matching evaluateOutboundGate's own required checks exactly. */
async function makeOrg(name: string, overrides: { automationMode?: string; paymentStatus?: string; automationPaused?: boolean } = {}) {
  const { data } = await service
    .from("organizations")
    .insert({
      name,
      automation_mode: overrides.automationMode ?? "live",
      payment_status: overrides.paymentStatus ?? "active",
      automation_paused: overrides.automationPaused ?? false,
    })
    .select("id")
    .single();
  return data!.id as string;
}

async function makeContact(orgId: string, phone: string, smsOptOut = false) {
  const { data } = await service.from("contacts").insert({ organization_id: orgId, phone, sms_opt_out: smsOptOut }).select("id").single();
  return data!.id as string;
}

function hoursAgoIso(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

/** created_at, when given, is safe to set at insert time - leads carries no BEFORE UPDATE trigger touching it, and this is never followed by an UPDATE in these fixtures. */
async function makeLead(orgId: string, contactId: string, opts: { status?: string; createdAt?: string; estimatedValue?: number | null } = {}) {
  const payload: Record<string, unknown> = {
    organization_id: orgId,
    contact_id: contactId,
    status: opts.status ?? "new",
    temperature: "warm",
    source: "website",
    estimated_value: opts.estimatedValue ?? null,
  };
  if (opts.createdAt) payload.created_at = opts.createdAt;
  const { data } = await service.from("leads").insert(payload).select("id").single();
  return data!.id as string;
}

async function makeConversation(orgId: string, contactId: string, status = "open") {
  const { data } = await service.from("conversations").insert({ organization_id: orgId, contact_id: contactId, channel: "sms", status }).select("id").single();
  return data!.id as string;
}

async function makeMessage(orgId: string, conversationId: string, direction: "inbound" | "outbound", status: string) {
  await service.from("messages").insert({ organization_id: orgId, conversation_id: conversationId, direction, sender_type: direction === "outbound" ? "ai" : "customer", body: "test", status });
}

/** Fixture for tests 8/9 - a real automation_events + workflow_executions row (inserted directly, bypassing the auth-required RPC, matching how the existing opportunities RLS test file inserts rows directly for fixture purposes) with no message ever created - proves workflow/AI evidence alone is never treated as contact. */
async function makeDispatchedButUnsentExecution(orgId: string, leadId: string) {
  const { data: event } = await service
    .from("automation_events")
    .insert({ organization_id: orgId, event_type: "lead.created", entity_type: "lead", entity_id: leadId, status: "completed", payload: { lead_id: leadId } })
    .select("id")
    .single();
  await service
    .from("workflow_executions")
    .insert({ organization_id: orgId, automation_event_id: event!.id, workflow_name: "lead_created_followup", status: "completed", metadata: { should_send: false, qualification_status: "qualifying" } });
}

async function setAutomationEnabled(orgId: string, automationId: string, enabled: boolean) {
  await service.from("automation_settings").upsert({ organization_id: orgId, automation_id: automationId, enabled }, { onConflict: "organization_id,automation_id" });
}

async function cleanupOrg(orgId: string) {
  await service.from("opportunities").delete().eq("organization_id", orgId);
  await service.from("workflow_executions").delete().eq("organization_id", orgId);
  await service.from("automation_events").delete().eq("organization_id", orgId);
  await service.from("automation_settings").delete().eq("organization_id", orgId);
  await service.from("messages").delete().eq("organization_id", orgId);
  await service.from("conversations").delete().eq("organization_id", orgId);
  await service.from("leads").delete().eq("organization_id", orgId);
  await service.from("contacts").delete().eq("organization_id", orgId);
  await service.from("organizations").delete().eq("id", orgId);
}

test("1. a new lead older than 24h with no messages at all is a candidate", async () => {
  const orgId = await makeOrg("Uncontacted Lead Test Org (1)");
  try {
    const contactId = await makeContact(orgId, "+15555610001");
    const leadId = await makeLead(orgId, contactId, { createdAt: hoursAgoIso(30) });

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(candidates.some((c) => c.type === "uncontacted_lead" && c.sourceEntityId === leadId));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("2. a new lead younger than 24h is never a candidate", async () => {
  const orgId = await makeOrg("Uncontacted Lead Test Org (2)");
  try {
    const contactId = await makeContact(orgId, "+15555610002");
    await makeLead(orgId, contactId, { createdAt: hoursAgoIso(1) });

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(!candidates.some((c) => c.type === "uncontacted_lead"));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("3. a new lead with an inbound message is never a candidate - the customer has already engaged", async () => {
  const orgId = await makeOrg("Uncontacted Lead Test Org (3)");
  try {
    const contactId = await makeContact(orgId, "+15555610003");
    await makeLead(orgId, contactId, { createdAt: hoursAgoIso(30) });
    const conversationId = await makeConversation(orgId, contactId);
    await makeMessage(orgId, conversationId, "inbound", "received");

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(!candidates.some((c) => c.type === "uncontacted_lead"));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("4. a new lead with an outbound 'sent' message is never a candidate", async () => {
  const orgId = await makeOrg("Uncontacted Lead Test Org (4)");
  try {
    const contactId = await makeContact(orgId, "+15555610004");
    await makeLead(orgId, contactId, { createdAt: hoursAgoIso(30) });
    const conversationId = await makeConversation(orgId, contactId);
    await makeMessage(orgId, conversationId, "outbound", "sent");

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(!candidates.some((c) => c.type === "uncontacted_lead"));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("5. a new lead with an outbound 'delivered' message is never a candidate", async () => {
  const orgId = await makeOrg("Uncontacted Lead Test Org (5)");
  try {
    const contactId = await makeContact(orgId, "+15555610005");
    await makeLead(orgId, contactId, { createdAt: hoursAgoIso(30) });
    const conversationId = await makeConversation(orgId, contactId);
    await makeMessage(orgId, conversationId, "outbound", "delivered");

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(!candidates.some((c) => c.type === "uncontacted_lead"));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("6. a new lead with only a 'failed' outbound message remains a candidate - an attempt is not contact", async () => {
  const orgId = await makeOrg("Uncontacted Lead Test Org (6)");
  try {
    const contactId = await makeContact(orgId, "+15555610006");
    const leadId = await makeLead(orgId, contactId, { createdAt: hoursAgoIso(30) });
    const conversationId = await makeConversation(orgId, contactId);
    await makeMessage(orgId, conversationId, "outbound", "failed");

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(candidates.some((c) => c.type === "uncontacted_lead" && c.sourceEntityId === leadId));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("7. a new lead with only a 'queued' outbound message remains a candidate - queued is not delivery", async () => {
  const orgId = await makeOrg("Uncontacted Lead Test Org (7)");
  try {
    const contactId = await makeContact(orgId, "+15555610007");
    const leadId = await makeLead(orgId, contactId, { createdAt: hoursAgoIso(30) });
    const conversationId = await makeConversation(orgId, contactId);
    await makeMessage(orgId, conversationId, "outbound", "queued");

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(candidates.some((c) => c.type === "uncontacted_lead" && c.sourceEntityId === leadId));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("8. an AI decision recorded as should_send:false with no message at all still leaves the lead a candidate", async () => {
  const orgId = await makeOrg("Uncontacted Lead Test Org (8)");
  try {
    const contactId = await makeContact(orgId, "+15555610008");
    const leadId = await makeLead(orgId, contactId, { createdAt: hoursAgoIso(30) });
    await makeDispatchedButUnsentExecution(orgId, leadId);

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(candidates.some((c) => c.type === "uncontacted_lead" && c.sourceEntityId === leadId));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("9. a real workflow_executions row with no successful outbound message still leaves the lead a candidate - execution is not contact", async () => {
  const orgId = await makeOrg("Uncontacted Lead Test Org (9)");
  try {
    const contactId = await makeContact(orgId, "+15555610009");
    const leadId = await makeLead(orgId, contactId, { createdAt: hoursAgoIso(30) });
    await makeDispatchedButUnsentExecution(orgId, leadId);
    const conversationId = await makeConversation(orgId, contactId);
    await makeMessage(orgId, conversationId, "outbound", "failed");

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(candidates.some((c) => c.type === "uncontacted_lead" && c.sourceEntityId === leadId));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("10. a lead whose status has moved away from 'new' is never a candidate", async () => {
  const orgId = await makeOrg("Uncontacted Lead Test Org (10)");
  try {
    const contactId = await makeContact(orgId, "+15555610010");
    await makeLead(orgId, contactId, { createdAt: hoursAgoIso(30), status: "contacted" });

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(!candidates.some((c) => c.type === "uncontacted_lead"));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("11. an opted-out contact's lead is never a candidate - Trackpr cannot act on it regardless", async () => {
  const orgId = await makeOrg("Uncontacted Lead Test Org (11)");
  try {
    const contactId = await makeContact(orgId, "+15555610011", true);
    await makeLead(orgId, contactId, { createdAt: hoursAgoIso(30) });

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(!candidates.some((c) => c.type === "uncontacted_lead"));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("12. an organization with payment_status not 'active' produces zero candidates, even with an otherwise-qualifying lead", async () => {
  const orgId = await makeOrg("Uncontacted Lead Test Org (12)", { paymentStatus: "payment_required" });
  try {
    const contactId = await makeContact(orgId, "+15555610012");
    await makeLead(orgId, contactId, { createdAt: hoursAgoIso(30) });

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(!candidates.some((c) => c.type === "uncontacted_lead"));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("13. an organization with automation_paused=true produces zero candidates", async () => {
  const orgId = await makeOrg("Uncontacted Lead Test Org (13)", { automationPaused: true });
  try {
    const contactId = await makeContact(orgId, "+15555610013");
    await makeLead(orgId, contactId, { createdAt: hoursAgoIso(30) });

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(!candidates.some((c) => c.type === "uncontacted_lead"));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("14. an organization not in automation_mode='live' produces zero candidates", async () => {
  const orgId = await makeOrg("Uncontacted Lead Test Org (14)", { automationMode: "test" });
  try {
    const contactId = await makeContact(orgId, "+15555610014");
    await makeLead(orgId, contactId, { createdAt: hoursAgoIso(30) });

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(!candidates.some((c) => c.type === "uncontacted_lead"));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("15. instant-lead-followup explicitly disabled for the org produces zero candidates - never a false opportunity for an intentionally-off automation", async () => {
  const orgId = await makeOrg("Uncontacted Lead Test Org (15)");
  try {
    const contactId = await makeContact(orgId, "+15555610015");
    await makeLead(orgId, contactId, { createdAt: hoursAgoIso(30) });
    await setAutomationEnabled(orgId, "instant-lead-followup", false);

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(!candidates.some((c) => c.type === "uncontacted_lead"));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("16/17. NULL estimated_value stays NULL, never coerced to $0; a known estimated_value is preserved", async () => {
  const orgId = await makeOrg("Uncontacted Lead Test Org (16)");
  try {
    const contactId1 = await makeContact(orgId, "+15555610016");
    const contactId2 = await makeContact(orgId, "+15555610017");
    const unknownLeadId = await makeLead(orgId, contactId1, { createdAt: hoursAgoIso(30), estimatedValue: null });
    const knownLeadId = await makeLead(orgId, contactId2, { createdAt: hoursAgoIso(30), estimatedValue: 750 });

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    const unknown = candidates.find((c) => c.type === "uncontacted_lead" && c.sourceEntityId === unknownLeadId);
    const known = candidates.find((c) => c.type === "uncontacted_lead" && c.sourceEntityId === knownLeadId);
    assert.equal(unknown?.estimatedValue, null);
    assert.equal(unknown?.valueBasis, null);
    assert.equal(known?.estimatedValue, 750);
    assert.equal(known?.valueBasis, "leads.estimated_value");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("18. organization isolation: a qualifying uncontacted lead in organization A never appears when detecting organization B", async () => {
  const orgA = await makeOrg("Uncontacted Lead Test Org (18-A)");
  const orgB = await makeOrg("Uncontacted Lead Test Org (18-B)");
  try {
    const contactId = await makeContact(orgA, "+15555610018");
    await makeLead(orgA, contactId, { createdAt: hoursAgoIso(30) });

    const candidatesB = await detectAllOpportunityCandidates(service, orgB);
    assert.ok(!candidatesB.some((c) => c.type === "uncontacted_lead"));
  } finally {
    await cleanupOrg(orgA);
    await cleanupOrg(orgB);
  }
});

test("19. deduplication: a second sync never creates a duplicate opportunity for the same lead", async () => {
  const orgId = await makeOrg("Uncontacted Lead Test Org (19)");
  try {
    const contactId = await makeContact(orgId, "+15555610019");
    const leadId = await makeLead(orgId, contactId, { createdAt: hoursAgoIso(30) });

    await syncOpportunities(service, orgId);
    const secondSync = await syncOpportunities(service, orgId);
    assert.equal(secondSync.created, 0);

    const { data: rows } = await service.from("opportunities").select("id").eq("organization_id", orgId).eq("type", "uncontacted_lead").eq("source_entity_id", leadId);
    assert.equal(rows?.length, 1);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("20. dismissal permanently suppresses the same lead, even though the underlying condition is unchanged", async () => {
  const orgId = await makeOrg("Uncontacted Lead Test Org (20)");
  try {
    const contactId = await makeContact(orgId, "+15555610020");
    await makeLead(orgId, contactId, { createdAt: hoursAgoIso(30) });

    await syncOpportunities(service, orgId);
    const { data: opp } = await service.from("opportunities").select("id").eq("organization_id", orgId).eq("type", "uncontacted_lead").single();
    await service.from("opportunities").update({ status: "dismissed", resolved_at: new Date().toISOString() }).eq("id", opp!.id);

    const resyncResult = await syncOpportunities(service, orgId);
    assert.equal(resyncResult.suppressed, 1);

    const { data: stillOne } = await service.from("opportunities").select("id, status").eq("organization_id", orgId).eq("type", "uncontacted_lead");
    assert.equal(stillOne?.length, 1);
    assert.equal(stillOne![0].status, "dismissed");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("21. a resolved opportunity can recur as a fresh open row once its condition becomes true again", async () => {
  const orgId = await makeOrg("Uncontacted Lead Test Org (21)");
  try {
    const contactId = await makeContact(orgId, "+15555610021");
    const leadId = await makeLead(orgId, contactId, { createdAt: hoursAgoIso(30) });

    await syncOpportunities(service, orgId);
    const conversationId = await makeConversation(orgId, contactId);
    await makeMessage(orgId, conversationId, "outbound", "sent");
    const resolveSync = await syncOpportunities(service, orgId);
    assert.ok(resolveSync.resolved >= 1);

    // The condition becomes true again: a later, separate cancelled/failed
    // scenario is out of scope here - instead simulate genuine recurrence by
    // reverting to a state with no successful outbound evidence, matching
    // this codebase's own established recurrence-test shape (e.g.
    // sync.integration.test.ts's own dormant_customer recurrence test).
    await service.from("messages").delete().eq("conversation_id", conversationId);
    const recurSync = await syncOpportunities(service, orgId);
    assert.ok(recurSync.created >= 1);

    const { data: rows } = await service.from("opportunities").select("status").eq("organization_id", orgId).eq("type", "uncontacted_lead").eq("source_entity_id", leadId).order("created_at", { ascending: false });
    assert.equal(rows?.[0]?.status, "open");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("22. an inbound reply resolves an existing open opportunity", async () => {
  const orgId = await makeOrg("Uncontacted Lead Test Org (22)");
  try {
    const contactId = await makeContact(orgId, "+15555610022");
    const leadId = await makeLead(orgId, contactId, { createdAt: hoursAgoIso(30) });

    await syncOpportunities(service, orgId);
    const { data: openOpp } = await service.from("opportunities").select("id, status").eq("organization_id", orgId).eq("type", "uncontacted_lead").eq("source_entity_id", leadId).single();
    assert.equal(openOpp?.status, "open");

    const conversationId = await makeConversation(orgId, contactId);
    await makeMessage(orgId, conversationId, "inbound", "received");
    const resyncResult = await syncOpportunities(service, orgId);
    assert.ok(resyncResult.resolved >= 1);

    const { data: resolvedOpp } = await service.from("opportunities").select("status").eq("id", openOpp!.id).single();
    assert.equal(resolvedOpp?.status, "resolved");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("23. a successful outbound send resolves an existing open opportunity", async () => {
  const orgId = await makeOrg("Uncontacted Lead Test Org (23)");
  try {
    const contactId = await makeContact(orgId, "+15555610023");
    const leadId = await makeLead(orgId, contactId, { createdAt: hoursAgoIso(30) });

    await syncOpportunities(service, orgId);
    const { data: openOpp } = await service.from("opportunities").select("id, status").eq("organization_id", orgId).eq("type", "uncontacted_lead").eq("source_entity_id", leadId).single();
    assert.equal(openOpp?.status, "open");

    const conversationId = await makeConversation(orgId, contactId);
    await makeMessage(orgId, conversationId, "outbound", "delivered");
    const resyncResult = await syncOpportunities(service, orgId);
    assert.ok(resyncResult.resolved >= 1);

    const { data: resolvedOpp } = await service.from("opportunities").select("status").eq("id", openOpp!.id).single();
    assert.equal(resolvedOpp?.status, "resolved");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("24. a failed outbound send does NOT resolve an existing open opportunity", async () => {
  const orgId = await makeOrg("Uncontacted Lead Test Org (24)");
  try {
    const contactId = await makeContact(orgId, "+15555610024");
    const leadId = await makeLead(orgId, contactId, { createdAt: hoursAgoIso(30) });

    await syncOpportunities(service, orgId);
    const { data: openOpp } = await service.from("opportunities").select("id, status").eq("organization_id", orgId).eq("type", "uncontacted_lead").eq("source_entity_id", leadId).single();
    assert.equal(openOpp?.status, "open");

    const conversationId = await makeConversation(orgId, contactId);
    await makeMessage(orgId, conversationId, "outbound", "failed");
    await syncOpportunities(service, orgId);

    const { data: stillOpenOpp } = await service.from("opportunities").select("status").eq("id", openOpp!.id).single();
    assert.equal(stillOpenOpp?.status, "open");
  } finally {
    await cleanupOrg(orgId);
  }
});

/**
 * Integration tests for Growth System Completion Pass 2, Part 11: the owner's
 * own dashboard "Needs Attention" panel gains real visibility into a broken
 * Google Calendar sync (lib/dashboard/queries.ts's getDashboardData) - a
 * signal that, before this pass, only the agency admin could see (see
 * lib/agency/health.ts's own loadCalendarHealth for the identical
 * connected/error/not_connected distinction this reuses).
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/dashboard/queries.integration.test.ts
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
const { getDashboardData }: typeof import("./queries") = require(path.join(REPO_ROOT, "lib/dashboard/queries.ts"));
const { findOrCreateOpenConversation }: typeof import("@/lib/conversations/queries") = require(path.join(REPO_ROOT, "lib/conversations/queries.ts"));
const { syncOpportunities }: typeof import("@/lib/opportunities/detect") = require(path.join(REPO_ROOT, "lib/opportunities/detect.ts"));
const { getBusinessMetricsSnapshot }: typeof import("@/lib/bi/metrics") = require(path.join(REPO_ROOT, "lib/bi/metrics.ts"));

const service = createServiceRoleClient();

let organizationId: string;

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Dashboard Attention Test Org" }).select("id").single();
  organizationId = org!.id;
});

after(async () => {
  await service.from("calendar_connections").delete().eq("organization_id", organizationId);
  await service.from("automation_incidents").delete().eq("organization_id", organizationId);
  await service.from("messages").delete().eq("organization_id", organizationId);
  await service.from("conversations").delete().eq("organization_id", organizationId);
  await service.from("opportunities").delete().eq("organization_id", organizationId);
  await service.from("estimates").delete().eq("organization_id", organizationId);
  await service.from("jobs").delete().eq("organization_id", organizationId);
  await service.from("appointments").delete().eq("organization_id", organizationId);
  await service.from("leads").delete().eq("organization_id", organizationId);
  await service.from("contacts").delete().eq("organization_id", organizationId);
  await service.from("organizations").delete().eq("id", organizationId);
});

test("1. no calendar connection at all is never an attention item - a normal, common state", async () => {
  const data = await getDashboardData(service, organizationId);
  assert.equal(data.attentionItems.some((item) => item.kind === "calendar_disconnected"), false);
});

test("2. a healthy, connected calendar is never an attention item", async () => {
  await service.from("calendar_connections").insert({ organization_id: organizationId, provider: "google", status: "connected" });

  const data = await getDashboardData(service, organizationId);
  assert.equal(data.attentionItems.some((item) => item.kind === "calendar_disconnected"), false);

  await service.from("calendar_connections").delete().eq("organization_id", organizationId);
});

test("3. a calendar in an error state is surfaced as a real, actionable attention item with the real error detail", async () => {
  await service.from("calendar_connections").insert({ organization_id: organizationId, provider: "google", status: "error", last_error: "Refresh token expired" });

  const data = await getDashboardData(service, organizationId);
  const item = data.attentionItems.find((i) => i.kind === "calendar_disconnected");
  assert.ok(item, "an error-status calendar connection must appear in attentionItems");
  assert.equal(item!.detail, "Refresh token expired");

  await service.from("calendar_connections").delete().eq("organization_id", organizationId);
});

test("4. organization isolation: organization A's broken calendar never appears for organization B", async () => {
  const { data: otherOrg } = await service.from("organizations").insert({ name: "Dashboard Attention Test Org (Other)" }).select("id").single();
  try {
    await service.from("calendar_connections").insert({ organization_id: organizationId, provider: "google", status: "error", last_error: "Broken" });

    const dataOther = await getDashboardData(service, otherOrg!.id);
    assert.equal(dataOther.attentionItems.some((item) => item.kind === "calendar_disconnected"), false);

    await service.from("calendar_connections").delete().eq("organization_id", organizationId);
  } finally {
    await service.from("organizations").delete().eq("id", otherOrg!.id);
  }
});

test("5. HANDOFF-01: an open human escalation incident appears as a human_escalation attention item, linking to its conversation", async () => {
  const conversationId = "11111111-1111-4111-8111-111111111111";
  const { data: incident } = await service
    .rpc("record_automation_incident_signal", {
      p_organization_id: organizationId,
      p_category: "human_escalation_requested",
      p_severity: "warning",
      p_fingerprint: `human_escalation_requested:${conversationId}`,
      p_title: "AI escalated a conversation to a human",
      p_description: "The customer asked for a human.",
      p_metadata: { conversationId, contactId: null, leadId: null },
    })
    .single();
  try {
    const data = await getDashboardData(service, organizationId);
    const item = data.attentionItems.find((i) => i.kind === "human_escalation");
    assert.ok(item, "an open human_escalation_requested incident must appear in attentionItems");
    assert.equal(item!.detail, "The customer asked for a human.");
    assert.equal(item!.href, `/conversations/${conversationId}`);
    assert.equal(item!.incidentId, (incident as { id: string }).id);
    assert.equal(item!.incidentStatus, "open");
  } finally {
    await service.from("automation_incidents").delete().eq("id", (incident as { id: string }).id);
  }
});

test("6. HANDOFF-01: an acknowledged escalation remains visible (only 'resolved' is excluded)", async () => {
  const conversationId = "22222222-2222-4222-8222-222222222222";
  const { data: incident } = await service
    .rpc("record_automation_incident_signal", {
      p_organization_id: organizationId,
      p_category: "human_escalation_requested",
      p_severity: "warning",
      p_fingerprint: `human_escalation_requested:${conversationId}`,
      p_title: "AI escalated a conversation to a human",
      p_metadata: { conversationId },
    })
    .single();
  const incidentId = (incident as { id: string }).id;
  try {
    await service.from("automation_incidents").update({ status: "acknowledged" }).eq("id", incidentId);

    const data = await getDashboardData(service, organizationId);
    const item = data.attentionItems.find((i) => i.incidentId === incidentId);
    assert.ok(item, "an acknowledged (not yet resolved) escalation must still appear");
    assert.equal(item!.incidentStatus, "acknowledged");
  } finally {
    await service.from("automation_incidents").delete().eq("id", incidentId);
  }
});

test("7. HANDOFF-01: a resolved escalation no longer appears", async () => {
  const conversationId = "33333333-3333-4333-8333-333333333333";
  const { data: incident } = await service
    .rpc("record_automation_incident_signal", {
      p_organization_id: organizationId,
      p_category: "human_escalation_requested",
      p_severity: "warning",
      p_fingerprint: `human_escalation_requested:${conversationId}`,
      p_title: "AI escalated a conversation to a human",
      p_metadata: { conversationId },
    })
    .single();
  const incidentId = (incident as { id: string }).id;
  try {
    await service.from("automation_incidents").update({ status: "resolved" }).eq("id", incidentId);

    const data = await getDashboardData(service, organizationId);
    assert.equal(data.attentionItems.some((i) => i.incidentId === incidentId), false, "a resolved escalation must never appear as an attention item");
  } finally {
    await service.from("automation_incidents").delete().eq("id", incidentId);
  }
});

test("8. HANDOFF-01: organization isolation - organization A's open escalation never appears for organization B", async () => {
  const { data: otherOrg } = await service.from("organizations").insert({ name: "Dashboard Attention Test Org (Other, Escalation)" }).select("id").single();
  const conversationId = "44444444-4444-4444-8444-444444444444";
  const { data: incident } = await service
    .rpc("record_automation_incident_signal", {
      p_organization_id: organizationId,
      p_category: "human_escalation_requested",
      p_severity: "warning",
      p_fingerprint: `human_escalation_requested:${conversationId}`,
      p_title: "AI escalated a conversation to a human",
      p_metadata: { conversationId },
    })
    .single();
  try {
    const dataOther = await getDashboardData(service, otherOrg!.id);
    assert.equal(dataOther.attentionItems.some((i) => i.kind === "human_escalation"), false);
  } finally {
    await service.from("automation_incidents").delete().eq("id", (incident as { id: string }).id);
    await service.from("organizations").delete().eq("id", otherOrg!.id);
  }
});

test("9. BOOK-02: an overdue (past-due, still-scheduled) appointment deep-links directly to that specific appointment", async () => {
  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, phone: `+1555559${Math.floor(1000 + Math.random() * 8999)}` }).select("id").single();
  const { data: appointment } = await service
    .from("appointments")
    .insert({ organization_id: organizationId, contact_id: contact!.id, title: "Overdue Appt", status: "scheduled", start_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), end_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() })
    .select("id")
    .single();

  const data = await getDashboardData(service, organizationId);
  const item = data.attentionItems.find((i) => i.kind === "overdue_appointment" && i.id === `apt-${appointment!.id}`);
  assert.ok(item, "expected the overdue appointment to appear");
  assert.equal(item!.href, `/appointments/${appointment!.id}`, "must deep-link to the specific appointment, not the generic list");
});

test("10. Q7: a high-value (but not 'hot') lead appears as its own attention item, and is never double-counted with hotLeads", async () => {
  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, phone: `+1555560${Math.floor(1000 + Math.random() * 8999)}` }).select("id").single();
  const { data: lead } = await service.from("leads").insert({ organization_id: organizationId, contact_id: contact!.id, service: "Big Job", status: "qualified", temperature: "warm", estimated_value: 12000 }).select("id").single();

  const data = await getDashboardData(service, organizationId);
  const items = data.attentionItems.filter((i) => i.id === `value-${lead!.id}`);
  assert.equal(items.length, 1, "expected exactly one high_value_lead item");
  assert.equal(items[0].kind, "high_value_lead");
  assert.equal(items[0].value, "$12,000");
  assert.equal(data.attentionItems.some((i) => i.id === `hot-${lead!.id}`), false, "a warm (not hot) lead must never also appear as hot_lead");
});

test("11. Q7: a low-value lead below the threshold never appears as high_value_lead", async () => {
  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, phone: `+1555561${Math.floor(1000 + Math.random() * 8999)}` }).select("id").single();
  const { data: lead } = await service.from("leads").insert({ organization_id: organizationId, contact_id: contact!.id, service: "Small Job", status: "qualified", temperature: "warm", estimated_value: 250 }).select("id").single();

  const data = await getDashboardData(service, organizationId);
  assert.equal(data.attentionItems.some((i) => i.id === `value-${lead!.id}`), false);
});

test("12. ATTN-01: an open conversation whose last message is inbound appears as awaiting_reply", async () => {
  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "Awaiting", phone: `+1555562${Math.floor(1000 + Math.random() * 8999)}` }).select("id").single();
  const conversation = await findOrCreateOpenConversation(service, organizationId, contact!.id, "sms");
  await service.from("messages").insert({ organization_id: organizationId, conversation_id: conversation!.id, direction: "inbound", sender_type: "customer", body: "Hello?", status: "received" });

  const data = await getDashboardData(service, organizationId);
  const item = data.attentionItems.find((i) => i.id === `reply-${conversation!.id}`);
  assert.ok(item, "expected an awaiting_reply item for the open, inbound-last conversation");
  assert.equal(item!.kind, "awaiting_reply");
  assert.equal(item!.href, `/conversations/${conversation!.id}`);
});

test("13. ATTN-01: a conversation whose last message is outbound (already answered) never appears as awaiting_reply", async () => {
  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "Answered", phone: `+1555563${Math.floor(1000 + Math.random() * 8999)}` }).select("id").single();
  const conversation = await findOrCreateOpenConversation(service, organizationId, contact!.id, "sms");
  await service.from("messages").insert({ organization_id: organizationId, conversation_id: conversation!.id, direction: "inbound", sender_type: "customer", body: "Hello?", status: "received" });
  await service.from("messages").insert({ organization_id: organizationId, conversation_id: conversation!.id, direction: "outbound", sender_type: "ai", body: "Hi! How can I help?", status: "sent" });

  const data = await getDashboardData(service, organizationId);
  assert.equal(data.attentionItems.some((i) => i.id === `reply-${conversation!.id}`), false);
});

// ==================== Pass 4 P0: the 3 opportunity-backed attention kinds ====================
//
// Pass 3 added stale_estimate/dormant_customer/no_show to getDashboardData,
// backed by the real opportunities table, but shipped with zero regression
// coverage for them - only verified manually during the production release.
// Each test below goes through the real path: create the underlying data,
// run syncOpportunities (exactly what app/(app)/dashboard/page.tsx does on
// every load) so the opportunity actually persists, then call
// getDashboardData itself - never a bare unit test of a helper.

test("14. stale_estimate: an expired estimate, once synced into an opportunity, appears in getDashboardData's attentionItems", async () => {
  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "StaleEstimate", phone: `+1555564${Math.floor(1000 + Math.random() * 8999)}` }).select("id").single();
  const { data: estimate } = await service.from("estimates").insert({ organization_id: organizationId, contact_id: contact!.id, title: "Kitchen remodel quote", status: "expired", amount: 4200 }).select("id").single();

  const sync = await syncOpportunities(service, organizationId);
  assert.ok(sync.created >= 1, "the expired estimate must produce at least one new opportunity");

  const data = await getDashboardData(service, organizationId);
  const item = data.attentionItems.find((i) => i.kind === "stale_estimate");
  assert.ok(item, "expected a stale_estimate attention item");
  assert.equal(item!.value, "$4,200");
  assert.equal(item!.href, "/estimates");
  assert.ok(item!.opportunityId, "must carry an opportunityId so the dismiss action can act on it");

  const { data: oppRow } = await service.from("opportunities").select("source_entity_id, type").eq("id", item!.opportunityId!).single();
  assert.equal(oppRow?.type, "stale_estimate");
  assert.equal(oppRow?.source_entity_id, estimate!.id, "the opportunity's source_entity_id must be the real estimate that expired");
});

test("15. stale_estimate: organization isolation - an expired estimate in organization A never appears as an attention item for organization B", async () => {
  const { data: otherOrg } = await service.from("organizations").insert({ name: "Dashboard Attention Test Org (Other, Stale Estimate)" }).select("id").single();
  try {
    const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "StaleEstimateIso", phone: `+1555565${Math.floor(1000 + Math.random() * 8999)}` }).select("id").single();
    await service.from("estimates").insert({ organization_id: organizationId, contact_id: contact!.id, title: "Bathroom quote", status: "expired", amount: 1000 });
    await syncOpportunities(service, organizationId);

    const dataOther = await getDashboardData(service, otherOrg!.id);
    assert.equal(dataOther.attentionItems.some((i) => i.kind === "stale_estimate"), false);
  } finally {
    await service.from("organizations").delete().eq("id", otherOrg!.id);
  }
});

test("16. no_show: a missed appointment, once synced into an opportunity, appears in getDashboardData's attentionItems", async () => {
  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "NoShow", phone: `+1555566${Math.floor(1000 + Math.random() * 8999)}` }).select("id").single();
  const { data: appointment } = await service
    .from("appointments")
    .insert({ organization_id: organizationId, contact_id: contact!.id, title: "Missed visit", status: "no_show", start_at: "2027-05-01T09:00:00.000Z", end_at: "2027-05-01T10:00:00.000Z" })
    .select("id")
    .single();

  const sync = await syncOpportunities(service, organizationId);
  assert.ok(sync.created >= 1);

  const data = await getDashboardData(service, organizationId);
  const item = data.attentionItems.find((i) => i.kind === "no_show");
  assert.ok(item, "expected a no_show attention item");
  assert.equal(item!.href, "/appointments");
  assert.ok(item!.opportunityId);

  const { data: oppRow } = await service.from("opportunities").select("source_entity_id, type").eq("id", item!.opportunityId!).single();
  assert.equal(oppRow?.type, "no_show");
  assert.equal(oppRow?.source_entity_id, appointment!.id);
});

test("17. no_show: organization isolation - a no-show appointment in organization A never appears for organization B", async () => {
  const { data: otherOrg } = await service.from("organizations").insert({ name: "Dashboard Attention Test Org (Other, No Show)" }).select("id").single();
  try {
    const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "NoShowIso", phone: `+1555567${Math.floor(1000 + Math.random() * 8999)}` }).select("id").single();
    await service.from("appointments").insert({ organization_id: organizationId, contact_id: contact!.id, title: "Missed visit 2", status: "no_show", start_at: "2027-05-02T09:00:00.000Z", end_at: "2027-05-02T10:00:00.000Z" });
    await syncOpportunities(service, organizationId);

    const dataOther = await getDashboardData(service, otherOrg!.id);
    assert.equal(dataOther.attentionItems.some((i) => i.kind === "no_show"), false);
  } finally {
    await service.from("organizations").delete().eq("id", otherOrg!.id);
  }
});

test("18. dormant_customer: an old completed job with no active engagement, once synced, appears in getDashboardData's attentionItems, deep-linking to the real contact", async () => {
  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "Dormant", phone: `+1555568${Math.floor(1000 + Math.random() * 8999)}` }).select("id").single();
  const oldCompletedAt = new Date(Date.now() - 250 * 24 * 60 * 60 * 1000).toISOString(); // well past the 180-day default threshold
  await service.from("jobs").insert({ organization_id: organizationId, contact_id: contact!.id, title: "Old roof repair", status: "completed", completed_at: oldCompletedAt });

  const sync = await syncOpportunities(service, organizationId);
  assert.ok(sync.created >= 1);

  const data = await getDashboardData(service, organizationId);
  const item = data.attentionItems.find((i) => i.kind === "dormant_customer");
  assert.ok(item, "expected a dormant_customer attention item");
  assert.equal(item!.value, null, "dormant/repeat-customer opportunities must never carry a fabricated future-service value");
  assert.equal(item!.href, `/contacts/${contact!.id}`, "must deep-link to the real contact");
  assert.ok(item!.opportunityId);

  const { data: oppRow } = await service.from("opportunities").select("source_entity_id, contact_id, type").eq("id", item!.opportunityId!).single();
  assert.equal(oppRow?.type, "dormant_customer");
  assert.equal(oppRow?.source_entity_id, contact!.id);
  assert.equal(oppRow?.contact_id, contact!.id);
});

test("19. dormant_customer: a customer with an active open lead is excluded, even with an old completed job - reuses customer-reactivation's own active-engagement exclusion, not a second definition", async () => {
  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "NotDormant", phone: `+1555569${Math.floor(1000 + Math.random() * 8999)}` }).select("id").single();
  const oldCompletedAt = new Date(Date.now() - 250 * 24 * 60 * 60 * 1000).toISOString();
  await service.from("jobs").insert({ organization_id: organizationId, contact_id: contact!.id, title: "Old fence repair", status: "completed", completed_at: oldCompletedAt });
  // A real open lead for the SAME contact - the exact exclusion
  // lib/automation/customer-reactivation.ts's OPEN_LEAD_STATUSES already
  // enforces for the real automation, reused verbatim by the detector.
  await service.from("leads").insert({ organization_id: organizationId, contact_id: contact!.id, status: "qualified", temperature: "warm", source: "website" });

  await syncOpportunities(service, organizationId);

  const data = await getDashboardData(service, organizationId);
  assert.equal(
    data.attentionItems.some((i) => i.kind === "dormant_customer" && i.href === `/contacts/${contact!.id}`),
    false,
    "a customer with an active open lead must never be flagged dormant, regardless of how old their last completed job is",
  );

  const { data: openOpp } = await service.from("opportunities").select("id").eq("organization_id", organizationId).eq("type", "dormant_customer").eq("source_entity_id", contact!.id).eq("status", "open");
  assert.equal(openOpp?.length ?? 0, 0, "no open dormant_customer opportunity should have been created for this contact at all");
});

test("20. dormant_customer: organization isolation - a dormant customer in organization A never appears for organization B", async () => {
  const { data: otherOrg } = await service.from("organizations").insert({ name: "Dashboard Attention Test Org (Other, Dormant)" }).select("id").single();
  try {
    const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "DormantIso", phone: `+1555570${Math.floor(1000 + Math.random() * 8999)}` }).select("id").single();
    const oldCompletedAt = new Date(Date.now() - 250 * 24 * 60 * 60 * 1000).toISOString();
    await service.from("jobs").insert({ organization_id: organizationId, contact_id: contact!.id, title: "Old gutter cleaning", status: "completed", completed_at: oldCompletedAt });
    await syncOpportunities(service, organizationId);

    const dataOther = await getDashboardData(service, otherOrg!.id);
    assert.equal(dataOther.attentionItems.some((i) => i.kind === "dormant_customer"), false);
  } finally {
    await service.from("organizations").delete().eq("id", otherOrg!.id);
  }
});

// ==================== Pass 5C Batch 1: abandoned_conversation ====================
//
// Directly computed, non-opportunity-backed, non-persisted - recomputed
// fresh on every load from getConversations + attachLastMessages, exactly
// like awaiting_reply. conversations.updated_at is only ever settable at
// INSERT time in these fixtures (never via a follow-up UPDATE): this table
// carries the same set_updated_at BEFORE UPDATE trigger pattern already
// discovered on appointments, which unconditionally overwrites updated_at
// to now() on any UPDATE, so a raw insert (not findOrCreateOpenConversation,
// which would default updated_at to now()) is used wherever a backdated
// lastActivityAt is required.

function hoursAgoIso(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

async function insertConversation(opts: { contactId: string; leadId?: string | null; status?: string; updatedAt: string }) {
  const { data } = await service
    .from("conversations")
    .insert({ organization_id: organizationId, contact_id: opts.contactId, lead_id: opts.leadId ?? null, channel: "sms", status: opts.status ?? "open", updated_at: opts.updatedAt })
    .select("id")
    .single();
  return data!.id as string;
}

async function insertMessage(conversationId: string, direction: string, createdAt: string) {
  await service.from("messages").insert({ organization_id: organizationId, conversation_id: conversationId, direction, sender_type: direction === "outbound" ? "ai" : "customer", body: "test", status: direction === "outbound" ? "sent" : "received", created_at: createdAt });
}

test("21. abandoned_conversation: an open conversation, last message outbound, past the 48h threshold, appears as an attention item", async () => {
  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "Abandoned", phone: `+1555571${Math.floor(1000 + Math.random() * 8999)}` }).select("id").single();
  const conversationId = await insertConversation({ contactId: contact!.id, updatedAt: hoursAgoIso(60) });
  await insertMessage(conversationId, "outbound", hoursAgoIso(60));

  const data = await getDashboardData(service, organizationId);
  const item = data.attentionItems.find((i) => i.kind === "abandoned_conversation" && i.href === `/conversations/${conversationId}`);
  assert.ok(item, "expected an abandoned_conversation attention item");
});

test("22. abandoned_conversation: an outbound-last conversation still within the 48h threshold never appears", async () => {
  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "NotYetAbandoned", phone: `+1555572${Math.floor(1000 + Math.random() * 8999)}` }).select("id").single();
  const conversationId = await insertConversation({ contactId: contact!.id, updatedAt: hoursAgoIso(1) });
  await insertMessage(conversationId, "outbound", hoursAgoIso(1));

  const data = await getDashboardData(service, organizationId);
  assert.equal(data.attentionItems.some((i) => i.kind === "abandoned_conversation" && i.href === `/conversations/${conversationId}`), false);
});

test("23. abandoned_conversation: a customer reply after our outbound message means no attention item, regardless of age", async () => {
  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "Replied", phone: `+1555573${Math.floor(1000 + Math.random() * 8999)}` }).select("id").single();
  const conversationId = await insertConversation({ contactId: contact!.id, updatedAt: hoursAgoIso(60) });
  await insertMessage(conversationId, "outbound", hoursAgoIso(70));
  await insertMessage(conversationId, "inbound", hoursAgoIso(60));

  const data = await getDashboardData(service, organizationId);
  assert.equal(data.attentionItems.some((i) => i.kind === "abandoned_conversation" && i.href === `/conversations/${conversationId}`), false);
});

test("24. abandoned_conversation: a closed conversation never appears, even with a stale outbound-last message", async () => {
  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "Closed", phone: `+1555574${Math.floor(1000 + Math.random() * 8999)}` }).select("id").single();
  const conversationId = await insertConversation({ contactId: contact!.id, status: "closed", updatedAt: hoursAgoIso(60) });
  await insertMessage(conversationId, "outbound", hoursAgoIso(60));

  const data = await getDashboardData(service, organizationId);
  assert.equal(data.attentionItems.some((i) => i.kind === "abandoned_conversation" && i.href === `/conversations/${conversationId}`), false);
});

test("25. abandoned_conversation: a conversation with no messages at all never appears", async () => {
  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "NoMessages", phone: `+1555575${Math.floor(1000 + Math.random() * 8999)}` }).select("id").single();
  const conversationId = await insertConversation({ contactId: contact!.id, updatedAt: hoursAgoIso(60) });

  const data = await getDashboardData(service, organizationId);
  assert.equal(data.attentionItems.some((i) => i.kind === "abandoned_conversation" && i.href === `/conversations/${conversationId}`), false);
});

test("26. abandoned_conversation: organization isolation - a stale conversation in organization A never appears for organization B", async () => {
  const { data: otherOrg } = await service.from("organizations").insert({ name: "Dashboard Attention Test Org (Other, Abandoned)" }).select("id").single();
  try {
    const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "AbandonedIso", phone: `+1555576${Math.floor(1000 + Math.random() * 8999)}` }).select("id").single();
    const conversationId = await insertConversation({ contactId: contact!.id, updatedAt: hoursAgoIso(60) });
    await insertMessage(conversationId, "outbound", hoursAgoIso(60));

    const dataOther = await getDashboardData(service, otherOrg!.id);
    assert.equal(dataOther.attentionItems.some((i) => i.kind === "abandoned_conversation"), false);
  } finally {
    await service.from("organizations").delete().eq("id", otherOrg!.id);
  }
});

test("27. abandoned_conversation: a lead that already progressed to 'appointment' excludes the conversation, even past the threshold", async () => {
  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "AlreadyBooked", phone: `+1555577${Math.floor(1000 + Math.random() * 8999)}` }).select("id").single();
  const { data: lead } = await service.from("leads").insert({ organization_id: organizationId, contact_id: contact!.id, status: "appointment", temperature: "warm", source: "website" }).select("id").single();
  const conversationId = await insertConversation({ contactId: contact!.id, leadId: lead!.id, updatedAt: hoursAgoIso(60) });
  await insertMessage(conversationId, "outbound", hoursAgoIso(60));

  const data = await getDashboardData(service, organizationId);
  assert.equal(data.attentionItems.some((i) => i.kind === "abandoned_conversation" && i.href === `/conversations/${conversationId}`), false, "a lead already past the pre-booking pipeline must never be flagged as an abandoned-conversation miss");
});

test("28. abandoned_conversation: a lead still in an actionable pre-booking status ('qualified') is still flagged past the threshold", async () => {
  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "StillActionable", phone: `+1555578${Math.floor(1000 + Math.random() * 8999)}` }).select("id").single();
  const { data: lead } = await service.from("leads").insert({ organization_id: organizationId, contact_id: contact!.id, status: "qualified", temperature: "warm", source: "website" }).select("id").single();
  const conversationId = await insertConversation({ contactId: contact!.id, leadId: lead!.id, updatedAt: hoursAgoIso(60) });
  await insertMessage(conversationId, "outbound", hoursAgoIso(60));

  const data = await getDashboardData(service, organizationId);
  assert.ok(data.attentionItems.some((i) => i.kind === "abandoned_conversation" && i.href === `/conversations/${conversationId}`), "a lead still in an actionable pre-booking status must still be flagged");
});

// ==================== Pass 5C Batch 3A: dashboard funnel truth (pipeline.appointment/estimate, overview.pendingEstimates) ====================
//
// Every test below proves the pipeline/overview numbers now come from real
// appointments/estimates by lead_id, never from leads.status - the exact P0
// fix the Pass 5C Batch 3 read-only audit identified. Each test creates a
// lead whose OWN status field is deliberately left at 'qualified' (never
// manually advanced to 'appointment'/'estimate') to prove the fix does not
// depend on that field at all.
//
// Unlike every test above, these use a DEDICATED, disposable organization
// per test rather than the shared `organizationId` - pipeline.appointment/
// pipeline.estimate/overview.pendingEstimates are org-wide aggregate counts,
// and the shared org accumulates real appointments/estimates across every
// other test in this file, so an exact-count assertion against it would be
// measuring cross-test contamination, not this fix. This mirrors the exact
// per-test-org convention already established in
// lib/opportunities/detect.review-rebooking.integration.test.ts and
// lib/opportunities/detect.uncontacted-lead.integration.test.ts for the
// identical reason.

async function makeFunnelTruthOrg(name: string) {
  const { data } = await service.from("organizations").insert({ name }).select("id").single();
  return data!.id as string;
}

async function cleanupFunnelTruthOrg(orgId: string) {
  await service.from("appointments").delete().eq("organization_id", orgId);
  await service.from("estimates").delete().eq("organization_id", orgId);
  await service.from("leads").delete().eq("organization_id", orgId);
  await service.from("contacts").delete().eq("organization_id", orgId);
  await service.from("organizations").delete().eq("id", orgId);
}

test("29. a real, active appointment (status='scheduled') is counted as booked in pipeline.appointment, even though leads.status is still 'qualified'", async () => {
  const orgId = await makeFunnelTruthOrg("Funnel Truth Test Org (29)");
  try {
    const { data: contact } = await service.from("contacts").insert({ organization_id: orgId, phone: "+15555800001" }).select("id").single();
    const { data: lead } = await service.from("leads").insert({ organization_id: orgId, contact_id: contact!.id, status: "qualified", temperature: "warm", source: "website" }).select("id").single();
    await service.from("appointments").insert({ organization_id: orgId, contact_id: contact!.id, lead_id: lead!.id, title: "Consult", status: "scheduled", start_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(), end_at: new Date(Date.now() + 25 * 3600 * 1000).toISOString() });

    const data = await getDashboardData(service, orgId);
    assert.equal(data.pipeline.appointment, 1, "a lead with a real scheduled appointment must count as booked, regardless of leads.status");
    assert.equal(data.pipeline.qualified, 1, "the same lead is still correctly counted under its own real leads.status - buckets are allowed to overlap");
  } finally {
    await cleanupFunnelTruthOrg(orgId);
  }
});

test("30. a new/qualified lead with NO appointment at all is never counted as booked", async () => {
  const orgId = await makeFunnelTruthOrg("Funnel Truth Test Org (30)");
  try {
    const { data: contact } = await service.from("contacts").insert({ organization_id: orgId, phone: "+15555800002" }).select("id").single();
    await service.from("leads").insert({ organization_id: orgId, contact_id: contact!.id, status: "qualified", temperature: "warm", source: "website" });

    const data = await getDashboardData(service, orgId);
    assert.equal(data.pipeline.appointment, 0);
  } finally {
    await cleanupFunnelTruthOrg(orgId);
  }
});

test("31. a CANCELLED appointment does not count as booked pipeline - the booking fell through", async () => {
  const orgId = await makeFunnelTruthOrg("Funnel Truth Test Org (31)");
  try {
    const { data: contact } = await service.from("contacts").insert({ organization_id: orgId, phone: "+15555800003" }).select("id").single();
    const { data: lead } = await service.from("leads").insert({ organization_id: orgId, contact_id: contact!.id, status: "qualified", temperature: "warm", source: "website" }).select("id").single();
    await service.from("appointments").insert({ organization_id: orgId, contact_id: contact!.id, lead_id: lead!.id, title: "Consult", status: "cancelled", start_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(), end_at: new Date(Date.now() + 25 * 3600 * 1000).toISOString() });

    const data = await getDashboardData(service, orgId);
    assert.equal(data.pipeline.appointment, 0, "a cancelled appointment must never count as booked pipeline");
  } finally {
    await cleanupFunnelTruthOrg(orgId);
  }
});

test("32. a NO-SHOW appointment does not count as booked pipeline - the booking fell through", async () => {
  const orgId = await makeFunnelTruthOrg("Funnel Truth Test Org (32)");
  try {
    const { data: contact } = await service.from("contacts").insert({ organization_id: orgId, phone: "+15555800004" }).select("id").single();
    const { data: lead } = await service.from("leads").insert({ organization_id: orgId, contact_id: contact!.id, status: "qualified", temperature: "warm", source: "website" }).select("id").single();
    await service.from("appointments").insert({ organization_id: orgId, contact_id: contact!.id, lead_id: lead!.id, title: "Consult", status: "no_show", start_at: "2027-01-01T09:00:00.000Z", end_at: "2027-01-01T10:00:00.000Z" });

    const data = await getDashboardData(service, orgId);
    assert.equal(data.pipeline.appointment, 0, "a no-show appointment must never count as booked pipeline");
  } finally {
    await cleanupFunnelTruthOrg(orgId);
  }
});

test("33. a COMPLETED appointment still counts as booked - a completed visit is still a real appointment the lead had", async () => {
  const orgId = await makeFunnelTruthOrg("Funnel Truth Test Org (33)");
  try {
    const { data: contact } = await service.from("contacts").insert({ organization_id: orgId, phone: "+15555800005" }).select("id").single();
    const { data: lead } = await service.from("leads").insert({ organization_id: orgId, contact_id: contact!.id, status: "qualified", temperature: "warm", source: "website" }).select("id").single();
    await service.from("appointments").insert({ organization_id: orgId, contact_id: contact!.id, lead_id: lead!.id, title: "Consult", status: "completed", start_at: "2027-01-01T09:00:00.000Z", end_at: "2027-01-01T10:00:00.000Z" });

    const data = await getDashboardData(service, orgId);
    assert.equal(data.pipeline.appointment, 1);
  } finally {
    await cleanupFunnelTruthOrg(orgId);
  }
});

test("34. a lead with a real, SENT estimate is counted as quoted/pending in pipeline.estimate and overview.pendingEstimates, even though leads.status is still 'qualified'", async () => {
  const orgId = await makeFunnelTruthOrg("Funnel Truth Test Org (34)");
  try {
    const { data: contact } = await service.from("contacts").insert({ organization_id: orgId, phone: "+15555800006" }).select("id").single();
    const { data: lead } = await service.from("leads").insert({ organization_id: orgId, contact_id: contact!.id, status: "qualified", temperature: "warm", source: "website", estimated_value: 900 }).select("id").single();
    await service.from("estimates").insert({ organization_id: orgId, contact_id: contact!.id, lead_id: lead!.id, title: "Quote", status: "sent", amount: 900 });

    const data = await getDashboardData(service, orgId);
    assert.equal(data.pipeline.estimate, 1, "a lead with a real sent estimate must count, regardless of leads.status");
    assert.equal(data.overview.pendingEstimates, 1);
    assert.equal(data.pipeline.qualified, 1, "the lead is still correctly counted under its own real leads.status too");
    const item = data.attentionItems.find((i) => i.kind === "pending_estimate");
    assert.ok(item, "expected a pending_estimate attention item backed by the real estimate");
  } finally {
    await cleanupFunnelTruthOrg(orgId);
  }
});

test("35. a DRAFT estimate (never sent) is never counted as pending - there is nothing yet for the customer to decide on", async () => {
  const orgId = await makeFunnelTruthOrg("Funnel Truth Test Org (35)");
  try {
    const { data: contact } = await service.from("contacts").insert({ organization_id: orgId, phone: "+15555800007" }).select("id").single();
    const { data: lead } = await service.from("leads").insert({ organization_id: orgId, contact_id: contact!.id, status: "qualified", temperature: "warm", source: "website" }).select("id").single();
    await service.from("estimates").insert({ organization_id: orgId, contact_id: contact!.id, lead_id: lead!.id, title: "Draft quote", status: "draft", amount: 500 });

    const data = await getDashboardData(service, orgId);
    assert.equal(data.pipeline.estimate, 0);
    assert.equal(data.overview.pendingEstimates, 0);
  } finally {
    await cleanupFunnelTruthOrg(orgId);
  }
});

test("36. an ACCEPTED estimate is a decided outcome, not a pending one - never counted", async () => {
  const orgId = await makeFunnelTruthOrg("Funnel Truth Test Org (36)");
  try {
    const { data: contact } = await service.from("contacts").insert({ organization_id: orgId, phone: "+15555800008" }).select("id").single();
    const { data: lead } = await service.from("leads").insert({ organization_id: orgId, contact_id: contact!.id, status: "qualified", temperature: "warm", source: "website" }).select("id").single();
    await service.from("estimates").insert({ organization_id: orgId, contact_id: contact!.id, lead_id: lead!.id, title: "Accepted quote", status: "accepted", amount: 500 });

    const data = await getDashboardData(service, orgId);
    assert.equal(data.pipeline.estimate, 0);
    assert.equal(data.overview.pendingEstimates, 0);
  } finally {
    await cleanupFunnelTruthOrg(orgId);
  }
});

test("37. multiple appointments for the same lead never double-count it in pipeline.appointment", async () => {
  const orgId = await makeFunnelTruthOrg("Funnel Truth Test Org (37)");
  try {
    const { data: contact } = await service.from("contacts").insert({ organization_id: orgId, phone: "+15555800009" }).select("id").single();
    const { data: lead } = await service.from("leads").insert({ organization_id: orgId, contact_id: contact!.id, status: "qualified", temperature: "warm", source: "website" }).select("id").single();
    await service.from("appointments").insert([
      { organization_id: orgId, contact_id: contact!.id, lead_id: lead!.id, title: "First", status: "cancelled", start_at: "2027-02-01T09:00:00.000Z", end_at: "2027-02-01T10:00:00.000Z" },
      { organization_id: orgId, contact_id: contact!.id, lead_id: lead!.id, title: "Rebooked", status: "scheduled", start_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(), end_at: new Date(Date.now() + 25 * 3600 * 1000).toISOString() },
    ]);

    const data = await getDashboardData(service, orgId);
    assert.equal(data.pipeline.appointment, 1, "the same lead must count exactly once even with two real appointment rows");
  } finally {
    await cleanupFunnelTruthOrg(orgId);
  }
});

test("38. multiple estimates for the same lead never double-count it in pipeline.estimate (a current-state, lead-based pipeline stage) - but Phase 4C's own fix means overview.pendingEstimates now correctly counts BOTH estimate rows, matching Analytics' sentEstimates exactly", async () => {
  const orgId = await makeFunnelTruthOrg("Funnel Truth Test Org (38)");
  try {
    const { data: contact } = await service.from("contacts").insert({ organization_id: orgId, phone: "+15555800010" }).select("id").single();
    const { data: lead } = await service.from("leads").insert({ organization_id: orgId, contact_id: contact!.id, status: "qualified", temperature: "warm", source: "website" }).select("id").single();
    await service.from("estimates").insert([
      { organization_id: orgId, contact_id: contact!.id, lead_id: lead!.id, title: "Quote A", status: "sent", amount: 100 },
      { organization_id: orgId, contact_id: contact!.id, lead_id: lead!.id, title: "Quote B", status: "sent", amount: 200 },
    ]);

    const data = await getDashboardData(service, orgId);
    assert.equal(data.pipeline.estimate, 1, "the same lead must still count exactly once in the current-state pipeline stage, even with two real sent-estimate rows");
    assert.equal(
      data.overview.pendingEstimates,
      2,
      "Trackpr 2.0, Phase 4C (P2 #9): overview.pendingEstimates is now a real count of sent estimate ROWS (matching Analytics' BiEstimateMetrics.sentEstimates exactly), not a distinct-lead count - two real sent estimates for the same lead correctly count as 2, never silently collapsed to 1",
    );
  } finally {
    await cleanupFunnelTruthOrg(orgId);
  }
});

test("38b (P2 #9). Dashboard's overview.pendingEstimates and Analytics' sentEstimates now agree exactly, even for a lead with multiple simultaneously-sent estimates", async () => {
  const orgId = await makeFunnelTruthOrg("Funnel Truth Test Org (38b)");
  try {
    const { data: contactA } = await service.from("contacts").insert({ organization_id: orgId, phone: "+15555800011" }).select("id").single();
    const { data: leadA } = await service.from("leads").insert({ organization_id: orgId, contact_id: contactA!.id, status: "qualified", temperature: "warm", source: "website" }).select("id").single();
    await service.from("estimates").insert([
      { organization_id: orgId, contact_id: contactA!.id, lead_id: leadA!.id, title: "Quote A", status: "sent", amount: 100 },
      { organization_id: orgId, contact_id: contactA!.id, lead_id: leadA!.id, title: "Quote B", status: "sent", amount: 200 },
    ]);
    const { data: contactB } = await service.from("contacts").insert({ organization_id: orgId, phone: "+15555800012" }).select("id").single();
    const { data: leadB } = await service.from("leads").insert({ organization_id: orgId, contact_id: contactB!.id, status: "qualified", temperature: "warm", source: "website" }).select("id").single();
    await service.from("estimates").insert({ organization_id: orgId, contact_id: contactB!.id, lead_id: leadB!.id, title: "Quote C", status: "sent", amount: 300 });

    const dashboardData = await getDashboardData(service, orgId);
    const snapshot = await getBusinessMetricsSnapshot(service, orgId, "allTime");

    assert.equal(dashboardData.overview.pendingEstimates, 3, "3 real sent-estimate rows across 2 leads");
    assert.equal(snapshot.estimateMetrics.sentEstimates, 3);
    assert.equal(
      dashboardData.overview.pendingEstimates,
      snapshot.estimateMetrics.sentEstimates,
      "Dashboard and Analytics must report the exact same real number for the exact same underlying fact - the verified P2 #9 unit mismatch is fixed",
    );
  } finally {
    await cleanupFunnelTruthOrg(orgId);
  }
});

test("39. a pending-estimate lead with a NULL estimated_value never renders a fabricated $0 attention value", async () => {
  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, phone: `+1555590${Math.floor(1000 + Math.random() * 8999)}` }).select("id").single();
  const { data: lead } = await service.from("leads").insert({ organization_id: organizationId, contact_id: contact!.id, status: "qualified", temperature: "warm", source: "website", estimated_value: null }).select("id").single();
  await service.from("estimates").insert({ organization_id: organizationId, contact_id: contact!.id, lead_id: lead!.id, title: "Quote", status: "sent", amount: null });

  const data = await getDashboardData(service, organizationId);
  const item = data.attentionItems.find((i) => i.kind === "pending_estimate" && i.href === "/estimates");
  assert.ok(item, "expected the pending_estimate item to still appear even with an unknown value");
  assert.equal(item!.value, null, "a NULL leads.estimated_value must render as null, never a fabricated $0");
});

// ==================== Trackpr 2.0, Phase 2A: the 5 newly-surfaced opportunity-backed attention kinds ====================
//
// Each of these 5 opportunity types was already detected and persisted
// before this pass (lib/opportunities/detect.ts) but had no dashboard
// attention kind at all - see lib/dashboard/queries.ts's own Phase 2A
// comments for exactly why each one is placed where it is in the priority
// list. Every test below goes through the real path: create the underlying
// data, run syncOpportunities, then call getDashboardData - never a bare
// unit test of a helper, matching this file's own established convention.

// Tests 41, 42, and 44 each use their own dedicated, disposable organization
// (mirroring tests 43/45-48's own convention) rather than the shared
// `organizationId` - by this point in the file the shared org has
// accumulated many real, uncleaned higher- and lower-tier attention
// conditions from earlier tests, and the global 10-item cap (test 48) is a
// real, intentional behavior, not something these existence checks should
// have to race against.

test("41. accepted_estimate_no_job: an estimate accepted more than 24h ago with no linked job appears in attentionItems with its real amount", async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Dashboard Attention Test Org (Accepted Estimate)" }).select("id").single();
  const orgId = org!.id;
  try {
    const { data: contact } = await service.from("contacts").insert({ organization_id: orgId, first_name: "AcceptedNoJob", phone: "+15555920001" }).select("id").single();
    const respondedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { data: estimate } = await service
      .from("estimates")
      .insert({ organization_id: orgId, contact_id: contact!.id, title: "Deck rebuild", status: "accepted", amount: 3000, responded_at: respondedAt })
      .select("id")
      .single();

    const sync = await syncOpportunities(service, orgId);
    assert.ok(sync.created >= 1);

    const data = await getDashboardData(service, orgId);
    const item = data.attentionItems.find((i) => i.kind === "accepted_estimate_no_job" && i.opportunityId);
    assert.ok(item, "expected an accepted_estimate_no_job attention item");
    assert.equal(item!.value, "$3,000");
    assert.equal(item!.detail, "Estimate accepted - job not scheduled yet.");
    assert.equal(item!.href, "/estimates");

    const { data: oppRow } = await service.from("opportunities").select("source_entity_id, type").eq("id", item!.opportunityId!).single();
    assert.equal(oppRow?.type, "accepted_estimate_no_job");
    assert.equal(oppRow?.source_entity_id, estimate!.id);
  } finally {
    await service.from("opportunities").delete().eq("organization_id", orgId);
    await service.from("estimates").delete().eq("organization_id", orgId);
    await service.from("contacts").delete().eq("organization_id", orgId);
    await service.from("organizations").delete().eq("id", orgId);
  }
});

test("42. accepted_estimate_no_job: once a job links to the estimate, it no longer appears", async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Dashboard Attention Test Org (Accepted Estimate With Job)" }).select("id").single();
  const orgId = org!.id;
  try {
    const { data: contact } = await service.from("contacts").insert({ organization_id: orgId, first_name: "AcceptedWithJob", phone: "+15555930001" }).select("id").single();
    const respondedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { data: estimate } = await service
      .from("estimates")
      .insert({ organization_id: orgId, contact_id: contact!.id, title: "Fence repair", status: "accepted", amount: 1500, responded_at: respondedAt })
      .select("id")
      .single();
    await service.from("jobs").insert({ organization_id: orgId, contact_id: contact!.id, estimate_id: estimate!.id, title: "Fence repair", status: "scheduled" });

    await syncOpportunities(service, orgId);

    const data = await getDashboardData(service, orgId);
    assert.equal(data.attentionItems.some((i) => i.kind === "accepted_estimate_no_job"), false);
  } finally {
    await service.from("opportunities").delete().eq("organization_id", orgId);
    await service.from("jobs").delete().eq("organization_id", orgId);
    await service.from("estimates").delete().eq("organization_id", orgId);
    await service.from("contacts").delete().eq("organization_id", orgId);
    await service.from("organizations").delete().eq("id", orgId);
  }
});

const LIVE_AUTOMATION_ORG_COLUMNS = { payment_status: "active", automation_mode: "live", automation_paused: false };

test("43. uncontacted_lead: a new, 48h-old lead with no recorded outbound contact appears in attentionItems, and is never double-counted with hot_lead for the same lead", async () => {
  const { data: liveOrg } = await service.from("organizations").insert({ name: "Dashboard Attention Test Org (Uncontacted)", ...LIVE_AUTOMATION_ORG_COLUMNS }).select("id").single();
  const liveOrgId = liveOrg!.id;
  try {
    const oldEnough = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    // A hot, uncontacted lead - eligible for BOTH hot_lead and
    // uncontacted_lead's own detector, proving the dedup rule this pass adds.
    const { data: hotContact } = await service.from("contacts").insert({ organization_id: liveOrgId, first_name: "HotUncontacted", phone: "+15555940001" }).select("id").single();
    const { data: hotLead } = await service.from("leads").insert({ organization_id: liveOrgId, contact_id: hotContact!.id, status: "new", temperature: "hot", source: "website", created_at: oldEnough }).select("id").single();

    // A plain (not hot, not high-value), uncontacted lead - the real,
    // non-duplicate case this attention kind exists for.
    const { data: plainContact } = await service.from("contacts").insert({ organization_id: liveOrgId, first_name: "PlainUncontacted", phone: "+15555940002" }).select("id").single();
    await service.from("leads").insert({ organization_id: liveOrgId, contact_id: plainContact!.id, status: "new", temperature: "cold", source: "website", created_at: oldEnough, estimated_value: null });

    const sync = await syncOpportunities(service, liveOrgId);
    assert.ok(sync.created >= 2, "expected an uncontacted_lead opportunity for both leads");

    const data = await getDashboardData(service, liveOrgId);

    const hotItem = data.attentionItems.find((i) => i.id === `hot-${hotLead!.id}`);
    assert.ok(hotItem, "the hot+uncontacted lead must still appear as hot_lead");
    assert.equal(
      data.attentionItems.some((i) => i.kind === "uncontacted_lead" && i.title === "HotUncontacted"),
      false,
      "a lead already represented by hot_lead must never also appear as uncontacted_lead",
    );

    const plainItem = data.attentionItems.find((i) => i.kind === "uncontacted_lead" && i.title === "PlainUncontacted");
    assert.ok(plainItem, "expected the plain (non-hot, non-high-value) uncontacted lead to appear");
    assert.equal(plainItem!.value, null, "a NULL estimated_value must render as null, never a fabricated $0");
    assert.equal(plainItem!.detail, "Lead hasn't been contacted yet.");
    assert.equal(plainItem!.href, "/leads");
  } finally {
    await service.from("opportunities").delete().eq("organization_id", liveOrgId);
    await service.from("leads").delete().eq("organization_id", liveOrgId);
    await service.from("contacts").delete().eq("organization_id", liveOrgId);
    await service.from("organizations").delete().eq("id", liveOrgId);
  }
});

test("44. cancelled_appointment_no_rebooking: a cancellation past the grace period with no later booking appears in attentionItems", async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Dashboard Attention Test Org (Cancelled No Rebooking)" }).select("id").single();
  const orgId = org!.id;
  try {
    const { data: contact } = await service.from("contacts").insert({ organization_id: orgId, first_name: "CancelledNoRebook", phone: "+15555950001" }).select("id").single();
    const pastGracePeriod = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
    const { data: appointment } = await service
      .from("appointments")
      .insert({ organization_id: orgId, contact_id: contact!.id, title: "Cancelled visit", status: "cancelled", start_at: "2027-04-01T09:00:00.000Z", end_at: "2027-04-01T10:00:00.000Z", updated_at: pastGracePeriod })
      .select("id")
      .single();

    const sync = await syncOpportunities(service, orgId);
    assert.ok(sync.created >= 1);

    const data = await getDashboardData(service, orgId);
    const item = data.attentionItems.find((i) => i.kind === "cancelled_appointment_no_rebooking");
    assert.ok(item, "expected a cancelled_appointment_no_rebooking attention item");
    assert.equal(item!.value, null);
    assert.equal(item!.detail, "Cancelled appointment needs rebooking.");
    assert.equal(item!.href, "/appointments");

    const { data: oppRow } = await service.from("opportunities").select("source_entity_id, type").eq("id", item!.opportunityId!).single();
    assert.equal(oppRow?.type, "cancelled_appointment_no_rebooking");
    assert.equal(oppRow?.source_entity_id, appointment!.id);
  } finally {
    await service.from("opportunities").delete().eq("organization_id", orgId);
    await service.from("appointments").delete().eq("organization_id", orgId);
    await service.from("contacts").delete().eq("organization_id", orgId);
    await service.from("organizations").delete().eq("id", orgId);
  }
});

test("45. completed_job_no_review_request and completed_job_no_referral_request both appear for a completed job with neither request sent, with the documented value divergence between them", async () => {
  const { data: reviewOrg } = await service.from("organizations").insert({ name: "Dashboard Attention Test Org (Review/Referral)", review_url: "https://example.com/leave-a-review" }).select("id").single();
  const reviewOrgId = reviewOrg!.id;
  try {
    const { data: contact } = await service.from("contacts").insert({ organization_id: reviewOrgId, first_name: "NeedsAsk", phone: "+15555960001" }).select("id").single();
    const { data: job } = await service
      .from("jobs")
      .insert({ organization_id: reviewOrgId, contact_id: contact!.id, title: "Roof replacement", status: "completed", amount: 8000, completed_at: new Date().toISOString() })
      .select("id")
      .single();

    const sync = await syncOpportunities(service, reviewOrgId);
    assert.ok(sync.created >= 2, "expected both a review-request and a referral-request opportunity");

    const data = await getDashboardData(service, reviewOrgId);

    const reviewItem = data.attentionItems.find((i) => i.kind === "completed_job_no_review_request");
    assert.ok(reviewItem, "expected a completed_job_no_review_request attention item");
    assert.equal(reviewItem!.detail, "Review request still needed.");
    assert.equal(reviewItem!.value, "$8,000", "unlike the referral kind, this one surfaces the completed job's known value");
    assert.equal(reviewItem!.href, `/jobs/${job!.id}`);

    const referralItem = data.attentionItems.find((i) => i.kind === "completed_job_no_referral_request");
    assert.ok(referralItem, "expected a completed_job_no_referral_request attention item");
    assert.equal(referralItem!.detail, "Referral request still needed.");
    assert.equal(referralItem!.value, null, "a referral ask deliberately never carries a dollar value");
    assert.equal(referralItem!.href, `/jobs/${job!.id}`);
  } finally {
    await service.from("opportunities").delete().eq("organization_id", reviewOrgId);
    await service.from("jobs").delete().eq("organization_id", reviewOrgId);
    await service.from("contacts").delete().eq("organization_id", reviewOrgId);
    await service.from("organizations").delete().eq("id", reviewOrgId);
  }
});

test("46. completed_job_no_review_request: an org with no review_url configured never produces one, even for a completed job with no review request", async () => {
  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "NoReviewUrlOrg", phone: `+1555597${Math.floor(1000 + Math.random() * 8999)}` }).select("id").single();
  await service.from("jobs").insert({ organization_id: organizationId, contact_id: contact!.id, title: "Gutter cleaning", status: "completed", amount: 400, completed_at: new Date().toISOString() });

  await syncOpportunities(service, organizationId);

  const data = await getDashboardData(service, organizationId);
  assert.equal(
    data.attentionItems.some((i) => i.kind === "completed_job_no_review_request" && i.title === "NoReviewUrlOrg"),
    false,
    "an organization with no review_url configured must never produce a review-request opportunity",
  );
});

// ==================== Trackpr 2.0, Phase 2A: priority order and the cap ====================

test("47. priority order: human_escalation (tier 1) ranks ahead of hot_lead (tier 3), which ranks ahead of dormant_customer (tier 4), in the same attentionItems array", async () => {
  const { data: orderOrg } = await service.from("organizations").insert({ name: "Dashboard Attention Test Org (Priority Order)" }).select("id").single();
  const orderOrgId = orderOrg!.id;
  try {
    const conversationId = "55555555-5555-4555-8555-555555555555";
    const { data: incident } = await service
      .rpc("record_automation_incident_signal", {
        p_organization_id: orderOrgId,
        p_category: "human_escalation_requested",
        p_severity: "warning",
        p_fingerprint: `human_escalation_requested:${conversationId}`,
        p_title: "AI escalated a conversation to a human",
        p_metadata: { conversationId },
      })
      .single();

    const { data: hotContact } = await service.from("contacts").insert({ organization_id: orderOrgId, first_name: "OrderHot", phone: "+15555980001" }).select("id").single();
    const { data: hotLead } = await service.from("leads").insert({ organization_id: orderOrgId, contact_id: hotContact!.id, status: "qualified", temperature: "hot", source: "website" }).select("id").single();

    const { data: dormantContact } = await service.from("contacts").insert({ organization_id: orderOrgId, first_name: "OrderDormant", phone: "+15555980002" }).select("id").single();
    const oldCompletedAt = new Date(Date.now() - 250 * 24 * 60 * 60 * 1000).toISOString();
    await service.from("jobs").insert({ organization_id: orderOrgId, contact_id: dormantContact!.id, title: "Old job", status: "completed", completed_at: oldCompletedAt });

    await syncOpportunities(service, orderOrgId);
    const data = await getDashboardData(service, orderOrgId);

    const escalationIndex = data.attentionItems.findIndex((i) => i.kind === "human_escalation");
    const hotIndex = data.attentionItems.findIndex((i) => i.id === `hot-${hotLead!.id}`);
    const dormantIndex = data.attentionItems.findIndex((i) => i.kind === "dormant_customer");

    assert.ok(escalationIndex !== -1 && hotIndex !== -1 && dormantIndex !== -1, "expected all three tiers to be represented");
    assert.ok(escalationIndex < hotIndex, "human_escalation (tier 1) must rank ahead of hot_lead (tier 3)");
    assert.ok(hotIndex < dormantIndex, "hot_lead (tier 3) must rank ahead of dormant_customer (tier 4)");

    await service.from("automation_incidents").delete().eq("id", (incident as { id: string }).id);
  } finally {
    await service.from("opportunities").delete().eq("organization_id", orderOrgId);
    await service.from("jobs").delete().eq("organization_id", orderOrgId);
    await service.from("leads").delete().eq("organization_id", orderOrgId);
    await service.from("contacts").delete().eq("organization_id", orderOrgId);
    await service.from("organizations").delete().eq("id", orderOrgId);
  }
});

test("48. the 10-item cap keeps the highest-priority kind and drops only the lowest-priority overflow", async () => {
  const { data: capOrg } = await service.from("organizations").insert({ name: "Dashboard Attention Test Org (Cap)" }).select("id").single();
  const capOrgId = capOrg!.id;
  try {
    const conversationId = "66666666-6666-4666-8666-666666666666";
    const { data: incident } = await service
      .rpc("record_automation_incident_signal", {
        p_organization_id: capOrgId,
        p_category: "human_escalation_requested",
        p_severity: "warning",
        p_fingerprint: `human_escalation_requested:${conversationId}`,
        p_title: "AI escalated a conversation to a human",
        p_metadata: { conversationId },
      })
      .single();

    // 5 overdue appointments (tier 2, per-kind cap of 5) + 5 awaiting-
    // confirmation appointments (tier 2, per-kind cap of 5) + the one
    // human_escalation above = 11 candidates competing for the global
    // 10-item cap - exactly one must be dropped, and it must be the LAST
    // one in priority order (the 5th awaiting_confirmation item), never
    // the human_escalation.
    // A single captured `now` (not a fresh Date.now() per iteration) plus a
    // 2-hour stride for each 1-hour-long appointment - guarantees a real
    // gap between every pair, so this never races the database's own
    // appointments_no_overlap exclusion constraint the way computing each
    // window from a separately-read wall clock could.
    const now = Date.now();
    const contacts: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { data: contact } = await service.from("contacts").insert({ organization_id: capOrgId, first_name: `Overdue${i}`, phone: `+1555599${1000 + i}` }).select("id").single();
      contacts.push(contact!.id);
      await service.from("appointments").insert({
        organization_id: capOrgId,
        contact_id: contact!.id,
        title: `Overdue ${i}`,
        status: "scheduled",
        start_at: new Date(now - (2 + 2 * i) * 60 * 60 * 1000).toISOString(),
        end_at: new Date(now - (1 + 2 * i) * 60 * 60 * 1000).toISOString(),
      });
    }
    for (let i = 0; i < 5; i++) {
      const { data: contact } = await service.from("contacts").insert({ organization_id: capOrgId, first_name: `Confirming${i}`, phone: `+1555599${2000 + i}` }).select("id").single();
      contacts.push(contact!.id);
      await service.from("appointments").insert({
        organization_id: capOrgId,
        contact_id: contact!.id,
        title: `Confirming ${i}`,
        status: "scheduled",
        start_at: new Date(now + (2 + 2 * i) * 60 * 60 * 1000).toISOString(),
        end_at: new Date(now + (3 + 2 * i) * 60 * 60 * 1000).toISOString(),
        confirmation_requested_at: new Date(now - 60 * 60 * 1000).toISOString(),
      });
    }

    const data = await getDashboardData(service, capOrgId);
    assert.equal(data.attentionItems.length, 10, "the cap must still be exactly 10");
    assert.equal(data.attentionItems.filter((i) => i.kind === "human_escalation").length, 1, "human_escalation must never be squeezed out by lower-priority overflow");
    assert.equal(data.attentionItems.filter((i) => i.kind === "overdue_appointment").length, 5, "all 5 overdue_appointment items must survive - they rank ahead of awaiting_confirmation");
    assert.equal(data.attentionItems.filter((i) => i.kind === "awaiting_confirmation").length, 4, "exactly 1 of the 5 awaiting_confirmation items must be dropped by the cap - the lowest-priority overflow");

    await service.from("automation_incidents").delete().eq("id", (incident as { id: string }).id);
  } finally {
    await service.from("appointments").delete().eq("organization_id", capOrgId);
    await service.from("contacts").delete().eq("organization_id", capOrgId);
    await service.from("organizations").delete().eq("id", capOrgId);
  }
});

test("49. organization isolation: organization A's real appointment/estimate never inflates organization B's pipeline/overview counts", async () => {
  const { data: otherOrg } = await service.from("organizations").insert({ name: "Dashboard Attention Test Org (Other, Funnel Truth)" }).select("id").single();
  try {
    const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, phone: `+1555591${Math.floor(1000 + Math.random() * 8999)}` }).select("id").single();
    const { data: lead } = await service.from("leads").insert({ organization_id: organizationId, contact_id: contact!.id, status: "qualified", temperature: "warm", source: "website" }).select("id").single();
    await service.from("appointments").insert({ organization_id: organizationId, contact_id: contact!.id, lead_id: lead!.id, title: "Consult", status: "scheduled", start_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(), end_at: new Date(Date.now() + 25 * 3600 * 1000).toISOString() });
    await service.from("estimates").insert({ organization_id: organizationId, contact_id: contact!.id, lead_id: lead!.id, title: "Quote", status: "sent", amount: 400 });

    const dataOther = await getDashboardData(service, otherOrg!.id);
    assert.equal(dataOther.pipeline.appointment, 0);
    assert.equal(dataOther.pipeline.estimate, 0);
    assert.equal(dataOther.overview.pendingEstimates, 0);
  } finally {
    await service.from("organizations").delete().eq("id", otherOrg!.id);
  }
});

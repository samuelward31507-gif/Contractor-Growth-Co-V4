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

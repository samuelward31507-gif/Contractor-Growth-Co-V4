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

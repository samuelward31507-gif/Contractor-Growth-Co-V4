/**
 * Phase 2-8: completed visit with no estimate (M1-M5, M8) and the Today /
 * Insights parity (M6) against real, disposable rows on the TEST project
 * configured in .env.local (service-role client) - one organization per
 * test, every row deleted in finally.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/opportunities/detect.completed-visit.integration.test.ts
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
const { getBusinessMetricsSnapshot }: typeof import("@/lib/bi/metrics") = require(path.join(REPO_ROOT, "lib/bi/metrics.ts"));

const service = createServiceRoleClient();
const H = 60 * 60 * 1000;
const at = (hoursFromNow: number) => new Date(Date.now() + hoursFromNow * H).toISOString();

async function makeOrg(label: string) {
  const { data, error } = await service.from("organizations").insert({ name: `Completed Visit Test Org (${label})`, payment_status: "active" }).select("id").single();
  assert.ifError(error);
  return data!.id as string;
}

async function makeContact(orgId: string, phone: string) {
  const { data, error } = await service.from("contacts").insert({ organization_id: orgId, first_name: "Visit", last_name: phone.slice(-4), phone }).select("id").single();
  assert.ifError(error);
  return data!.id as string;
}

async function makeLead(orgId: string, contactId: string, opts: { status?: string; createdAt?: string } = {}) {
  const { data, error } = await service
    .from("leads")
    .insert({ organization_id: orgId, contact_id: contactId, status: opts.status ?? "estimate", temperature: "warm", source: "website", ...(opts.createdAt ? { created_at: opts.createdAt } : {}) })
    .select("id")
    .single();
  assert.ifError(error);
  return data!.id as string;
}

async function makeVisit(orgId: string, opts: { contactId: string | null; leadId?: string | null; startHours: number; status?: string }) {
  const { data, error } = await service
    .from("appointments")
    .insert({ organization_id: orgId, contact_id: opts.contactId, lead_id: opts.leadId ?? null, title: "Visit", start_at: at(opts.startHours), end_at: at(opts.startHours + 0.05), status: opts.status ?? "completed" })
    .select("id")
    .single();
  assert.ifError(error);
  return data!.id as string;
}

async function makeEstimate(orgId: string, opts: { contactId: string | null; leadId?: string | null; createdHours: number; status?: string }) {
  const { error } = await service.from("estimates").insert({ organization_id: orgId, contact_id: opts.contactId, lead_id: opts.leadId ?? null, title: "Quote", status: opts.status ?? "draft", amount: 900, created_at: at(opts.createdHours) });
  assert.ifError(error);
}

const visitItems = async (orgId: string) => (await detectAllOpportunityCandidates(service, orgId)).filter((c) => c.type === "completed_appointment_no_estimate").map((c) => [c.sourceEntityId, c.metadata.lead_id]);

async function cleanupOrg(orgId: string) {
  for (const table of ["opportunities", "opportunity_sync_state", "jobs", "estimates", "appointments", "leads", "contacts"]) await service.from(table).delete().eq("organization_id", orgId);
  await service.from("organizations").delete().eq("id", orgId);
}

test("1. real rows: a lead-linked visit and a lead-less visit after the contact's open lead was created are flagged; a lead-less visit before the lead, or with no lead, is not", async () => {
  const orgId = await makeOrg("1");
  try {
    const linkedContact = await makeContact(orgId, "+15555628001");
    const linkedLead = await makeLead(orgId, linkedContact);
    const linkedVisit = await makeVisit(orgId, { contactId: linkedContact, leadId: linkedLead, startHours: -5 });

    const fallbackContact = await makeContact(orgId, "+15555628002");
    const fallbackLead = await makeLead(orgId, fallbackContact, { createdAt: at(-48) });
    const fallbackVisit = await makeVisit(orgId, { contactId: fallbackContact, startHours: -6 });

    const earlyContact = await makeContact(orgId, "+15555628003");
    await makeLead(orgId, earlyContact);
    await makeVisit(orgId, { contactId: earlyContact, startHours: -240 });

    const orphanContact = await makeContact(orgId, "+15555628004");
    await makeVisit(orgId, { contactId: orphanContact, startHours: -7 });

    assert.deepEqual((await visitItems(orgId)).sort(), [[linkedVisit, linkedLead], [fallbackVisit, fallbackLead]].sort());
  } finally {
    await cleanupOrg(orgId);
  }
});

test("2. real rows: won and lost leads, a job for the lead, any lead-linked estimate (declined), or a lead-less estimate after the visit clear it; one before the visit or for another contact does not", async () => {
  const orgId = await makeOrg("2");
  try {
    const cases: [string, (contactId: string, leadId: string) => Promise<void>, boolean][] = [
      ["won", async (_c, leadId) => void (await service.from("leads").update({ status: "won" }).eq("id", leadId)), false],
      ["lost", async (_c, leadId) => void (await service.from("leads").update({ status: "lost" }).eq("id", leadId)), false],
      ["job", async (contactId, leadId) => { const { error } = await service.from("jobs").insert({ organization_id: orgId, contact_id: contactId, lead_id: leadId, title: "Direct job", status: "scheduled" }); assert.ifError(error); }, false],
      ["declined estimate", (contactId, leadId) => makeEstimate(orgId, { contactId, leadId, createdHours: -500, status: "declined" }), false],
      ["lead-less estimate after", (contactId) => makeEstimate(orgId, { contactId, createdHours: -2 }), false],
      ["lead-less estimate before", (contactId) => makeEstimate(orgId, { contactId, createdHours: -20 }), true],
      ["other contact's estimate", async () => makeEstimate(orgId, { contactId: await makeContact(orgId, "+15555628099"), createdHours: -2 }), true],
    ];
    const expected: string[] = [];
    let n = 10;
    for (const [label, arrange, flagged] of cases) {
      const contactId = await makeContact(orgId, `+155556280${n++}`);
      const leadId = await makeLead(orgId, contactId, { createdAt: at(-48) });
      // Every visit sits between 10h and 11h ago: the 'after' estimate (-2h) follows it, the 'before' one (-20h) precedes it.
      await makeVisit(orgId, { contactId, leadId, startHours: -10 - (n - 10) * 0.1 });
      await arrange(contactId, leadId);
      if (flagged) expected.push(leadId);
      void label;
    }
    assert.deepEqual((await visitItems(orgId)).map(([, leadId]) => leadId).sort(), expected.sort());
  } finally {
    await cleanupOrg(orgId);
  }
});

test("3. real rows (M5): several visits for one lead sync to one row on the latest visit; a dismissed older visit suppresses it; an open older row resolves once", async () => {
  const orgId = await makeOrg("3");
  try {
    const contactId = await makeContact(orgId, "+15555628030");
    const leadId = await makeLead(orgId, contactId, { createdAt: at(-500) });
    const older = await makeVisit(orgId, { contactId, leadId, startHours: -300 });
    const latest = await makeVisit(orgId, { contactId, startHours: -10 });

    // An open row on the older visit (the pre-2-8 one-per-appointment shape): resolves, and the latest visit's row is created.
    const { error } = await service.from("opportunities").insert({ organization_id: orgId, type: "completed_appointment_no_estimate", source_entity_type: "appointment", source_entity_id: older, contact_id: contactId, title: "Older visit" });
    assert.ifError(error);
    const first = await syncOpportunities(service, orgId);
    assert.deepEqual([first.resolved, first.created], [1, 1]);
    const { data: rows } = await service.from("opportunities").select("source_entity_id, status, resolution_reason").eq("organization_id", orgId).eq("type", "completed_appointment_no_estimate").order("created_at");
    assert.deepEqual(rows!.map((r) => [r.source_entity_id === older ? "older" : r.source_entity_id === latest ? "latest" : "?", r.status, r.resolution_reason]), [["older", "resolved", "condition_no_longer_true"], ["latest", "open", null]]);
    const second = await syncOpportunities(service, orgId);
    assert.equal(second.created, 0);

    // A dismissal on the older visit carries forward: dismiss nothing on the latest, re-open the scenario cleanly.
    await service.from("opportunities").delete().eq("organization_id", orgId);
    const { error: dismissError } = await service.from("opportunities").insert({ organization_id: orgId, type: "completed_appointment_no_estimate", source_entity_type: "appointment", source_entity_id: older, contact_id: contactId, title: "Older visit", status: "dismissed", resolved_at: new Date().toISOString(), resolution_reason: "dismissed" });
    assert.ifError(dismissError);
    const third = await syncOpportunities(service, orgId);
    assert.equal(third.suppressed, 1);
    const { data: open } = await service.from("opportunities").select("id").eq("organization_id", orgId).eq("type", "completed_appointment_no_estimate").eq("status", "open");
    assert.deepEqual(open, []);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("4. real rows (M6, M9 parity): Insights' 'Visits, no estimate' and 'Qualified, no appointment' equal Today's open items - including after a dismissal", async () => {
  const orgId = await makeOrg("4");
  try {
    // Visits: one flagged linked visit, one flagged lead-less visit, one lead with two visits (one item), one cleared by a lead-less estimate, one won lead.
    const contacts = await Promise.all(Array.from({ length: 9 }, (_, i) => makeContact(orgId, `+15555628${100 + i}`)));
    const l0 = await makeLead(orgId, contacts[0]);
    await makeVisit(orgId, { contactId: contacts[0], leadId: l0, startHours: -5 });
    await makeLead(orgId, contacts[1], { createdAt: at(-48) });
    await makeVisit(orgId, { contactId: contacts[1], startHours: -6 });
    const l2 = await makeLead(orgId, contacts[2], { createdAt: at(-500) });
    await makeVisit(orgId, { contactId: contacts[2], leadId: l2, startHours: -300 });
    await makeVisit(orgId, { contactId: contacts[2], leadId: l2, startHours: -7 });
    const l3 = await makeLead(orgId, contacts[3], { createdAt: at(-48) });
    await makeVisit(orgId, { contactId: contacts[3], leadId: l3, startHours: -8 });
    await makeEstimate(orgId, { contactId: contacts[3], createdHours: -2 });
    const l4 = await makeLead(orgId, contacts[4], { status: "won" });
    await makeVisit(orgId, { contactId: contacts[4], leadId: l4, startHours: -9 });
    // Qualified: unbooked, booked by link, booked by lead-less fallback, only cancelled, lead-less from before the lead.
    await makeLead(orgId, contacts[5], { status: "qualified" });
    const q6 = await makeLead(orgId, contacts[6], { status: "qualified" });
    await makeVisit(orgId, { contactId: contacts[6], leadId: q6, startHours: 30, status: "scheduled" });
    await makeLead(orgId, contacts[7], { status: "qualified", createdAt: at(-48) });
    await makeVisit(orgId, { contactId: contacts[7], startHours: 33, status: "scheduled" });
    const q8 = await makeLead(orgId, contacts[8], { status: "qualified" });
    await makeVisit(orgId, { contactId: contacts[8], leadId: q8, startHours: 36, status: "cancelled" });

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    const candidateCount = (type: string) => candidates.filter((c) => c.type === type).length;
    assert.equal(candidateCount("completed_appointment_no_estimate"), 3, "l0, the lead-less visit's lead, and l2 once");
    assert.equal(candidateCount("qualified_lead_unbooked"), 2, "contacts 5 (no appointment) and 8 (only cancelled)");

    // Today's open rows after the sync, then after dismissing one visit item - Insights must match both times.
    const openCount = async (type: string) => (await service.from("opportunities").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("type", type).eq("status", "open")).count;
    await syncOpportunities(service, orgId);
    let snapshot = await getBusinessMetricsSnapshot(service, orgId, "allTime");
    assert.deepEqual([snapshot.revenueOpportunity.completedAppointmentsWithoutEstimate, snapshot.revenueOpportunity.qualifiedLeadsWithoutAppointment], [await openCount("completed_appointment_no_estimate"), await openCount("qualified_lead_unbooked")]);
    assert.deepEqual([snapshot.revenueOpportunity.completedAppointmentsWithoutEstimate, snapshot.revenueOpportunity.qualifiedLeadsWithoutAppointment], [3, 2]);

    const { data: toDismiss } = await service.from("opportunities").select("id").eq("organization_id", orgId).eq("type", "completed_appointment_no_estimate").eq("status", "open").limit(1).single();
    await service.from("opportunities").update({ status: "dismissed", resolved_at: new Date().toISOString(), resolution_reason: "dismissed" }).eq("id", toDismiss!.id);
    await syncOpportunities(service, orgId);
    snapshot = await getBusinessMetricsSnapshot(service, orgId, "allTime");
    assert.equal(snapshot.revenueOpportunity.completedAppointmentsWithoutEstimate, 2, "the dismissed item is no longer counted");
    assert.equal(snapshot.revenueOpportunity.completedAppointmentsWithoutEstimate, await openCount("completed_appointment_no_estimate"));
    assert.deepEqual(snapshot.revenueOpportunityUnavailable, { qualifiedNoAppointment: false, visitsNoEstimate: false, estimates: false });
  } finally {
    await cleanupOrg(orgId);
  }
});

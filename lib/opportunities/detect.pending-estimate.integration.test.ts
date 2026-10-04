/**
 * Phase 2-6: pending estimates keyed to the estimate (A1, A13), the
 * same-lead dedup through metadata.lead_id (B8), and the B1 dismissal
 * carry-forward - against real, disposable rows on the TEST project
 * configured in .env.local (service-role client), one organization per
 * test, every row deleted in finally.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/opportunities/detect.pending-estimate.integration.test.ts
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
const { getPrioritizedOpportunities }: typeof import("./intelligence") = require(path.join(REPO_ROOT, "lib/opportunities/intelligence.ts"));
const { opportunityActionHref }: typeof import("@/lib/decisions/registry") = require(path.join(REPO_ROOT, "lib/decisions/registry.ts"));

const service = createServiceRoleClient();
const SENT_AT = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();

async function makeOrg(label: string) {
  const { data, error } = await service.from("organizations").insert({ name: `Pending Estimate Test Org (${label})`, payment_status: "active" }).select("id").single();
  assert.ifError(error);
  return data!.id as string;
}

async function makeContact(orgId: string, phone: string) {
  const { data, error } = await service.from("contacts").insert({ organization_id: orgId, first_name: "Pending", last_name: phone.slice(-4), phone }).select("id").single();
  assert.ifError(error);
  return data!.id as string;
}

async function makeLead(orgId: string, contactId: string, status = "estimate") {
  const { data, error } = await service.from("leads").insert({ organization_id: orgId, contact_id: contactId, status, temperature: "warm", source: "website" }).select("id").single();
  assert.ifError(error);
  return data!.id as string;
}

async function makeEstimate(orgId: string, opts: { contactId: string | null; leadId: string | null; title: string; sentAt?: string | null }) {
  const { data, error } = await service
    .from("estimates")
    .insert({ organization_id: orgId, contact_id: opts.contactId, lead_id: opts.leadId, title: opts.title, amount: 1500, status: "sent", sent_at: opts.sentAt === undefined ? SENT_AT : opts.sentAt })
    .select("id")
    .single();
  assert.ifError(error);
  return data!.id as string;
}

async function openPending(orgId: string) {
  const { data, error } = await service.from("opportunities").select("id, source_entity_type, source_entity_id, contact_id, metadata").eq("organization_id", orgId).eq("type", "pending_estimate").eq("status", "open");
  assert.ifError(error);
  return data!;
}

async function cleanupOrg(orgId: string) {
  for (const table of ["opportunities", "opportunity_sync_state", "estimates", "leads", "contacts"]) await service.from(table).delete().eq("organization_id", orgId);
  await service.from("organizations").delete().eq("id", orgId);
}

test("1. real rows: a sent estimate with no lead, and one with no lead and no contact, are both estimate-keyed candidates with the right metadata", async () => {
  const orgId = await makeOrg("1");
  try {
    const contactId = await makeContact(orgId, "+15555626001");
    const withContact = await makeEstimate(orgId, { contactId, leadId: null, title: "No lead" });
    const nobody = await makeEstimate(orgId, { contactId: null, leadId: null, title: "Nobody" });

    const candidates = (await detectAllOpportunityCandidates(service, orgId)).filter((c) => c.type === "pending_estimate");
    const byId = new Map(candidates.map((c) => [c.sourceEntityId, c]));
    assert.equal(candidates.length, 2);
    assert.equal(byId.get(withContact)!.sourceEntityType, "estimate");
    assert.equal(byId.get(withContact)!.contactId, contactId);
    assert.deepEqual(byId.get(withContact)!.metadata, { estimate_id: withContact, sent_at: byId.get(withContact)!.metadata.sent_at, lead_id: null });
    assert.equal(Date.parse(byId.get(withContact)!.metadata.sent_at as string), Date.parse(SENT_AT));
    assert.equal(byId.get(nobody)!.contactId, null);
    assert.equal(byId.get(nobody)!.title, "Nobody");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("2. real rows: two sent estimates on one lead are two rows after sync; a second sync creates no duplicate; links resolve to each estimate", async () => {
  const orgId = await makeOrg("2");
  try {
    const contactId = await makeContact(orgId, "+15555626002");
    const leadId = await makeLead(orgId, contactId);
    const a = await makeEstimate(orgId, { contactId, leadId, title: "A" });
    const b = await makeEstimate(orgId, { contactId, leadId, title: "B" });

    await syncOpportunities(service, orgId);
    const second = await syncOpportunities(service, orgId);
    assert.equal(second.created, 0);
    const rows = await openPending(orgId);
    assert.deepEqual(rows.map((row) => row.source_entity_id).sort(), [a, b].sort());
    assert.ok(rows.every((row) => row.source_entity_type === "estimate" && (row.metadata as { lead_id: string }).lead_id === leadId));

    const prioritized = (await getPrioritizedOpportunities(service, orgId)).filter((p) => p.opportunity.type === "pending_estimate");
    assert.deepEqual(prioritized.map((p) => opportunityActionHref(p.opportunity)).sort(), [`/estimates/${a}`, `/estimates/${b}`].sort());
  } finally {
    await cleanupOrg(orgId);
  }
});

test("3. real rows (B1): a dismissed lead-keyed pending_estimate row suppresses the lead's estimate-keyed candidate; an estimate-keyed dismissal suppresses that estimate", async () => {
  const orgId = await makeOrg("3");
  try {
    const contactId = await makeContact(orgId, "+15555626003");
    const leadId = await makeLead(orgId, contactId);
    const leadEstimate = await makeEstimate(orgId, { contactId, leadId, title: "Lead estimate" });
    const freeEstimate = await makeEstimate(orgId, { contactId, leadId: null, title: "Free estimate" });
    const { error } = await service.from("opportunities").insert({
      organization_id: orgId, type: "pending_estimate", source_entity_type: "lead", source_entity_id: leadId, contact_id: contactId,
      status: "dismissed", resolved_at: new Date().toISOString(), resolution_reason: "dismissed", title: "Old lead-keyed", metadata: { estimate_id: leadEstimate },
    });
    assert.ifError(error);

    const first = await syncOpportunities(service, orgId);
    assert.equal(first.suppressed, 1);
    assert.deepEqual((await openPending(orgId)).map((row) => row.source_entity_id), [freeEstimate]);

    const [freeRow] = await openPending(orgId);
    await service.from("opportunities").update({ status: "dismissed", resolved_at: new Date().toISOString(), resolution_reason: "dismissed" }).eq("id", freeRow.id);
    const second = await syncOpportunities(service, orgId);
    assert.equal(second.created, 0);
    assert.equal(second.suppressed, 2);
    assert.deepEqual(await openPending(orgId), []);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("4. real rows: the one-time re-key churn - an open lead-keyed row resolves as condition_no_longer_true and the estimate-keyed row is created", async () => {
  const orgId = await makeOrg("4");
  try {
    const contactId = await makeContact(orgId, "+15555626004");
    const leadId = await makeLead(orgId, contactId);
    const estimateId = await makeEstimate(orgId, { contactId, leadId, title: "Rekey" });
    const { data: old, error } = await service
      .from("opportunities")
      .insert({ organization_id: orgId, type: "pending_estimate", source_entity_type: "lead", source_entity_id: leadId, contact_id: contactId, title: "Old lead-keyed", metadata: { estimate_id: estimateId } })
      .select("id")
      .single();
    assert.ifError(error);

    const result = await syncOpportunities(service, orgId);
    assert.equal(result.resolved, 1);
    const { data: oldRow } = await service.from("opportunities").select("status, resolution_reason").eq("id", old!.id).single();
    assert.deepEqual([oldRow!.status, oldRow!.resolution_reason], ["resolved", "condition_no_longer_true"]);
    assert.deepEqual((await openPending(orgId)).map((row) => [row.source_entity_type, row.source_entity_id]), [["estimate", estimateId]]);
  } finally {
    await cleanupOrg(orgId);
  }
});

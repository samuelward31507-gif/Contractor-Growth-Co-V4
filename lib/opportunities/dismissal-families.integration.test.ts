/**
 * Phase 2-9 (A15/B6, rulings Q1-Q5): directed cross-type dismissal
 * carry-forward against real, disposable rows on the TEST project configured
 * in .env.local (service-role client) - one organization per test, every row
 * deleted in finally.
 *
 * Q3 (the job/invoice family is not carried) is covered offline in
 * detect.scale.test.ts only: an overdue invoice needs an issued invoice, and
 * issued invoices can never be deleted (invoices_guard_delete), so a TEST
 * case would leave a fixture behind on every run.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/opportunities/dismissal-families.integration.test.ts
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
const { syncOpportunities }: typeof import("./detect") = require(path.join(REPO_ROOT, "lib/opportunities/detect.ts"));

const service = createServiceRoleClient();
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

async function makeOrg(label: string) {
  const { data, error } = await service.from("organizations").insert({ name: `Dismissal Family Test Org (${label})`, payment_status: "active", timezone: "UTC" }).select("id").single();
  assert.ifError(error);
  return data!.id as string;
}

async function insert(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await service.from(table).insert(row).select("id").single();
  assert.ifError(error);
  return data!.id as string;
}

async function dismissed(orgId: string, type: string, sourceType: string, sourceId: string, contactId: string | null) {
  await insert("opportunities", { organization_id: orgId, type, source_entity_type: sourceType, source_entity_id: sourceId, contact_id: contactId, title: `Dismissed ${type}`, status: "dismissed", resolved_at: new Date().toISOString(), resolution_reason: "dismissed" });
}

async function openSources(orgId: string, type: string) {
  const { data, error } = await service.from("opportunities").select("source_entity_id").eq("organization_id", orgId).eq("type", type).eq("status", "open");
  assert.ifError(error);
  return data!.map((row) => row.source_entity_id as string).sort();
}

async function cleanupOrg(orgId: string) {
  for (const table of ["opportunities", "opportunity_sync_state", "estimates", "leads", "contacts"]) await service.from(table).delete().eq("organization_id", orgId);
  await service.from("organizations").delete().eq("id", orgId);
}

test("1. (Q1) a dismissed pending estimate suppresses the expired estimate for the same estimate id; another expired estimate on the same lead appears; a second sync stays clean", async () => {
  const orgId = await makeOrg("1");
  try {
    const contactId = await insert("contacts", { organization_id: orgId, phone: "+15555629001" });
    const leadId = await insert("leads", { organization_id: orgId, contact_id: contactId, status: "estimate", temperature: "warm", source: "website" });
    const dismissedEstimate = await insert("estimates", { organization_id: orgId, contact_id: contactId, lead_id: leadId, title: "Dismissed then expired", status: "expired", amount: 700, sent_at: ago(40) });
    const sameLead = await insert("estimates", { organization_id: orgId, contact_id: contactId, lead_id: leadId, title: "Same lead, expired", status: "expired", amount: 900, sent_at: ago(40) });
    await dismissed(orgId, "pending_estimate", "estimate", dismissedEstimate, contactId);

    const first = await syncOpportunities(service, orgId);
    assert.equal(first.suppressed, 1);
    assert.deepEqual(await openSources(orgId, "stale_estimate"), [sameLead]);
    const second = await syncOpportunities(service, orgId);
    assert.deepEqual([second.created, second.suppressed], [0, 1]);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("2. (Q2b) a dismissed uncontacted or qualified-unbooked lead suppresses only the later active_lead_signal for the same lead; an untouched hot lead still appears", async () => {
  const orgId = await makeOrg("2");
  try {
    const contactId = await insert("contacts", { organization_id: orgId, phone: "+15555629002" });
    const hot = () => insert("leads", { organization_id: orgId, contact_id: contactId, status: "contacted", temperature: "hot", source: "website" });
    const [afterUncontacted, afterQualified, clean] = [await hot(), await hot(), await hot()];
    await dismissed(orgId, "uncontacted_lead", "lead", afterUncontacted, contactId);
    await dismissed(orgId, "qualified_lead_unbooked", "lead", afterQualified, contactId);

    const result = await syncOpportunities(service, orgId);
    assert.equal(result.suppressed, 2);
    assert.deepEqual(await openSources(orgId, "active_lead_signal"), [clean]);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("3. (Q2b) never the other way - a dismissed uncontacted lead or a dismissed active signal never suppresses a later qualified-unbooked item", async () => {
  const orgId = await makeOrg("3");
  try {
    const contactId = await insert("contacts", { organization_id: orgId, phone: "+15555629003" });
    const qualified = () => insert("leads", { organization_id: orgId, contact_id: contactId, status: "qualified", temperature: "warm", source: "website" });
    const [wasUncontacted, wasSignal] = [await qualified(), await qualified()];
    await dismissed(orgId, "uncontacted_lead", "lead", wasUncontacted, contactId);
    await dismissed(orgId, "active_lead_signal", "lead", wasSignal, contactId);

    await syncOpportunities(service, orgId);
    assert.deepEqual(await openSources(orgId, "qualified_lead_unbooked"), [wasUncontacted, wasSignal].sort());
  } finally {
    await cleanupOrg(orgId);
  }
});

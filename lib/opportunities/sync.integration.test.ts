/**
 * Integration tests for Pass 3 (Revenue Intelligence Foundation), Part 3:
 * lib/opportunities/detect.ts's detectAllOpportunityCandidates and
 * syncOpportunities - real, disposable Supabase fixtures against the real
 * project (service-role client), matching lib/bi/metrics.integration.test.ts's
 * established pattern. This suite proves detection accuracy and lifecycle
 * (create/refresh/auto-resolve/dedup) - it does NOT attempt to prove RLS
 * (a service-role client bypasses RLS by design); see this repo's own
 * supabase/migrations/opportunities-migration.test.ts for the real,
 * authenticated-session RLS proof.
 *
 * REQUIRES supabase/migrations/20260925020000_opportunities.sql to have
 * been applied first - as of this pass it has not yet been applied to the
 * only reachable Supabase project (see this pass's own final report), so
 * every test below is expected to fail with "relation does not exist"
 * until it is. This suite asserts the DESIRED, already-implemented
 * behavior and should go green with no other changes once the migration is
 * applied.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/opportunities/sync.integration.test.ts
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
const { getOpenOpportunities }: typeof import("./queries") = require(path.join(REPO_ROOT, "lib/opportunities/queries.ts"));

const service = createServiceRoleClient();

async function makeOrg(name: string) {
  const { data } = await service.from("organizations").insert({ name, payment_status: "active" }).select("id").single();
  return data!.id as string;
}

async function makeContact(orgId: string, phone: string) {
  const { data } = await service.from("contacts").insert({ organization_id: orgId, phone }).select("id").single();
  return data!.id as string;
}

async function makeLead(orgId: string, contactId: string, status: string) {
  const { data } = await service.from("leads").insert({ organization_id: orgId, contact_id: contactId, status, temperature: "warm", source: "website" }).select("id").single();
  return data!.id as string;
}

async function cleanupOrg(orgId: string) {
  await service.from("opportunities").delete().eq("organization_id", orgId);
  await service.from("appointments").delete().eq("organization_id", orgId);
  await service.from("estimates").delete().eq("organization_id", orgId);
  await service.from("leads").delete().eq("organization_id", orgId);
  await service.from("contacts").delete().eq("organization_id", orgId);
  await service.from("organizations").delete().eq("id", orgId);
}

test("1. detectAllOpportunityCandidates finds a real qualified-and-unbooked lead", async () => {
  const orgId = await makeOrg("Opportunities Sync Test Org (Qualified Lead)");
  try {
    const contactId = await makeContact(orgId, "+15555570001");
    await makeLead(orgId, contactId, "qualified");

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].type, "qualified_lead_unbooked");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("2. syncOpportunities creates a new row on first run, and re-running with no data change makes zero further writes", async () => {
  const orgId = await makeOrg("Opportunities Sync Test Org (Create Then Unchanged)");
  try {
    const contactId = await makeContact(orgId, "+15555570002");
    await makeLead(orgId, contactId, "qualified");

    const first = await syncOpportunities(service, orgId);
    assert.equal(first.created, 1);
    assert.equal(first.resolved, 0);

    const openAfterFirst = await getOpenOpportunities(service, orgId);
    assert.equal(openAfterFirst.length, 1);

    const second = await syncOpportunities(service, orgId);
    assert.equal(second.created, 0);
    assert.equal(second.unchanged, 1, "an unchanged underlying condition must never create a duplicate row");

    const openAfterSecond = await getOpenOpportunities(service, orgId);
    assert.equal(openAfterSecond.length, 1, "still exactly one open opportunity, never duplicated");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("3. syncOpportunities auto-resolves an open opportunity once its underlying condition genuinely goes away (the lead gets booked)", async () => {
  const orgId = await makeOrg("Opportunities Sync Test Org (Auto Resolve)");
  try {
    const contactId = await makeContact(orgId, "+15555570003");
    const leadId = await makeLead(orgId, contactId, "qualified");

    const first = await syncOpportunities(service, orgId);
    assert.equal(first.created, 1);

    // The lead gets a real appointment - it is no longer "unbooked".
    await service.from("appointments").insert({ organization_id: orgId, contact_id: contactId, lead_id: leadId, title: "Visit", start_at: "2027-04-01T09:00:00.000Z", end_at: "2027-04-01T10:00:00.000Z", status: "scheduled" });

    const second = await syncOpportunities(service, orgId);
    assert.equal(second.resolved, 1, "the opportunity whose lead just got booked must be auto-resolved");
    assert.equal(second.created, 0);

    const openAfter = await getOpenOpportunities(service, orgId);
    assert.equal(openAfter.length, 0, "no open opportunities should remain once the underlying condition is gone");

    const { data: resolvedRow } = await service.from("opportunities").select("status, resolved_at").eq("organization_id", orgId).single();
    assert.equal(resolvedRow!.status, "resolved");
    assert.ok(resolvedRow!.resolved_at, "resolved_at must be set when the detector resolves an opportunity");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("5. a dismissed opportunity is never resurrected by a later sync while its underlying condition is unchanged (verification-pass fix)", async () => {
  const orgId = await makeOrg("Opportunities Sync Test Org (Dismiss Then Resync)");
  try {
    const contactId = await makeContact(orgId, "+15555570005");
    await makeLead(orgId, contactId, "qualified");

    const first = await syncOpportunities(service, orgId);
    assert.equal(first.created, 1);

    const [openRow] = await getOpenOpportunities(service, orgId);
    const { error: dismissError } = await service.from("opportunities").update({ status: "dismissed", resolved_at: new Date().toISOString() }).eq("id", openRow.id);
    assert.equal(dismissError, null);

    // The underlying lead is still qualified and unbooked - nothing about
    // it changed. A naive sync would treat this as a fresh, uncovered
    // candidate and create a brand-new open row for the exact same lead,
    // silently undoing the human's dismissal.
    const second = await syncOpportunities(service, orgId);
    assert.equal(second.created, 0, "a dismissed opportunity must not be recreated while its underlying condition is unchanged");
    assert.equal(second.suppressed, 1);

    const openAfter = await getOpenOpportunities(service, orgId);
    assert.equal(openAfter.length, 0, "no open opportunity should exist for a lead whose opportunity was just dismissed");

    const { data: allRows } = await service.from("opportunities").select("status").eq("organization_id", orgId);
    assert.equal(allRows!.length, 1, "still exactly one row total - dismissed, never duplicated");
    assert.equal(allRows![0].status, "dismissed");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("6. organization isolation: syncOpportunities for organization A never creates or reads organization B's opportunities", async () => {
  const orgA = await makeOrg("Opportunities Sync Test Org (Isolation A)");
  const orgB = await makeOrg("Opportunities Sync Test Org (Isolation B)");
  try {
    const contactB = await makeContact(orgB, "+15555570004");
    await makeLead(orgB, contactB, "qualified");
    await syncOpportunities(service, orgB);

    const resultA = await syncOpportunities(service, orgA);
    assert.equal(resultA.created, 0);

    const openA = await getOpenOpportunities(service, orgA);
    assert.equal(openA.length, 0, "organization A must never see organization B's opportunities");
  } finally {
    await cleanupOrg(orgA);
    await cleanupOrg(orgB);
  }
});

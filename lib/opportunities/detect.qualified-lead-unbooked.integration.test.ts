/**
 * Trackpr 2.0, Phase 4C (P2 #6): integration tests for the
 * qualified_lead_unbooked opportunity detector - real, disposable Supabase
 * fixtures against the real project (service-role client), mirroring
 * lib/opportunities/detect.uncontacted-lead.integration.test.ts's own
 * established pattern exactly (per-test org, try/finally cleanup,
 * detectAllOpportunityCandidates called directly).
 *
 * This is the detector's first dedicated test file - it previously had no
 * test coverage of its own beyond incidental mentions in
 * sync.integration.test.ts. Added specifically to prove the P2 #6 fix:
 * "booked" now means an appointment in an ACTIVE status (scheduled,
 * confirmed, completed), never a cancelled or no-show appointment, which
 * previously made a qualified lead permanently ineligible to resurface here
 * even though nothing real is on the calendar for them.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/opportunities/detect.qualified-lead-unbooked.integration.test.ts
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
const { detectAllOpportunityCandidates }: typeof import("./detect") = require(path.join(REPO_ROOT, "lib/opportunities/detect.ts"));

const service = createServiceRoleClient();

async function makeOrg(name: string) {
  const { data } = await service.from("organizations").insert({ name, automation_mode: "live", payment_status: "active", automation_paused: false }).select("id").single();
  return data!.id as string;
}

async function makeContact(orgId: string, phone: string) {
  const { data } = await service.from("contacts").insert({ organization_id: orgId, phone }).select("id").single();
  return data!.id as string;
}

async function makeQualifiedLead(orgId: string, contactId: string, estimatedValue: number | null = null) {
  const { data } = await service.from("leads").insert({ organization_id: orgId, contact_id: contactId, status: "qualified", temperature: "warm", source: "website", estimated_value: estimatedValue }).select("id").single();
  return data!.id as string;
}

let slot = 0;
async function makeAppointment(orgId: string, contactId: string, leadId: string, status: "scheduled" | "confirmed" | "completed" | "cancelled" | "no_show") {
  slot += 1;
  const start = new Date(Date.now() - (365 + slot) * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  await service.from("appointments").insert({ organization_id: orgId, contact_id: contactId, lead_id: leadId, title: "Estimate visit", start_at: start.toISOString(), end_at: end.toISOString(), status });
}

async function cleanupOrg(orgId: string) {
  await service.from("opportunities").delete().eq("organization_id", orgId);
  await service.from("appointments").delete().eq("organization_id", orgId);
  await service.from("leads").delete().eq("organization_id", orgId);
  await service.from("contacts").delete().eq("organization_id", orgId);
  await service.from("organizations").delete().eq("id", orgId);
}

function isCandidate(candidates: { type: string; sourceEntityId: string }[], leadId: string): boolean {
  return candidates.some((c) => c.type === "qualified_lead_unbooked" && c.sourceEntityId === leadId);
}

test("1. a qualified lead with NO appointment at all is a candidate", async () => {
  const orgId = await makeOrg("Qualified Unbooked Test Org (1)");
  try {
    const contactId = await makeContact(orgId, "+15555720101");
    const leadId = await makeQualifiedLead(orgId, contactId, 2000);

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(isCandidate(candidates, leadId));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("2. a qualified lead with a SCHEDULED appointment is never a candidate", async () => {
  const orgId = await makeOrg("Qualified Unbooked Test Org (2)");
  try {
    const contactId = await makeContact(orgId, "+15555720102");
    const leadId = await makeQualifiedLead(orgId, contactId);
    await makeAppointment(orgId, contactId, leadId, "scheduled");

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(!isCandidate(candidates, leadId));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("2b. a qualified lead with a CONFIRMED appointment is never a candidate", async () => {
  const orgId = await makeOrg("Qualified Unbooked Test Org (2b)");
  try {
    const contactId = await makeContact(orgId, "+15555720103");
    const leadId = await makeQualifiedLead(orgId, contactId);
    await makeAppointment(orgId, contactId, leadId, "confirmed");

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(!isCandidate(candidates, leadId));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("3. a qualified lead with a COMPLETED appointment is never a candidate", async () => {
  const orgId = await makeOrg("Qualified Unbooked Test Org (3)");
  try {
    const contactId = await makeContact(orgId, "+15555720104");
    const leadId = await makeQualifiedLead(orgId, contactId);
    await makeAppointment(orgId, contactId, leadId, "completed");

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(!isCandidate(candidates, leadId));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("4 (P2 #6 fix). a qualified lead whose ONLY appointment history is CANCELLED is a candidate again - a cancellation is not a real booking", async () => {
  const orgId = await makeOrg("Qualified Unbooked Test Org (4)");
  try {
    const contactId = await makeContact(orgId, "+15555720105");
    const leadId = await makeQualifiedLead(orgId, contactId);
    await makeAppointment(orgId, contactId, leadId, "cancelled");

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(isCandidate(candidates, leadId), "before the P2 #6 fix, any appointment row (including cancelled) permanently suppressed this lead");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("4b (P2 #6 fix). a qualified lead whose ONLY appointment history is NO-SHOW is a candidate again - the customer was never actually seen", async () => {
  const orgId = await makeOrg("Qualified Unbooked Test Org (4b)");
  try {
    const contactId = await makeContact(orgId, "+15555720106");
    const leadId = await makeQualifiedLead(orgId, contactId);
    await makeAppointment(orgId, contactId, leadId, "no_show");

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(isCandidate(candidates, leadId));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("5. MIXED: a qualified lead with one cancelled appointment AND one active (scheduled) appointment is never a candidate - a real active booking exists", async () => {
  const orgId = await makeOrg("Qualified Unbooked Test Org (5)");
  try {
    const contactId = await makeContact(orgId, "+15555720107");
    const leadId = await makeQualifiedLead(orgId, contactId);
    await makeAppointment(orgId, contactId, leadId, "cancelled");
    await makeAppointment(orgId, contactId, leadId, "scheduled");

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(!isCandidate(candidates, leadId), "one real active booking must still suppress this lead, even alongside an earlier cancellation");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("6. organization isolation: a qualifying lead in organization A never appears when detecting organization B", async () => {
  const orgA = await makeOrg("Qualified Unbooked Test Org (6A)");
  const orgB = await makeOrg("Qualified Unbooked Test Org (6B)");
  try {
    const contactA = await makeContact(orgA, "+15555720108");
    const leadIdA = await makeQualifiedLead(orgA, contactA);

    const candidatesB = await detectAllOpportunityCandidates(service, orgB);
    assert.ok(!isCandidate(candidatesB, leadIdA));
  } finally {
    await cleanupOrg(orgA);
    await cleanupOrg(orgB);
  }
});

test("7. estimatedValue/valueBasis are never fabricated - null stays null, a real value is preserved", async () => {
  const orgId = await makeOrg("Qualified Unbooked Test Org (7)");
  try {
    const contactId = await makeContact(orgId, "+15555720109");
    const leadWithValue = await makeQualifiedLead(orgId, contactId, 3500);
    const contactId2 = await makeContact(orgId, "+15555720110");
    const leadWithoutValue = await makeQualifiedLead(orgId, contactId2, null);

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    const withValue = candidates.find((c) => c.type === "qualified_lead_unbooked" && c.sourceEntityId === leadWithValue) as { estimatedValue: number | null; valueBasis: string | null } | undefined;
    const withoutValue = candidates.find((c) => c.type === "qualified_lead_unbooked" && c.sourceEntityId === leadWithoutValue) as { estimatedValue: number | null; valueBasis: string | null } | undefined;
    assert.equal(withValue?.estimatedValue, 3500);
    assert.equal(withValue?.valueBasis, "leads.estimated_value");
    assert.equal(withoutValue?.estimatedValue, null, "a genuinely unknown value must stay null, never coerced to 0");
    assert.equal(withoutValue?.valueBasis, null);
  } finally {
    await cleanupOrg(orgId);
  }
});

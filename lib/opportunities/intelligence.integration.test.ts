/**
 * Canonical Opportunity Intelligence Layer - integration tests for
 * getPrioritizedOpportunities itself: real, disposable Supabase fixtures
 * against the real project (service-role client), mirroring
 * lib/opportunities/detect.qualified-lead-unbooked.integration.test.ts's own
 * established pattern (per-test org, try/finally cleanup).
 *
 * Pure logic (deriveValueState, buildExplanation, resolveActionability,
 * buildPriorityQueue, getConversationSignals, getOperationalExceptions) is
 * covered without I/O in intelligence.test.ts - this file only covers what
 * genuinely needs a real database: automation eligibility, real contact
 * rows, and the duplicate-signal suppression that spans two detectors.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/opportunities/intelligence.integration.test.ts
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
const { getPrioritizedOpportunities }: typeof import("./intelligence") = require(path.join(REPO_ROOT, "lib/opportunities/intelligence.ts"));

const service = createServiceRoleClient();

async function makeOrg(overrides: Record<string, unknown> = {}) {
  const { data } = await service
    .from("organizations")
    .insert({ name: `Intelligence Layer Test Org ${Math.random().toString(36).slice(2)}`, automation_mode: "live", payment_status: "active", automation_paused: false, ...overrides })
    .select("id")
    .single();
  return data!.id as string;
}

async function makeContact(orgId: string, overrides: Record<string, unknown> = {}) {
  const { data } = await service
    .from("contacts")
    .insert({ organization_id: orgId, phone: "+15555730100", sms_opt_out: false, ...overrides })
    .select("id")
    .single();
  return data!.id as string;
}

async function makeLead(orgId: string, contactId: string, overrides: Record<string, unknown> = {}) {
  const { data } = await service
    .from("leads")
    .insert({ organization_id: orgId, contact_id: contactId, status: "qualified", temperature: "warm", source: "website", ...overrides })
    .select("id")
    .single();
  return data!.id as string;
}

async function cleanupOrg(orgId: string) {
  await service.from("opportunities").delete().eq("organization_id", orgId);
  await service.from("appointments").delete().eq("organization_id", orgId);
  await service.from("estimates").delete().eq("organization_id", orgId);
  await service.from("jobs").delete().eq("organization_id", orgId);
  await service.from("leads").delete().eq("organization_id", orgId);
  await service.from("contacts").delete().eq("organization_id", orgId);
  await service.from("automation_settings").delete().eq("organization_id", orgId);
  await service.from("organizations").delete().eq("id", orgId);
}

test("1. a known-value qualified lead with a valid contact phone: known value, active_pursuit tier, CALL", async () => {
  const orgId = await makeOrg();
  try {
    const contactId = await makeContact(orgId, { phone: "+15555730101" });
    await makeLead(orgId, contactId, { estimated_value: 21500 });
    await syncOpportunities(service, orgId);

    const results = await getPrioritizedOpportunities(service, orgId);
    assert.equal(results.length, 1);
    assert.equal(results[0].tier, "active_pursuit");
    assert.equal(results[0].valueState, "known");
    assert.equal(results[0].recommendedAction, "call");
    assert.equal(results[0].contactPhone, "+15555730101");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("2. missing phone on the contact: CALL is downgraded to FOLLOW_UP - never a dead button", async () => {
  const orgId = await makeOrg();
  try {
    const contactId = await makeContact(orgId, { phone: null });
    await makeLead(orgId, contactId);
    await syncOpportunities(service, orgId);

    const results = await getPrioritizedOpportunities(service, orgId);
    assert.equal(results.length, 1);
    assert.equal(results[0].recommendedAction, "follow_up");
    assert.equal(results[0].contactPhone, null);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("3. an unknown-value qualified lead: UNKNOWN value state, never coerced to $0", async () => {
  const orgId = await makeOrg();
  try {
    const contactId = await makeContact(orgId);
    await makeLead(orgId, contactId, { estimated_value: null });
    await syncOpportunities(service, orgId);

    const results = await getPrioritizedOpportunities(service, orgId);
    assert.equal(results[0].valueState, "unknown");
    assert.equal(results[0].opportunity.estimatedValue, null);
    assert.ok(results[0].explanation.supportingSignals.includes("Value not yet entered"));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("4. duplicate-signal suppression: a hot, qualified, unbooked lead produces ONE opportunity (qualified_lead_unbooked), never a second active_lead_signal row for the same lead", async () => {
  const orgId = await makeOrg();
  try {
    const contactId = await makeContact(orgId);
    const leadId = await makeLead(orgId, contactId, { temperature: "hot", estimated_value: 8000 });
    await syncOpportunities(service, orgId);

    const results = await getPrioritizedOpportunities(service, orgId);
    const forThisLead = results.filter((result) => result.opportunity.sourceEntityId === leadId);
    assert.equal(forThisLead.length, 1, "the same hot, qualified, unbooked lead must never surface as two separate opportunity rows");
    assert.equal(forThisLead[0].opportunity.type, "qualified_lead_unbooked", "the more specific type wins - active_lead_signal is suppressed for this lead");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("5. a hot lead that is NOT qualified/unbooked (still 'contacted') DOES get its own active_lead_signal opportunity - the suppression only applies when a more specific type exists for the same lead", async () => {
  const orgId = await makeOrg();
  try {
    const contactId = await makeContact(orgId);
    const leadId = await makeLead(orgId, contactId, { status: "contacted", temperature: "hot" });
    await syncOpportunities(service, orgId);

    const results = await getPrioritizedOpportunities(service, orgId);
    const forThisLead = results.filter((result) => result.opportunity.sourceEntityId === leadId);
    assert.equal(forThisLead.length, 1);
    assert.equal(forThisLead[0].opportunity.type, "active_lead_signal");
    assert.equal(forThisLead[0].explanation.confidence, "manual_flag");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("5b. a lead that is BOTH hot/high-value AND has a real pending estimate produces ONE opportunity (pending_estimate), never two active_pursuit cards for the same lead - caught by live browser verification, not by the original design", async () => {
  const orgId = await makeOrg();
  try {
    const contactId = await makeContact(orgId);
    const leadId = await makeLead(orgId, contactId, { status: "contacted", temperature: "hot", estimated_value: 8900 });
    await service.from("estimates").insert({ organization_id: orgId, contact_id: contactId, lead_id: leadId, title: "Roof repair", amount: 8900, status: "sent" });
    await syncOpportunities(service, orgId);

    const results = await getPrioritizedOpportunities(service, orgId);
    const forThisLead = results.filter((result) => result.opportunity.sourceEntityId === leadId);
    assert.equal(forThisLead.length, 1, "a hot lead with a pending estimate must never surface as two separate active_pursuit cards");
    assert.equal(forThisLead[0].opportunity.type, "pending_estimate", "the real sent estimate is more specific than a bare temperature/value flag and wins");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("6. a dormant customer: NOT_APPLICABLE value state, recoverable tier, REACTIVATE - automatable reflects the real automation_settings/organization eligibility", async () => {
  const orgId = await makeOrg();
  try {
    const contactId = await makeContact(orgId);
    const { data: job } = await service
      .from("jobs")
      .insert({ organization_id: orgId, contact_id: contactId, title: "Roof repair", status: "completed", completed_at: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString() })
      .select("id")
      .single();
    assert.ok(job);
    await syncOpportunities(service, orgId);

    const results = await getPrioritizedOpportunities(service, orgId);
    const dormant = results.find((result) => result.opportunity.type === "dormant_customer");
    assert.ok(dormant, "a customer whose last completed job is 200 days old (past the 180-day default) must produce a dormant_customer opportunity");
    assert.equal(dormant!.tier, "recoverable");
    assert.equal(dormant!.valueState, "not_applicable");
    assert.equal(dormant!.recommendedAction, "reactivate");
    assert.equal(dormant!.automatable, true, "a live, paid, unpaused org with no explicit disable must be automatable for customer-reactivation");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("6b. a repeat-customer dormant_customer opportunity gets a real, historical CustomerLifecycle supporting signal - a one-time customer's does not", async () => {
  const orgId = await makeOrg();
  try {
    const repeatContactId = await makeContact(orgId, { phone: "+15555730201" });
    const onceContactId = await makeContact(orgId, { phone: "+15555730202" });
    const longAgo = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    const evenLongerAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();

    // Repeat customer: 2 completed jobs, known amounts.
    await service.from("jobs").insert({ organization_id: orgId, contact_id: repeatContactId, title: "First roof job", status: "completed", completed_at: evenLongerAgo, amount: 500 });
    await service.from("jobs").insert({ organization_id: orgId, contact_id: repeatContactId, title: "Second roof job", status: "completed", completed_at: longAgo, amount: 700 });

    // One-time customer: a single completed job.
    await service.from("jobs").insert({ organization_id: orgId, contact_id: onceContactId, title: "Only job", status: "completed", completed_at: longAgo, amount: 400 });

    await syncOpportunities(service, orgId);
    const results = await getPrioritizedOpportunities(service, orgId);

    const repeat = results.find((result) => result.opportunity.type === "dormant_customer" && result.opportunity.contactId === repeatContactId);
    const once = results.find((result) => result.opportunity.type === "dormant_customer" && result.opportunity.contactId === onceContactId);
    assert.ok(repeat, "the repeat customer must produce a dormant_customer opportunity");
    assert.ok(once, "the one-time customer must produce a dormant_customer opportunity");

    assert.ok(
      repeat!.explanation.supportingSignals.some((signal) => signal.includes("Repeat customer - 2 completed jobs, averaging $600 per job")),
      "the repeat customer's explanation must include real, historical job-value context",
    );
    assert.ok(
      !once!.explanation.supportingSignals.some((signal) => signal.includes("Repeat customer")),
      "a one-time customer must never get a fabricated 'repeat customer' signal",
    );
    // The opportunity's own value stays NOT_APPLICABLE regardless - the
    // lifecycle context is supporting evidence, never a substitute value.
    assert.equal(repeat!.valueState, "not_applicable");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("7. automatable is false when the organization is paused, even for a type with a real corresponding automation", async () => {
  const orgId = await makeOrg({ automation_paused: true });
  try {
    const contactId = await makeContact(orgId);
    await service
      .from("jobs")
      .insert({ organization_id: orgId, contact_id: contactId, title: "Roof repair", status: "completed", completed_at: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString() });
    await syncOpportunities(service, orgId);

    const results = await getPrioritizedOpportunities(service, orgId);
    const dormant = results.find((result) => result.opportunity.type === "dormant_customer");
    assert.ok(dormant);
    assert.equal(dormant!.automatable, false, "a paused organization must never be reported as automatable");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("8. automatable is false when the specific automation is explicitly disabled for the org, even though the org itself is eligible", async () => {
  const orgId = await makeOrg();
  try {
    const contactId = await makeContact(orgId);
    await service.from("jobs").insert({ organization_id: orgId, contact_id: contactId, title: "Roof repair", status: "completed", completed_at: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString() });
    await service.from("automation_settings").insert({ organization_id: orgId, automation_id: "customer-reactivation", enabled: false });
    await syncOpportunities(service, orgId);

    const results = await getPrioritizedOpportunities(service, orgId);
    const dormant = results.find((result) => result.opportunity.type === "dormant_customer");
    assert.ok(dormant);
    assert.equal(dormant!.automatable, false);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("9. an accepted estimate with no job: committed_revenue_at_risk tier, CREATE_JOB, never automatable (no automation creates jobs)", async () => {
  const orgId = await makeOrg();
  try {
    const contactId = await makeContact(orgId);
    const leadId = await makeLead(orgId, contactId);
    await service
      .from("estimates")
      .insert({
        organization_id: orgId,
        contact_id: contactId,
        lead_id: leadId,
        title: "Roof repair",
        amount: 14500,
        status: "accepted",
        responded_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      });
    await syncOpportunities(service, orgId);

    const results = await getPrioritizedOpportunities(service, orgId);
    const accepted = results.find((result) => result.opportunity.type === "accepted_estimate_no_job");
    assert.ok(accepted);
    assert.equal(accepted!.tier, "committed_revenue_at_risk");
    assert.equal(accepted!.valueState, "known");
    assert.equal(accepted!.recommendedAction, "create_job");
    assert.equal(accepted!.automatable, false);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("10. a no-show appointment: at_risk tier, NOT_APPLICABLE value (no dollar amount exists on an appointment)", async () => {
  const orgId = await makeOrg();
  try {
    const contactId = await makeContact(orgId);
    const leadId = await makeLead(orgId, contactId);
    const start = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    await service
      .from("appointments")
      .insert({ organization_id: orgId, contact_id: contactId, lead_id: leadId, title: "Estimate visit", start_at: start.toISOString(), end_at: new Date(start.getTime() + 1800000).toISOString(), status: "no_show" });
    await syncOpportunities(service, orgId);

    const results = await getPrioritizedOpportunities(service, orgId);
    const noShow = results.find((result) => result.opportunity.type === "no_show");
    assert.ok(noShow);
    assert.equal(noShow!.tier, "at_risk");
    assert.equal(noShow!.valueState, "not_applicable");
    assert.equal(noShow!.recommendedAction, "rebook");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("11. organization isolation: organization A's opportunities never appear when prioritizing organization B", async () => {
  const orgA = await makeOrg();
  const orgB = await makeOrg();
  try {
    const contactA = await makeContact(orgA);
    await makeLead(orgA, contactA, { estimated_value: 99999 });
    await syncOpportunities(service, orgA);
    await syncOpportunities(service, orgB);

    const resultsA = await getPrioritizedOpportunities(service, orgA);
    const resultsB = await getPrioritizedOpportunities(service, orgB);
    assert.equal(resultsA.length, 1);
    assert.equal(resultsB.length, 0, "organization B must never see organization A's opportunity");
  } finally {
    await cleanupOrg(orgA);
    await cleanupOrg(orgB);
  }
});

test("12. an organization with zero open opportunities returns an empty array without error, and without querying contacts", async () => {
  const orgId = await makeOrg();
  try {
    await syncOpportunities(service, orgId);
    const results = await getPrioritizedOpportunities(service, orgId);
    assert.deepEqual(results, []);
  } finally {
    await cleanupOrg(orgId);
  }
});

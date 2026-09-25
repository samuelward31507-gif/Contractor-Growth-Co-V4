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
 * REQUIRES supabase/migrations/20260925020000_opportunities.sql - applied
 * to the only reachable Supabase project as of the Pass 3 release
 * (4ee52af).
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
const { getDormantCustomersValueSummary }: typeof import("@/lib/customers/lifecycle") = require(path.join(REPO_ROOT, "lib/customers/lifecycle.ts"));

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

async function makeJob(orgId: string, contactId: string, status: string, completedAt: string | null, amount: number | null = null) {
  const { data } = await service.from("jobs").insert({ organization_id: orgId, contact_id: contactId, title: "Job", status, completed_at: completedAt, amount }).select("id").single();
  return data!.id as string;
}

/** Well past the customer-reactivation default 180-day inactivity threshold, with margin. */
function longAgoIso(days = 250): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** Marks a job's referral request as already sent, so it never also surfaces as a completed_job_no_referral_request candidate - used to keep dormant-customer tests isolated to dormancy alone. */
async function satisfyReferralRequest(orgId: string, jobId: string, contactId: string) {
  await service.from("referral_requests").insert({ organization_id: orgId, job_id: jobId, contact_id: contactId, status: "requested", requested_at: new Date().toISOString() });
}

async function cleanupOrg(orgId: string) {
  await service.from("opportunities").delete().eq("organization_id", orgId);
  await service.from("referral_requests").delete().eq("organization_id", orgId);
  await service.from("appointments").delete().eq("organization_id", orgId);
  await service.from("estimates").delete().eq("organization_id", orgId);
  await service.from("jobs").delete().eq("organization_id", orgId);
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

test("4. a RESOLVED opportunity is free to recur as a fresh open row once its underlying condition becomes true again - the opposite of DISMISSED (test 5 below), which stays permanently suppressed", async () => {
  const orgId = await makeOrg("Opportunities Sync Test Org (Resolved Recurs)");
  try {
    const contactId = await makeContact(orgId, "+15555570006");
    const leadId = await makeLead(orgId, contactId, "qualified");

    // 1. Open.
    const first = await syncOpportunities(service, orgId);
    assert.equal(first.created, 1);
    const [firstOpen] = await getOpenOpportunities(service, orgId);
    assert.equal(firstOpen.status, "open");

    // 2. The underlying condition disappears (the lead gets booked).
    const { data: appointment } = await service
      .from("appointments")
      .insert({ organization_id: orgId, contact_id: contactId, lead_id: leadId, title: "Visit", start_at: "2027-06-01T09:00:00.000Z", end_at: "2027-06-01T10:00:00.000Z", status: "scheduled" })
      .select("id")
      .single();

    // 3. syncOpportunities resolves it - never dismisses it. This is the
    // detector's own doing, not a human decision, which is exactly why a
    // resolved row (unlike a dismissed one) must stay eligible to recur.
    const second = await syncOpportunities(service, orgId);
    assert.equal(second.resolved, 1);
    assert.equal((await getOpenOpportunities(service, orgId)).length, 0);

    // 4. The underlying condition becomes true again (the appointment that
    // booked the lead is removed - e.g. cancelled and cleaned up - so the
    // lead is genuinely qualified-and-unbooked again, the identical real
    // condition as step 1, not a different one).
    await service.from("appointments").delete().eq("id", appointment!.id);

    // 5. syncOpportunities creates/reopens the appropriate opportunity.
    const third = await syncOpportunities(service, orgId);
    assert.equal(third.created, 1, "a resolved opportunity's condition recurring must produce a fresh open row - resolved rows are never permanently suppressed like dismissed ones");
    assert.equal(third.suppressed, 0, "must not be treated as a dismissed/suppressed key");

    // 6. No duplicate open opportunity exists.
    const openAfter = await getOpenOpportunities(service, orgId);
    assert.equal(openAfter.length, 1, "exactly one open opportunity, never two");
    assert.equal(openAfter[0].sourceEntityId, leadId);

    const { data: allRows } = await service.from("opportunities").select("id, status, source_entity_id").eq("organization_id", orgId).order("created_at", { ascending: true });
    assert.equal(allRows!.length, 2, "two distinct rows total: the original now-resolved one, and the new open one - recurrence creates a fresh row rather than reopening the old one in place");
    assert.equal(allRows![0].status, "resolved");
    assert.equal(allRows![1].status, "open");
    assert.equal(allRows![0].source_entity_id, leadId);
    assert.equal(allRows![1].source_entity_id, leadId, "both rows are for the exact same real lead - the same underlying entity, recurring as a new instance");
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

// ==================== Pass 4 P0: dormant_customer detector, tested directly ====================
//
// Complements lib/dashboard/queries.integration.test.ts's dashboard-level
// dormant_customer tests (18-20) - those prove the item reaches the
// dashboard's attentionItems; these prove detectAllOpportunityCandidates/
// syncOpportunities themselves get the dormancy call right, including the
// specific exclusion case and deduplication. Reuses the exact same
// dormancy definition as lib/automation/customer-reactivation.ts (no
// second definition) - this file only ever creates real jobs/leads/
// appointments/estimates and calls the real detector, never reimplements
// isReactivationDue or the active-engagement exclusion set itself.

test("7. detectAllOpportunityCandidates identifies a real dormant customer: completed job old enough, no excluded open engagement", async () => {
  const orgId = await makeOrg("Opportunities Sync Test Org (Dormant Detect)");
  try {
    const contactId = await makeContact(orgId, "+15555570007");
    await makeJob(orgId, contactId, "completed", longAgoIso());

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    const dormant = candidates.find((c) => c.type === "dormant_customer");
    assert.ok(dormant, "a customer whose only completed job is 250 days old, with no active engagement, must be detected as dormant");
    assert.equal(dormant!.sourceEntityType, "contact");
    assert.equal(dormant!.sourceEntityId, contactId, "source entity must be the real contact");
    assert.equal(dormant!.contactId, contactId);
    assert.equal(dormant!.estimatedValue, null, "dormant customer opportunities must never carry a fabricated future-service value");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("8. syncOpportunities creates the dormant_customer opportunity with the correct source entity and contact_id, and deduplicates on a second run", async () => {
  const orgId = await makeOrg("Opportunities Sync Test Org (Dormant Sync)");
  try {
    const contactId = await makeContact(orgId, "+15555570008");
    const jobId = await makeJob(orgId, contactId, "completed", longAgoIso());
    await satisfyReferralRequest(orgId, jobId, contactId);

    const first = await syncOpportunities(service, orgId);
    assert.equal(first.created, 1);

    const [row] = await getOpenOpportunities(service, orgId);
    assert.equal(row.type, "dormant_customer");
    assert.equal(row.sourceEntityId, contactId);
    assert.equal(row.contactId, contactId);
    assert.equal(row.status, "open");

    // Deduplication: nothing about the underlying data changed - a second
    // sync must not create a second dormant_customer row for this contact.
    const second = await syncOpportunities(service, orgId);
    assert.equal(second.created, 0);
    assert.equal(second.unchanged, 1);
    const openAfter = await getOpenOpportunities(service, orgId);
    assert.equal(openAfter.length, 1, "still exactly one open dormant_customer opportunity for this contact, never duplicated");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("9. a customer with an active open engagement is excluded from dormant detection, even with an old completed job - reuses customer-reactivation's own exclusion set, not a second definition", async () => {
  const orgId = await makeOrg("Opportunities Sync Test Org (Dormant Excluded)");
  try {
    const contactId = await makeContact(orgId, "+15555570009");
    const jobId = await makeJob(orgId, contactId, "completed", longAgoIso());
    await satisfyReferralRequest(orgId, jobId, contactId);
    // A real active estimate for the same contact - one of the exact same
    // ACTIVE_ESTIMATE_STATUSES exported by lib/automation/customer-reactivation.ts.
    await service.from("estimates").insert({ organization_id: orgId, contact_id: contactId, title: "Pending quote", status: "sent" });

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.equal(
      candidates.some((c) => c.type === "dormant_customer"),
      false,
      "an active (sent) estimate must exclude this contact from dormant detection, regardless of how old their completed job is",
    );

    const result = await syncOpportunities(service, orgId);
    assert.equal(result.created, 0, "no dormant_customer opportunity should be created for an excluded customer");
    assert.equal((await getOpenOpportunities(service, orgId)).length, 0);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("10. organization isolation: a dormant customer in organization A is never detected or synced for organization B", async () => {
  const orgA = await makeOrg("Opportunities Sync Test Org (Dormant Isolation A)");
  const orgB = await makeOrg("Opportunities Sync Test Org (Dormant Isolation B)");
  try {
    const contactA = await makeContact(orgA, "+15555570010");
    await makeJob(orgA, contactA, "completed", longAgoIso());
    await syncOpportunities(service, orgA);

    const candidatesB = await detectAllOpportunityCandidates(service, orgB);
    assert.equal(candidatesB.some((c) => c.type === "dormant_customer"), false);

    const resultB = await syncOpportunities(service, orgB);
    assert.equal(resultB.created, 0);
    assert.equal((await getOpenOpportunities(service, orgB)).length, 0, "organization B must never see organization A's dormant customer");
  } finally {
    await cleanupOrg(orgA);
    await cleanupOrg(orgB);
  }
});

// ==================== Pass 4 P1-D: completed_job_no_referral_request ====================

test("11. a completed job with no referral_requests row at all produces an open opportunity with no fabricated value", async () => {
  const orgId = await makeOrg("Opportunities Sync Test Org (Referral No Row)");
  try {
    const contactId = await makeContact(orgId, "+15555570011");
    const jobId = await makeJob(orgId, contactId, "completed", "2027-01-01T00:00:00.000Z");

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    const referral = candidates.find((c) => c.type === "completed_job_no_referral_request");
    assert.ok(referral, "a completed job with no referral_requests row must be detected");
    assert.equal(referral!.sourceEntityType, "job");
    assert.equal(referral!.sourceEntityId, jobId);
    assert.equal(referral!.contactId, contactId);
    assert.equal(referral!.estimatedValue, null, "must never invent a dollar value for a referral opportunity");
    assert.equal(referral!.valueBasis, null);

    const sync = await syncOpportunities(service, orgId);
    assert.equal(sync.created, 1);
    const [row] = await getOpenOpportunities(service, orgId);
    assert.equal(row.type, "completed_job_no_referral_request");
    assert.equal(row.sourceEntityId, jobId);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("12. a completed job whose referral_requests row is 'failed' still counts as open (the genuinely retriable state)", async () => {
  const orgId = await makeOrg("Opportunities Sync Test Org (Referral Failed)");
  try {
    const contactId = await makeContact(orgId, "+15555570012");
    const jobId = await makeJob(orgId, contactId, "completed", "2027-01-02T00:00:00.000Z");
    await service.from("referral_requests").insert({ organization_id: orgId, job_id: jobId, contact_id: contactId, status: "failed", failure_reason: "provider error" });

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(candidates.some((c) => c.type === "completed_job_no_referral_request" && c.sourceEntityId === jobId), "a 'failed' referral request must still be treated as not-yet-requested");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("13. a completed job whose referral has already been requested is excluded, and syncOpportunities resolves an existing open opportunity once that happens", async () => {
  const orgId = await makeOrg("Opportunities Sync Test Org (Referral Requested)");
  try {
    const contactId = await makeContact(orgId, "+15555570013");
    const jobId = await makeJob(orgId, contactId, "completed", "2027-01-03T00:00:00.000Z");

    const first = await syncOpportunities(service, orgId);
    assert.equal(first.created, 1);
    assert.equal((await getOpenOpportunities(service, orgId)).length, 1);

    // The referral request actually goes out - the automation's own real
    // write, reused as-is, never a second referral-tracking mechanism.
    await service.from("referral_requests").insert({ organization_id: orgId, job_id: jobId, contact_id: contactId, status: "requested", requested_at: new Date().toISOString() });

    const candidatesAfter = await detectAllOpportunityCandidates(service, orgId);
    assert.equal(candidatesAfter.some((c) => c.type === "completed_job_no_referral_request"), false);

    const second = await syncOpportunities(service, orgId);
    assert.equal(second.resolved, 1, "the opportunity must resolve once the referral has actually been requested");
    assert.equal((await getOpenOpportunities(service, orgId)).length, 0);

    const { data: resolvedRow } = await service.from("opportunities").select("status, resolved_at").eq("organization_id", orgId).eq("type", "completed_job_no_referral_request").single();
    assert.equal(resolvedRow!.status, "resolved");
    assert.ok(resolvedRow!.resolved_at);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("14. syncOpportunities deduplicates: re-running with no data change creates zero further completed_job_no_referral_request rows", async () => {
  const orgId = await makeOrg("Opportunities Sync Test Org (Referral Dedup)");
  try {
    const contactId = await makeContact(orgId, "+15555570014");
    await makeJob(orgId, contactId, "completed", "2027-01-04T00:00:00.000Z");

    const first = await syncOpportunities(service, orgId);
    assert.equal(first.created, 1);

    const second = await syncOpportunities(service, orgId);
    assert.equal(second.created, 0);
    assert.equal(second.unchanged, 1);
    assert.equal((await getOpenOpportunities(service, orgId)).length, 1, "still exactly one open opportunity, never duplicated");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("15. a dismissed completed_job_no_referral_request opportunity is never resurrected by a later sync while the underlying condition is unchanged", async () => {
  const orgId = await makeOrg("Opportunities Sync Test Org (Referral Dismissed)");
  try {
    const contactId = await makeContact(orgId, "+15555570015");
    await makeJob(orgId, contactId, "completed", "2027-01-05T00:00:00.000Z");

    const first = await syncOpportunities(service, orgId);
    assert.equal(first.created, 1);
    const [openRow] = await getOpenOpportunities(service, orgId);
    await service.from("opportunities").update({ status: "dismissed", resolved_at: new Date().toISOString() }).eq("id", openRow.id);

    const second = await syncOpportunities(service, orgId);
    assert.equal(second.created, 0);
    assert.equal(second.suppressed, 1);
    assert.equal((await getOpenOpportunities(service, orgId)).length, 0);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("16. a resolved completed_job_no_referral_request opportunity can recur - if the referral request is later deleted/reset, the job becomes a fresh open opportunity again, never a duplicate", async () => {
  const orgId = await makeOrg("Opportunities Sync Test Org (Referral Recurs)");
  try {
    const contactId = await makeContact(orgId, "+15555570016");
    const jobId = await makeJob(orgId, contactId, "completed", "2027-01-06T00:00:00.000Z");

    const first = await syncOpportunities(service, orgId);
    assert.equal(first.created, 1);

    const { data: referral } = await service.from("referral_requests").insert({ organization_id: orgId, job_id: jobId, contact_id: contactId, status: "requested", requested_at: new Date().toISOString() }).select("id").single();
    const second = await syncOpportunities(service, orgId);
    assert.equal(second.resolved, 1);

    // The condition genuinely reverses (e.g. the send is later found to have
    // failed and the row is reset back to a retriable state).
    await service.from("referral_requests").update({ status: "failed", requested_at: null }).eq("id", referral!.id);

    const third = await syncOpportunities(service, orgId);
    assert.equal(third.created, 1, "a resolved opportunity's condition recurring must produce a fresh open row");
    assert.equal(third.suppressed, 0);

    const openAfter = await getOpenOpportunities(service, orgId);
    assert.equal(openAfter.length, 1, "exactly one open opportunity, never a duplicate");
    assert.equal(openAfter[0].sourceEntityId, jobId);

    const { data: allRows } = await service.from("opportunities").select("status").eq("organization_id", orgId).eq("type", "completed_job_no_referral_request");
    assert.equal(allRows!.length, 2, "two distinct rows: the original now-resolved one, and the new open one");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("17. organization isolation: a completed job with no referral request in organization A is never detected or synced for organization B", async () => {
  const orgA = await makeOrg("Opportunities Sync Test Org (Referral Isolation A)");
  const orgB = await makeOrg("Opportunities Sync Test Org (Referral Isolation B)");
  try {
    const contactA = await makeContact(orgA, "+15555570017");
    await makeJob(orgA, contactA, "completed", "2027-01-07T00:00:00.000Z");
    await syncOpportunities(service, orgA);

    const candidatesB = await detectAllOpportunityCandidates(service, orgB);
    assert.equal(candidatesB.some((c) => c.type === "completed_job_no_referral_request"), false);

    const resultB = await syncOpportunities(service, orgB);
    assert.equal(resultB.created, 0);
    assert.equal((await getOpenOpportunities(service, orgB)).length, 0);
  } finally {
    await cleanupOrg(orgA);
    await cleanupOrg(orgB);
  }
});

test("18. a scheduled (not completed) job never produces a completed_job_no_referral_request opportunity", async () => {
  const orgId = await makeOrg("Opportunities Sync Test Org (Referral Not Completed)");
  try {
    const contactId = await makeContact(orgId, "+15555570018");
    await makeJob(orgId, contactId, "scheduled", null);

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.equal(candidates.some((c) => c.type === "completed_job_no_referral_request"), false);
  } finally {
    await cleanupOrg(orgId);
  }
});

// ==================== Pass 4 P1-B: end-to-end dashboard composition ====================

test("19. the exact dashboard composition - syncOpportunities, then getOpenOpportunities filtered to dormant_customer, then getDormantCustomersValueSummary on those contact ids - produces the correct known/unknown value split", async () => {
  const orgId = await makeOrg("Opportunities Sync Test Org (Dashboard Composition)");
  try {
    const knownValueDormant = await makeContact(orgId, "+15555570019");
    const knownJobId = await makeJob(orgId, knownValueDormant, "completed", longAgoIso(), 1200);
    await satisfyReferralRequest(orgId, knownJobId, knownValueDormant);

    const unknownValueDormant = await makeContact(orgId, "+15555570020");
    const unknownJobId = await makeJob(orgId, unknownValueDormant, "completed", longAgoIso());
    await satisfyReferralRequest(orgId, unknownJobId, unknownValueDormant);

    // A non-dormant customer (recent job) must never be counted.
    const notDormant = await makeContact(orgId, "+15555570021");
    const recentJobId = await makeJob(orgId, notDormant, "completed", new Date().toISOString());
    await satisfyReferralRequest(orgId, recentJobId, notDormant);

    await syncOpportunities(service, orgId);

    const openOpportunities = await getOpenOpportunities(service, orgId);
    const dormantContactIds = [...new Set(openOpportunities.filter((o) => o.type === "dormant_customer" && o.contactId != null).map((o) => o.contactId as string))];
    assert.equal(dormantContactIds.length, 2, "exactly the two genuinely dormant contacts - never the recently-completed one");
    assert.ok(dormantContactIds.includes(knownValueDormant));
    assert.ok(dormantContactIds.includes(unknownValueDormant));
    assert.equal(dormantContactIds.includes(notDormant), false);

    const valueSummary = await getDormantCustomersValueSummary(service, orgId, dormantContactIds);
    assert.equal(valueSummary.knownValue, 1200, "only knownValueDormant's real job amount - never notDormant's, never fabricated");
    assert.equal(valueSummary.unknownValueCount, 1, "exactly unknownValueDormant, whose only completed job has a null amount");
  } finally {
    await cleanupOrg(orgId);
  }
});

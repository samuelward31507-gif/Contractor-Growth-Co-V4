/**
 * Pass 5C, Batch 1: integration tests for the two new opportunity
 * detectors - completed_job_no_review_request and
 * cancelled_appointment_no_rebooking - against real, disposable Supabase
 * fixtures on the real project (service-role client), mirroring
 * lib/opportunities/sync.integration.test.ts's own established pattern
 * exactly (per-test org, try/finally cleanup, detectAllOpportunityCandidates/
 * syncOpportunities called directly).
 *
 * REQUIRES supabase/migrations/20260925080000_opportunities_review_and_rebooking_types.sql.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/opportunities/detect.review-rebooking.integration.test.ts
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

const service = createServiceRoleClient();

async function makeOrg(name: string, reviewUrl: string | null = null) {
  const { data } = await service.from("organizations").insert({ name, payment_status: "active", review_url: reviewUrl }).select("id").single();
  return data!.id as string;
}

async function makeContact(orgId: string, phone: string) {
  const { data } = await service.from("contacts").insert({ organization_id: orgId, phone }).select("id").single();
  return data!.id as string;
}

async function makeJob(orgId: string, contactId: string, amount: number | null = null) {
  const { data } = await service.from("jobs").insert({ organization_id: orgId, contact_id: contactId, title: "AC Repair", status: "completed", completed_at: new Date().toISOString(), amount }).select("id").single();
  return data!.id as string;
}

async function makeReviewRequest(orgId: string, jobId: string, contactId: string, status: string) {
  await service.from("review_requests").insert({ organization_id: orgId, job_id: jobId, contact_id: contactId, status, requested_at: status !== "not_requested" ? new Date().toISOString() : null });
}

/**
 * end_at 30 minutes after start_at, matching the fixture convention used
 * throughout this codebase's own appointment tests. updated_at, when
 * given, MUST be passed at insert time, not via a follow-up update - the
 * real appointments_updated_at trigger (`BEFORE UPDATE ... EXECUTE
 * FUNCTION set_updated_at()`) unconditionally overwrites updated_at to
 * now() on every UPDATE, but does not fire on INSERT, so only an
 * explicit insert-time value can backdate it for a test fixture.
 */
async function makeAppointment(orgId: string, contactId: string, status: string, startAtIso: string, updatedAtOverride?: string) {
  const endAt = new Date(new Date(startAtIso).getTime() + 30 * 60 * 1000).toISOString();
  const payload: Record<string, unknown> = { organization_id: orgId, contact_id: contactId, title: "Drain Cleaning", status, start_at: startAtIso, end_at: endAt };
  if (updatedAtOverride) payload.updated_at = updatedAtOverride;
  const { data } = await service.from("appointments").insert(payload).select("id").single();
  return data!.id as string;
}

function hoursAgoIso(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

async function cleanupOrg(orgId: string) {
  await service.from("opportunities").delete().eq("organization_id", orgId);
  await service.from("review_requests").delete().eq("organization_id", orgId);
  await service.from("appointments").delete().eq("organization_id", orgId);
  await service.from("jobs").delete().eq("organization_id", orgId);
  await service.from("contacts").delete().eq("organization_id", orgId);
  await service.from("organizations").delete().eq("id", orgId);
}

// ===========================================================================
// completed_job_no_review_request
// ===========================================================================

test("R1. a completed job with review_url configured and no review request is a candidate", async () => {
  const orgId = await makeOrg("Review Detector Test Org (R1)", "https://g.page/r/example/review");
  try {
    const contactId = await makeContact(orgId, "+15555580001");
    await makeJob(orgId, contactId);

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    const match = candidates.find((c) => c.type === "completed_job_no_review_request");
    assert.ok(match, "expected a completed_job_no_review_request candidate");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("R2. review_url NULL: never a candidate, even with a completed job and no review request", async () => {
  const orgId = await makeOrg("Review Detector Test Org (R2)", null);
  try {
    const contactId = await makeContact(orgId, "+15555580002");
    await makeJob(orgId, contactId);

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(!candidates.some((c) => c.type === "completed_job_no_review_request"), "an org with no review_url configured must never produce this opportunity type");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("R3. a 'requested' review request means no candidate - the ask itself already happened", async () => {
  const orgId = await makeOrg("Review Detector Test Org (R3)", "https://g.page/r/example/review");
  try {
    const contactId = await makeContact(orgId, "+15555580003");
    const jobId = await makeJob(orgId, contactId);
    await makeReviewRequest(orgId, jobId, contactId, "requested");

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(!candidates.some((c) => c.type === "completed_job_no_review_request"));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("R4. a 'failed' review request remains eligible - the one genuinely retriable state", async () => {
  const orgId = await makeOrg("Review Detector Test Org (R4)", "https://g.page/r/example/review");
  try {
    const contactId = await makeContact(orgId, "+15555580004");
    const jobId = await makeJob(orgId, contactId);
    await makeReviewRequest(orgId, jobId, contactId, "failed");

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(candidates.some((c) => c.type === "completed_job_no_review_request" && c.sourceEntityId === jobId));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("R5/R8. a known job amount is used as estimatedValue with the correct valueBasis; a NULL amount stays NULL, never coerced to $0", async () => {
  const orgId = await makeOrg("Review Detector Test Org (R5)", "https://g.page/r/example/review");
  try {
    const contactId = await makeContact(orgId, "+15555580005");
    const knownJobId = await makeJob(orgId, contactId, 750);
    const unknownJobId = await makeJob(orgId, contactId, null);

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    const known = candidates.find((c) => c.type === "completed_job_no_review_request" && c.sourceEntityId === knownJobId);
    const unknown = candidates.find((c) => c.type === "completed_job_no_review_request" && c.sourceEntityId === unknownJobId);
    assert.equal(known?.estimatedValue, 750);
    assert.equal(known?.valueBasis, "jobs.amount");
    assert.equal(unknown?.estimatedValue, null);
    assert.equal(unknown?.valueBasis, null);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("R6. deduplication: a second sync never creates a duplicate opportunity for the same job", async () => {
  const orgId = await makeOrg("Review Detector Test Org (R6)", "https://g.page/r/example/review");
  try {
    const contactId = await makeContact(orgId, "+15555580006");
    const jobId = await makeJob(orgId, contactId);

    await syncOpportunities(service, orgId);
    const secondSync = await syncOpportunities(service, orgId);
    assert.equal(secondSync.created, 0);

    const { data: rows } = await service.from("opportunities").select("id").eq("organization_id", orgId).eq("type", "completed_job_no_review_request").eq("source_entity_id", jobId);
    assert.equal(rows?.length, 1);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("R7. dismissal permanently suppresses the same job, even though the underlying condition is unchanged", async () => {
  const orgId = await makeOrg("Review Detector Test Org (R7)", "https://g.page/r/example/review");
  try {
    const contactId = await makeContact(orgId, "+15555580007");
    await makeJob(orgId, contactId);

    await syncOpportunities(service, orgId);
    const { data: opp } = await service.from("opportunities").select("id").eq("organization_id", orgId).eq("type", "completed_job_no_review_request").single();
    await service.from("opportunities").update({ status: "dismissed", resolved_at: new Date().toISOString() }).eq("id", opp!.id);

    const resyncResult = await syncOpportunities(service, orgId);
    assert.equal(resyncResult.suppressed, 1, "a dismissed opportunity for an unchanged condition must be suppressed, never resurrected");

    const { data: stillOne } = await service.from("opportunities").select("id, status").eq("organization_id", orgId).eq("type", "completed_job_no_review_request");
    assert.equal(stillOne?.length, 1);
    assert.equal(stillOne![0].status, "dismissed");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("R9. organization isolation: a review-eligible job in organization A never appears when detecting organization B", async () => {
  const orgA = await makeOrg("Review Detector Test Org (R9-A)", "https://g.page/r/example/review");
  const orgB = await makeOrg("Review Detector Test Org (R9-B)", "https://g.page/r/example/review");
  try {
    const contactA = await makeContact(orgA, "+15555580009");
    await makeJob(orgA, contactA);

    const candidatesB = await detectAllOpportunityCandidates(service, orgB);
    assert.ok(!candidatesB.some((c) => c.type === "completed_job_no_review_request"));
  } finally {
    await cleanupOrg(orgA);
    await cleanupOrg(orgB);
  }
});

// ===========================================================================
// cancelled_appointment_no_rebooking
// ===========================================================================

test("C1. a cancelled appointment within the grace period is never a candidate", async () => {
  const orgId = await makeOrg("Rebooking Detector Test Org (C1)");
  try {
    const contactId = await makeContact(orgId, "+15555581001");
    // Cancelled (updated_at bumped to) 1 hour ago - well inside the 72h grace period.
    await makeAppointment(orgId, contactId, "cancelled", hoursAgoIso(200), hoursAgoIso(1));

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(!candidates.some((c) => c.type === "cancelled_appointment_no_rebooking"));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("C2. a cancelled appointment past the grace period, with no later booking, is a candidate", async () => {
  const orgId = await makeOrg("Rebooking Detector Test Org (C2)");
  try {
    const contactId = await makeContact(orgId, "+15555581002");
    const appointmentId = await makeAppointment(orgId, contactId, "cancelled", hoursAgoIso(200), hoursAgoIso(100));

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(candidates.some((c) => c.type === "cancelled_appointment_no_rebooking" && c.sourceEntityId === appointmentId));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("C3. a later SCHEDULED appointment for the same contact means no candidate", async () => {
  const orgId = await makeOrg("Rebooking Detector Test Org (C3)");
  try {
    const contactId = await makeContact(orgId, "+15555581003");
    await makeAppointment(orgId, contactId, "cancelled", hoursAgoIso(200), hoursAgoIso(100));
    // A real later appointment, in the future relative to the cancellation's own updated_at.
    await makeAppointment(orgId, contactId, "scheduled", new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(!candidates.some((c) => c.type === "cancelled_appointment_no_rebooking"));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("C4. a later CONFIRMED appointment for the same contact also means no candidate", async () => {
  const orgId = await makeOrg("Rebooking Detector Test Org (C4)");
  try {
    const contactId = await makeContact(orgId, "+15555581004");
    await makeAppointment(orgId, contactId, "cancelled", hoursAgoIso(200), hoursAgoIso(100));
    await makeAppointment(orgId, contactId, "confirmed", new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(!candidates.some((c) => c.type === "cancelled_appointment_no_rebooking"));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("C5. the cancelled appointment itself never counts as its own rebooking", async () => {
  const orgId = await makeOrg("Rebooking Detector Test Org (C5)");
  try {
    const contactId = await makeContact(orgId, "+15555581005");
    const appointmentId = await makeAppointment(orgId, contactId, "cancelled", hoursAgoIso(200), hoursAgoIso(100));

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(candidates.some((c) => c.type === "cancelled_appointment_no_rebooking" && c.sourceEntityId === appointmentId), "the cancelled row's own start_at must never satisfy its own rebooking check");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("C6. a later appointment for a DIFFERENT contact never counts", async () => {
  const orgId = await makeOrg("Rebooking Detector Test Org (C6)");
  try {
    const contactA = await makeContact(orgId, "+15555581006");
    const contactB = await makeContact(orgId, "+15555581007");
    const appointmentId = await makeAppointment(orgId, contactA, "cancelled", hoursAgoIso(200), hoursAgoIso(100));
    await makeAppointment(orgId, contactB, "scheduled", new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(candidates.some((c) => c.type === "cancelled_appointment_no_rebooking" && c.sourceEntityId === appointmentId), "a different contact's booking must never satisfy this contact's rebooking check");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("C7. cross-org isolation: a qualifying cancellation in organization A never appears when detecting organization B, even with a matching phone/contact shape", async () => {
  const orgA = await makeOrg("Rebooking Detector Test Org (C7-A)");
  const orgB = await makeOrg("Rebooking Detector Test Org (C7-B)");
  try {
    const contactA = await makeContact(orgA, "+15555581008");
    await makeAppointment(orgA, contactA, "cancelled", hoursAgoIso(200), hoursAgoIso(100));

    const candidatesB = await detectAllOpportunityCandidates(service, orgB);
    assert.ok(!candidatesB.some((c) => c.type === "cancelled_appointment_no_rebooking"));
  } finally {
    await cleanupOrg(orgA);
    await cleanupOrg(orgB);
  }
});

test("C8. deduplication: a second sync never creates a duplicate opportunity for the same cancelled appointment", async () => {
  const orgId = await makeOrg("Rebooking Detector Test Org (C8)");
  try {
    const contactId = await makeContact(orgId, "+15555581009");
    const appointmentId = await makeAppointment(orgId, contactId, "cancelled", hoursAgoIso(200), hoursAgoIso(100));

    await syncOpportunities(service, orgId);
    const secondSync = await syncOpportunities(service, orgId);
    assert.equal(secondSync.created, 0);

    const { data: rows } = await service.from("opportunities").select("id").eq("organization_id", orgId).eq("type", "cancelled_appointment_no_rebooking").eq("source_entity_id", appointmentId);
    assert.equal(rows?.length, 1);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("C9. dismissal permanently suppresses the same cancelled appointment", async () => {
  const orgId = await makeOrg("Rebooking Detector Test Org (C9)");
  try {
    const contactId = await makeContact(orgId, "+15555581010");
    await makeAppointment(orgId, contactId, "cancelled", hoursAgoIso(200), hoursAgoIso(100));

    await syncOpportunities(service, orgId);
    const { data: opp } = await service.from("opportunities").select("id").eq("organization_id", orgId).eq("type", "cancelled_appointment_no_rebooking").single();
    await service.from("opportunities").update({ status: "dismissed", resolved_at: new Date().toISOString() }).eq("id", opp!.id);

    const resyncResult = await syncOpportunities(service, orgId);
    assert.equal(resyncResult.suppressed, 1);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("C10. resolution: once a later qualifying appointment appears, the open opportunity auto-resolves on the next sync", async () => {
  const orgId = await makeOrg("Rebooking Detector Test Org (C10)");
  try {
    const contactId = await makeContact(orgId, "+15555581011");
    await makeAppointment(orgId, contactId, "cancelled", hoursAgoIso(200), hoursAgoIso(100));

    await syncOpportunities(service, orgId);
    const { data: openOpp } = await service.from("opportunities").select("id, status").eq("organization_id", orgId).eq("type", "cancelled_appointment_no_rebooking").single();
    assert.equal(openOpp?.status, "open");

    await makeAppointment(orgId, contactId, "scheduled", new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());
    const resyncResult = await syncOpportunities(service, orgId);
    assert.ok(resyncResult.resolved >= 1);

    const { data: resolvedOpp } = await service.from("opportunities").select("status").eq("id", openOpp!.id).single();
    assert.equal(resolvedOpp?.status, "resolved");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("C11. estimatedValue/valueBasis are always null - no dollar amount exists on an appointment itself", async () => {
  const orgId = await makeOrg("Rebooking Detector Test Org (C11)");
  try {
    const contactId = await makeContact(orgId, "+15555581012");
    await makeAppointment(orgId, contactId, "cancelled", hoursAgoIso(200), hoursAgoIso(100));

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    const match = candidates.find((c) => c.type === "cancelled_appointment_no_rebooking");
    assert.equal(match?.estimatedValue, null);
    assert.equal(match?.valueBasis, null);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("C12. a cancelled appointment with no contact_id is never a candidate - the heuristic has nothing to check rebooking against", async () => {
  const orgId = await makeOrg("Rebooking Detector Test Org (C12)");
  try {
    const startAt = hoursAgoIso(200);
    const endAt = new Date(new Date(startAt).getTime() + 30 * 60 * 1000).toISOString();
    await service.from("appointments").insert({ organization_id: orgId, contact_id: null, title: "No contact", status: "cancelled", start_at: startAt, end_at: endAt, updated_at: hoursAgoIso(100) });

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(!candidates.some((c) => c.type === "cancelled_appointment_no_rebooking"));
  } finally {
    await cleanupOrg(orgId);
  }
});

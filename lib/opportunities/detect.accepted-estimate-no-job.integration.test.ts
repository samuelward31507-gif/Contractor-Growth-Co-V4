/**
 * Pass 5C, Batch 7: integration tests for the accepted_estimate_no_job
 * opportunity detector - real, disposable Supabase fixtures against the
 * real project (service-role client), mirroring
 * lib/opportunities/detect.uncontacted-lead.integration.test.ts's own
 * established pattern exactly (per-test org, try/finally cleanup,
 * detectAllOpportunityCandidates/syncOpportunities called directly).
 *
 * REQUIRES supabase/migrations/20260925110000_opportunities_accepted_estimate_no_job_type.sql.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/opportunities/detect.accepted-estimate-no-job.integration.test.ts
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

async function makeOrg(name: string) {
  const { data } = await service.from("organizations").insert({ name, payment_status: "active" }).select("id").single();
  return data!.id as string;
}

async function makeContact(orgId: string, phone: string) {
  const { data } = await service.from("contacts").insert({ organization_id: orgId, phone }).select("id").single();
  return data!.id as string;
}

function hoursAgoIso(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

/**
 * responded_at is safe to set at insert time - estimates carries only the
 * estimates_updated_at trigger (protects updated_at on UPDATE, never
 * fires on INSERT, and never touches responded_at either way), matching
 * this codebase's own established "backdate via insert-time value, verify
 * no trigger protects the column" pattern.
 */
async function makeEstimate(
  orgId: string,
  contactId: string,
  status: "draft" | "sent" | "accepted" | "declined" | "cancelled" | "expired",
  opts: { respondedAt?: string | null; amount?: number | null } = {},
) {
  const payload: Record<string, unknown> = {
    organization_id: orgId,
    contact_id: contactId,
    title: "Roof Repair",
    status,
    // "amount" in opts, not opts.amount ?? 1500 - an explicit null (test 8's
    // own NULL-amount case) must be preserved as null, not silently
    // defaulted back to 1500 by the nullish-coalescing operator.
    amount: "amount" in opts ? opts.amount : 1500,
    sent_at: status === "draft" ? null : new Date().toISOString(),
  };
  if (opts.respondedAt !== undefined) payload.responded_at = opts.respondedAt;
  else if (status === "accepted" || status === "declined") payload.responded_at = new Date().toISOString();
  const { data } = await service.from("estimates").insert(payload).select("id").single();
  return data!.id as string;
}

async function makeJob(orgId: string, contactId: string, estimateId: string | null, amount: number | null = null) {
  const { data } = await service.from("jobs").insert({ organization_id: orgId, contact_id: contactId, estimate_id: estimateId, title: "Roof Repair", status: "scheduled", amount }).select("id").single();
  return data!.id as string;
}

async function cleanupOrg(orgId: string) {
  await service.from("opportunities").delete().eq("organization_id", orgId);
  await service.from("jobs").delete().eq("organization_id", orgId);
  await service.from("estimates").delete().eq("organization_id", orgId);
  await service.from("contacts").delete().eq("organization_id", orgId);
  await service.from("organizations").delete().eq("id", orgId);
}

test("1. an accepted estimate below the 24h threshold is never a candidate", async () => {
  const orgId = await makeOrg("Accepted Estimate No Job Test Org (1)");
  try {
    const contactId = await makeContact(orgId, "+15555620001");
    await makeEstimate(orgId, contactId, "accepted", { respondedAt: hoursAgoIso(2) });

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(!candidates.some((c) => c.type === "accepted_estimate_no_job"));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("2. an accepted estimate at/after the 24h threshold with no job is a candidate", async () => {
  const orgId = await makeOrg("Accepted Estimate No Job Test Org (2)");
  try {
    const contactId = await makeContact(orgId, "+15555620002");
    const estimateId = await makeEstimate(orgId, contactId, "accepted", { respondedAt: hoursAgoIso(25) });

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(candidates.some((c) => c.type === "accepted_estimate_no_job" && c.sourceEntityId === estimateId));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("3. an accepted estimate past the threshold WITH a linked job is never a candidate", async () => {
  const orgId = await makeOrg("Accepted Estimate No Job Test Org (3)");
  try {
    const contactId = await makeContact(orgId, "+15555620003");
    const estimateId = await makeEstimate(orgId, contactId, "accepted", { respondedAt: hoursAgoIso(48) });
    await makeJob(orgId, contactId, estimateId);

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(!candidates.some((c) => c.type === "accepted_estimate_no_job"));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("4. resolution: an open opportunity auto-resolves once a job is later linked to the estimate", async () => {
  const orgId = await makeOrg("Accepted Estimate No Job Test Org (4)");
  try {
    const contactId = await makeContact(orgId, "+15555620004");
    const estimateId = await makeEstimate(orgId, contactId, "accepted", { respondedAt: hoursAgoIso(48) });

    await syncOpportunities(service, orgId);
    const { data: opened } = await service.from("opportunities").select("id, status").eq("organization_id", orgId).eq("type", "accepted_estimate_no_job").single();
    assert.equal(opened?.status, "open");

    await makeJob(orgId, contactId, estimateId);
    const resyncResult = await syncOpportunities(service, orgId);
    assert.equal(resyncResult.resolved, 1);

    const { data: afterResync } = await service.from("opportunities").select("status").eq("id", opened!.id).single();
    assert.equal(afterResync?.status, "resolved", "the opportunity must auto-resolve once a real job is linked to the estimate, exactly like every other detector's own resolve rule");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("5. deduplication: a second sync never creates a duplicate opportunity for the same estimate", async () => {
  const orgId = await makeOrg("Accepted Estimate No Job Test Org (5)");
  try {
    const contactId = await makeContact(orgId, "+15555620005");
    await makeEstimate(orgId, contactId, "accepted", { respondedAt: hoursAgoIso(48) });

    const firstSync = await syncOpportunities(service, orgId);
    assert.equal(firstSync.created, 1);
    const secondSync = await syncOpportunities(service, orgId);
    assert.equal(secondSync.created, 0);
    assert.equal(secondSync.unchanged, 1);

    const { data: rows } = await service.from("opportunities").select("id").eq("organization_id", orgId).eq("type", "accepted_estimate_no_job");
    assert.equal(rows?.length, 1, "exactly one opportunity row must exist, regardless of repeated sync runs");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("6. dismissal permanently suppresses the same estimate, even though the underlying condition is unchanged", async () => {
  const orgId = await makeOrg("Accepted Estimate No Job Test Org (6)");
  try {
    const contactId = await makeContact(orgId, "+15555620006");
    await makeEstimate(orgId, contactId, "accepted", { respondedAt: hoursAgoIso(48) });

    await syncOpportunities(service, orgId);
    const { data: opp } = await service.from("opportunities").select("id").eq("organization_id", orgId).eq("type", "accepted_estimate_no_job").single();
    await service.from("opportunities").update({ status: "dismissed", resolved_at: new Date().toISOString() }).eq("id", opp!.id);

    const resyncResult = await syncOpportunities(service, orgId);
    assert.equal(resyncResult.suppressed, 1, "a dismissed opportunity for an unchanged condition must be suppressed, never resurrected");

    const { data: stillOne } = await service.from("opportunities").select("status").eq("organization_id", orgId).eq("type", "accepted_estimate_no_job");
    assert.equal(stillOne?.length, 1);
    assert.equal(stillOne![0].status, "dismissed");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("7. recurrence: once resolved, a genuinely new accepted-without-job condition for the SAME estimate is not possible (jobs.estimate_id is unique) - a DIFFERENT later-accepted estimate for the same contact is its own new candidate", async () => {
  const orgId = await makeOrg("Accepted Estimate No Job Test Org (7)");
  try {
    const contactId = await makeContact(orgId, "+15555620007");
    const firstEstimateId = await makeEstimate(orgId, contactId, "accepted", { respondedAt: hoursAgoIso(48) });
    await syncOpportunities(service, orgId);
    await makeJob(orgId, contactId, firstEstimateId);
    await syncOpportunities(service, orgId);

    const { data: firstOpp } = await service.from("opportunities").select("status").eq("organization_id", orgId).eq("source_entity_id", firstEstimateId).single();
    assert.equal(firstOpp?.status, "resolved", "existing established behavior: a detector-driven fact change (a job now exists) resolves the opportunity, unlike dismissal");

    const secondEstimateId = await makeEstimate(orgId, contactId, "accepted", { respondedAt: hoursAgoIso(48) });
    const thirdSync = await syncOpportunities(service, orgId);
    assert.equal(thirdSync.created, 1, "a genuinely new accepted estimate with no job is its own new, independent candidate");

    const { data: secondOpp } = await service.from("opportunities").select("status").eq("organization_id", orgId).eq("source_entity_id", secondEstimateId).single();
    assert.equal(secondOpp?.status, "open");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("8. NULL estimate.amount stays NULL, never fabricated as $0", async () => {
  const orgId = await makeOrg("Accepted Estimate No Job Test Org (8)");
  try {
    const contactId = await makeContact(orgId, "+15555620008");
    await makeEstimate(orgId, contactId, "accepted", { respondedAt: hoursAgoIso(48), amount: null });

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    const candidate = candidates.find((c) => c.type === "accepted_estimate_no_job");
    assert.ok(candidate);
    assert.equal(candidate!.estimatedValue, null);
    assert.equal(candidate!.valueBasis, null);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("9. a known estimate.amount is carried correctly as estimatedValue, with the real valueBasis", async () => {
  const orgId = await makeOrg("Accepted Estimate No Job Test Org (9)");
  try {
    const contactId = await makeContact(orgId, "+15555620009");
    await makeEstimate(orgId, contactId, "accepted", { respondedAt: hoursAgoIso(48), amount: 2400 });

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    const candidate = candidates.find((c) => c.type === "accepted_estimate_no_job");
    assert.ok(candidate);
    assert.equal(candidate!.estimatedValue, 2400);
    assert.equal(candidate!.valueBasis, "estimates.amount");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("10. a draft estimate never qualifies, even if somehow given a responded_at", async () => {
  const orgId = await makeOrg("Accepted Estimate No Job Test Org (10)");
  try {
    const contactId = await makeContact(orgId, "+15555620010");
    await makeEstimate(orgId, contactId, "draft", { respondedAt: hoursAgoIso(48) });

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(!candidates.some((c) => c.type === "accepted_estimate_no_job"));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("11. a sent (not yet responded) estimate never qualifies", async () => {
  const orgId = await makeOrg("Accepted Estimate No Job Test Org (11)");
  try {
    const contactId = await makeContact(orgId, "+15555620011");
    await makeEstimate(orgId, contactId, "sent", { respondedAt: null });

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(!candidates.some((c) => c.type === "accepted_estimate_no_job"));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("12. a declined estimate never qualifies, even with an old responded_at", async () => {
  const orgId = await makeOrg("Accepted Estimate No Job Test Org (12)");
  try {
    const contactId = await makeContact(orgId, "+15555620012");
    await makeEstimate(orgId, contactId, "declined", { respondedAt: hoursAgoIso(48) });

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(!candidates.some((c) => c.type === "accepted_estimate_no_job"));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("13. an expired estimate never qualifies", async () => {
  const orgId = await makeOrg("Accepted Estimate No Job Test Org (13)");
  try {
    const contactId = await makeContact(orgId, "+15555620013");
    await makeEstimate(orgId, contactId, "expired", { respondedAt: null });

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(!candidates.some((c) => c.type === "accepted_estimate_no_job"));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("14. a cancelled estimate never qualifies", async () => {
  const orgId = await makeOrg("Accepted Estimate No Job Test Org (14)");
  try {
    const contactId = await makeContact(orgId, "+15555620014");
    await makeEstimate(orgId, contactId, "cancelled", { respondedAt: null });

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(!candidates.some((c) => c.type === "accepted_estimate_no_job"));
  } finally {
    await cleanupOrg(orgId);
  }
});

test("15. cross-org isolation: an accepted-without-job estimate in organization A never appears when detecting organization B", async () => {
  const orgA = await makeOrg("Accepted Estimate No Job Test Org (15A)");
  const orgB = await makeOrg("Accepted Estimate No Job Test Org (15B)");
  try {
    const contactA = await makeContact(orgA, "+15555620015");
    await makeEstimate(orgA, contactA, "accepted", { respondedAt: hoursAgoIso(48) });

    const candidatesB = await detectAllOpportunityCandidates(service, orgB);
    assert.ok(!candidatesB.some((c) => c.type === "accepted_estimate_no_job"));
  } finally {
    await cleanupOrg(orgA);
    await cleanupOrg(orgB);
  }
});

test("16. an unrelated job with a NULL estimate_id never resolves an open opportunity", async () => {
  const orgId = await makeOrg("Accepted Estimate No Job Test Org (16)");
  try {
    const contactId = await makeContact(orgId, "+15555620016");
    const estimateId = await makeEstimate(orgId, contactId, "accepted", { respondedAt: hoursAgoIso(48) });
    await makeJob(orgId, contactId, null);

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(candidates.some((c) => c.type === "accepted_estimate_no_job" && c.sourceEntityId === estimateId), "a job with no estimate_id at all must never satisfy this detector");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("17. a job linked to a DIFFERENT estimate never resolves this estimate's opportunity", async () => {
  const orgId = await makeOrg("Accepted Estimate No Job Test Org (17)");
  try {
    const contactId = await makeContact(orgId, "+15555620017");
    const targetEstimateId = await makeEstimate(orgId, contactId, "accepted", { respondedAt: hoursAgoIso(48) });
    const otherEstimateId = await makeEstimate(orgId, contactId, "accepted", { respondedAt: hoursAgoIso(1) }); // below threshold, not itself a candidate
    await makeJob(orgId, contactId, otherEstimateId);

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(candidates.some((c) => c.type === "accepted_estimate_no_job" && c.sourceEntityId === targetEstimateId), "a job linked to a different estimate must never satisfy this one's detection");
    assert.ok(!candidates.some((c) => c.type === "accepted_estimate_no_job" && c.sourceEntityId === otherEstimateId), "the other estimate is below threshold regardless");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("18. existing opportunity types remain unaffected by this detector running alongside them", async () => {
  const orgId = await makeOrg("Accepted Estimate No Job Test Org (18)");
  try {
    const contactId = await makeContact(orgId, "+15555620018");
    // A stale_estimate candidate (status='expired') and an accepted_estimate_no_job
    // candidate coexist without interfering with each other's detection.
    await makeEstimate(orgId, contactId, "expired", { respondedAt: null });
    const acceptedId = await makeEstimate(orgId, contactId, "accepted", { respondedAt: hoursAgoIso(48) });

    const candidates = await detectAllOpportunityCandidates(service, orgId);
    assert.ok(candidates.some((c) => c.type === "stale_estimate"), "the existing stale_estimate detector must still fire independently");
    assert.ok(candidates.some((c) => c.type === "accepted_estimate_no_job" && c.sourceEntityId === acceptedId));
  } finally {
    await cleanupOrg(orgId);
  }
});

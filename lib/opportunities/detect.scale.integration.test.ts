/**
 * Phase 2H: Today's opportunity detection and sync at real volume against
 * disposable TEST fixtures - every scenario past the ~400-id point where an
 * id-list read failed, and the large ones past the API's 1,000-row cap:
 *   - 450 completed visits, 225 with an estimate        -> 225 completed_appointment_no_estimate
 *   - 450 dormant customers (old completed jobs)        -> 450 dormant_customer
 *   - those 450 completed jobs, 225 with requests       -> 225 referral + 225 review candidates
 *   - 450 uncontacted leads, 225 contacted              -> 225 uncontacted_lead
 *   - 450 accepted estimates, 225 with a job            -> 225 accepted_estimate_no_job
 *   - 1,100 qualified leads, 1,050 booked               -> 50 qualified_lead_unbooked
 *   - 1,050 no-shows already dismissed                  -> never re-created
 * Then two consecutive syncs (no false resolutions, no resurrections), a
 * 225-row resolution through the lost-lead lookup, and organization
 * isolation.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/opportunities/detect.scale.integration.test.ts
 *
 * Inserts are plain rows - no automation, n8n or provider call. after()
 * deletes both fixture organizations; everything else cascades.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const REPO_ROOT = process.cwd();
const require = createRequire(path.join(REPO_ROOT, "package.json"));
require("@next/env").loadEnvConfig(REPO_ROOT, true, { info() {}, error() {} });
if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("lwofqffxagxiqodqvcfr")) throw new Error("Phase 2H scale fixtures run against the TEST project only.");

const { createServiceRoleClient }: typeof import("@/lib/supabase/service") = require(path.join(REPO_ROOT, "lib/supabase/service.ts"));
const { syncOpportunities, detectAllOpportunityCandidates }: typeof import("./detect") = require(path.join(REPO_ROOT, "lib/opportunities/detect.ts"));
const { getPrioritizedOpportunities }: typeof import("./intelligence") = require(path.join(REPO_ROOT, "lib/opportunities/intelligence.ts"));

const service = createServiceRoleClient();
const N = 450;
const HALF = N / 2;
const DAY = 86_400_000;
const NOW = new Date();
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
let orgA = "";
let orgB = "";

async function insertAll(table: string, rows: Record<string, unknown>[], columns = "id"): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < rows.length; i += 500) {
    const { data, error } = await service.from(table).insert(rows.slice(i, i + 500) as never).select(columns);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as unknown as Record<string, unknown>[]));
  }
  return out;
}
const ids = (rows: Record<string, unknown>[]) => rows.map((row) => row.id as string);
// appointments_no_overlap forbids overlapping scheduled/confirmed/completed appointments in one
// organization, so each of those gets its own 30-minute slot.
let slot = 0;
const nextSlot = () => {
  const start = NOW.getTime() - 40 * DAY + slot++ * 30 * 60_000;
  return { start_at: new Date(start).toISOString(), end_at: new Date(start + 20 * 60_000).toISOString() };
};

let phone = 0;
async function contacts(orgId: string, n: number) {
  return ids(await insertAll("contacts", range(n).map(() => ({ organization_id: orgId, first_name: "Fixture", last_name: "Contact", phone: `+15557${String(10_000 + phone++).padStart(6, "0")}` }))));
}

before(async () => {
  const orgs = await insertAll(
    "organizations",
    [
      { name: "Phase 2H Opportunity Scale Test Org A", timezone: "UTC", review_url: "https://example.com/review", automation_mode: "live", payment_status: "active", automation_paused: false },
      { name: "Phase 2H Opportunity Scale Test Org B", timezone: "UTC", review_url: "https://example.com/review", automation_mode: "live", payment_status: "active", automation_paused: false },
    ],
    "id, name",
  );
  orgA = orgs.find((o) => String(o.name).endsWith("A"))!.id as string;
  orgB = orgs.find((o) => String(o.name).endsWith("B"))!.id as string;

  // Completed visits: 450 leads, each with a completed appointment; 225 with an estimate (two for some).
  const visitContacts = await contacts(orgA, N);
  const visitLeads = ids(await insertAll("leads", visitContacts.map((c) => ({ organization_id: orgA, contact_id: c, status: "estimate", temperature: "warm", created_at: daysAgo(20) }))));
  await insertAll("appointments", visitLeads.map((lead, i) => ({ organization_id: orgA, contact_id: visitContacts[i], lead_id: lead, title: "Visit", status: "completed", ...nextSlot() })));
  await insertAll("estimates", [
    ...visitLeads.slice(0, HALF).map((lead, i) => ({ organization_id: orgA, contact_id: visitContacts[i], lead_id: lead, title: "Quote", status: "draft", amount: 1 })),
    ...visitLeads.slice(0, 50).map((lead, i) => ({ organization_id: orgA, contact_id: visitContacts[i], lead_id: lead, title: "Quote 2", status: "draft", amount: 1 })),
  ]);

  // Dormant customers: 450 contacts whose only job finished 400 days ago; 225 of those jobs have review and referral requests.
  const dormantContacts = await contacts(orgA, N);
  const oldJobs = ids(await insertAll("jobs", dormantContacts.map((c) => ({ organization_id: orgA, contact_id: c, title: "Old job", status: "completed", amount: 500, completed_at: daysAgo(400), created_at: daysAgo(410) }))));
  await insertAll("review_requests", oldJobs.slice(0, HALF).map((job) => ({ organization_id: orgA, job_id: job, status: "requested" })));
  await insertAll("referral_requests", oldJobs.slice(0, HALF).map((job) => ({ organization_id: orgA, job_id: job, status: "requested" })));

  // Uncontacted leads: 450 'new' leads three days old; 225 contacts have a delivered outbound message, the rest only failed sends.
  const newContacts = await contacts(orgA, N);
  const newLeads = ids(await insertAll("leads", newContacts.map((c) => ({ organization_id: orgA, contact_id: c, status: "new", temperature: "cold", created_at: daysAgo(3) }))));
  const conversations = ids(await insertAll("conversations", newContacts.map((c) => ({ organization_id: orgA, contact_id: c, channel: "sms", status: "open" }))));
  await insertAll("messages", conversations.map((conversation, i) => ({ organization_id: orgA, conversation_id: conversation, direction: "outbound", sender_type: "user", body: "Phase 2H fixture", status: i < HALF ? "delivered" : "failed", created_at: daysAgo(2) })));
  void newLeads;

  // Accepted estimates: 450 accepted three days ago; 225 already have a job.
  const acceptedContacts = await contacts(orgA, N);
  const accepted = ids(await insertAll("estimates", acceptedContacts.map((c) => ({ organization_id: orgA, contact_id: c, title: "Accepted", status: "accepted", amount: 900, sent_at: daysAgo(6), responded_at: daysAgo(3) }))));
  await insertAll("jobs", accepted.slice(0, HALF).map((estimate, i) => ({ organization_id: orgA, contact_id: acceptedContacts[i], estimate_id: estimate, title: "From estimate", status: "scheduled", amount: 900 })));

  // Qualified leads past 1,000: 1,100 qualified, 1,050 booked.
  const [qualifiedContact] = await contacts(orgA, 1);
  const qualified = ids(await insertAll("leads", range(1100).map(() => ({ organization_id: orgA, contact_id: qualifiedContact, status: "qualified", temperature: "warm", created_at: daysAgo(15) }))));
  await insertAll("appointments", qualified.slice(0, 1050).map((lead) => ({ organization_id: orgA, contact_id: qualifiedContact, lead_id: lead, title: "Booked", status: "scheduled", ...nextSlot() })));

  // 1,050 no-shows, every one already dismissed long ago - must never be re-created.
  const noShows = ids(await insertAll("appointments", range(1050).map(() => ({ organization_id: orgA, contact_id: qualifiedContact, title: "Missed", status: "no_show", start_at: daysAgo(30), end_at: daysAgo(30 - 0.01) }))));
  await insertAll("opportunities", noShows.map((appointment) => ({ organization_id: orgA, type: "no_show", source_entity_type: "appointment", source_entity_id: appointment, status: "dismissed", resolved_at: daysAgo(25), title: "Missed", created_at: daysAgo(29) })));

  // Organization B: one of a few kinds, never counted for A.
  const [bContact] = await contacts(orgB, 1);
  await insertAll("leads", [{ organization_id: orgB, contact_id: bContact, status: "qualified", temperature: "warm" }]);
  await insertAll("jobs", [{ organization_id: orgB, contact_id: bContact, title: "B job", status: "completed", amount: 1, completed_at: daysAgo(400), created_at: daysAgo(410) }]);
});

after(async () => {
  for (const orgId of [orgA, orgB].filter(Boolean)) {
    const { error } = await service.from("organizations").delete().eq("id", orgId);
    if (error) console.error(`PHASE2H_FIXTURE_CLEANUP_FAILED=${orgId}: ${error.message}`);
  }
});

const countByType = (rows: { type: string }[]) => rows.reduce<Record<string, number>>((acc, row) => ((acc[row.type] = (acc[row.type] ?? 0) + 1), acc), {});

test("detection at scale: every type complete, each exactly as defined", async () => {
  const counts = countByType(await detectAllOpportunityCandidates(service, orgA, NOW));
  assert.equal(counts.completed_appointment_no_estimate, HALF);
  assert.equal(counts.dormant_customer, N);
  assert.equal(counts.completed_job_no_referral_request, HALF);
  assert.equal(counts.completed_job_no_review_request, HALF);
  assert.equal(counts.uncontacted_lead, HALF);
  assert.equal(counts.accepted_estimate_no_job, HALF);
  assert.equal(counts.qualified_lead_unbooked, 50);
  assert.equal(counts.no_show, 1050, "still detected - suppression happens in the sync");
});

test("two consecutive syncs: everything created once, dismissed no-shows never re-created, nothing falsely resolved", async () => {
  const first = await syncOpportunities(service, orgA, NOW);
  assert.equal(first.failed, undefined, JSON.stringify(first));
  assert.equal(first.suppressed, 1050);
  assert.equal(first.resolved, 0);
  const second = await syncOpportunities(service, orgA, NOW);
  assert.deepEqual([second.failed, second.created, second.resolved, second.suppressed], [undefined, 0, 0, 1050], JSON.stringify(second));

  // Exact counts per type - a plain read would itself stop at the API's 1,000 rows.
  const openCount = async (type: string) => (await service.from("opportunities").select("id", { count: "exact", head: true }).eq("organization_id", orgA).eq("type", type).eq("status", "open")).count;
  assert.equal(await openCount("no_show"), 0, "no dismissed no-show re-opened");
  assert.deepEqual(
    await Promise.all(["completed_appointment_no_estimate", "dormant_customer", "completed_job_no_referral_request", "completed_job_no_review_request", "uncontacted_lead", "accepted_estimate_no_job", "qualified_lead_unbooked"].map(openCount)),
    [HALF, N, HALF, HALF, HALF, HALF, 50],
  );
});

test("resolution at scale: 225 uncontacted leads marked lost resolve as 'lost' through the paged lookup and chunked updates", async () => {
  const { data: targets } = await service.from("opportunities").select("source_entity_id").eq("organization_id", orgA).eq("type", "uncontacted_lead").eq("status", "open").range(0, 999);
  assert.equal(targets!.length, HALF);
  for (let i = 0; i < targets!.length; i += 200) {
    const { error } = await service.from("leads").update({ status: "lost" }).in("id", targets!.slice(i, i + 200).map((row) => row.source_entity_id as string));
    assert.equal(error, null);
  }
  const result = await syncOpportunities(service, orgA, NOW);
  assert.equal(result.failed, undefined);
  assert.equal(result.resolved, HALF);
  const { data: resolved } = await service.from("opportunities").select("resolution_reason").eq("organization_id", orgA).eq("type", "uncontacted_lead").eq("status", "resolved").range(0, 999);
  assert.equal(resolved!.length, HALF);
  assert.ok(resolved!.every((row) => row.resolution_reason === "lost"));
});

test("Today's prioritized list: contact details found for every shown opportunity, with no contact id list", async () => {
  const prioritized = await getPrioritizedOpportunities(service, orgA, NOW);
  assert.equal(prioritized.length, 500, "the 500-newest display limit is unchanged");
  assert.ok(prioritized.filter((p) => p.opportunity.contactId).every((p) => p.contactPhone !== null), "every shown opportunity's contact phone was read");
});

test("organization isolation: B's sync sees only B's records and never touches A's opportunities", async () => {
  const { count: before } = await service.from("opportunities").select("id", { count: "exact", head: true }).eq("organization_id", orgA);
  const result = await syncOpportunities(service, orgB, NOW);
  assert.equal(result.failed, undefined);
  const { data: bRows } = await service.from("opportunities").select("type").eq("organization_id", orgB);
  // B's one contact has an open (qualified) lead, so by definition it is not a dormant customer.
  assert.deepEqual(countByType(bRows ?? []), { qualified_lead_unbooked: 1, completed_job_no_referral_request: 1, completed_job_no_review_request: 1 });
  const { count: afterCount } = await service.from("opportunities").select("id", { count: "exact", head: true }).eq("organization_id", orgA);
  assert.equal(afterCount, before);
});

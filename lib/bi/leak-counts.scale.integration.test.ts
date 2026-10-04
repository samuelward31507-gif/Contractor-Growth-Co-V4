/**
 * Phase 2G: the Analytics leak counts at real volume against disposable TEST
 * fixtures, read through the snapshot exactly as the page does:
 *   - Visits, no estimate: 450 leads with a completed visit (past the ~400-id
 *     point where the old estimate lookup failed), some with two visits;
 *     300 with estimates, some with several - exactly 150 without.
 *   - Qualified, no appointment: 1,100 qualified leads, 1,050 of them with an
 *     appointment - past the API's 1,000-row cap. Phase 2-8 (M6): Today's
 *     rule, so the 420 cancelled or no-show ones are not bookings - exactly
 *     470 unbooked, never inflated; the booking rate (any appointment) is
 *     unchanged.
 *   - Estimate values: 1,500 sent/expired/declined estimates - exact
 *     recoverable and declined value, complete aging and past-expiry.
 *   - Organization isolation.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/bi/leak-counts.scale.integration.test.ts
 *
 * Inserts are plain rows - no automation, n8n or provider call. after()
 * deletes every fixture organization; everything else cascades.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const REPO_ROOT = process.cwd();
const require = createRequire(path.join(REPO_ROOT, "package.json"));
require("@next/env").loadEnvConfig(REPO_ROOT, true, { info() {}, error() {} });
if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("lwofqffxagxiqodqvcfr")) throw new Error("Phase 2G scale fixtures run against the TEST project only.");

const { createServiceRoleClient }: typeof import("@/lib/supabase/service") = require(path.join(REPO_ROOT, "lib/supabase/service.ts"));
const { getBusinessMetricsSnapshot }: typeof import("./metrics") = require(path.join(REPO_ROOT, "lib/bi/metrics.ts"));
const { syncOpportunities }: typeof import("@/lib/opportunities/detect") = require(path.join(REPO_ROOT, "lib/opportunities/detect.ts"));

const service = createServiceRoleClient();
const DAY = 86_400_000;
const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
// Noon UTC n days ago - clear of any calendar-day boundary for the aging buckets.
const noonDaysAgo = (days: number) => {
  const d = new Date(NOW - days * DAY);
  d.setUTCHours(12, 0, 0, 0);
  return d.toISOString();
};

const orgs: Record<"visits" | "qualified" | "estimates" | "other", string> = { visits: "", qualified: "", estimates: "", other: "" };

async function insertAll(table: string, rows: Record<string, unknown>[], columns = "id"): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < rows.length; i += 500) {
    const { data, error } = await service.from(table).insert(rows.slice(i, i + 500) as never).select(columns);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as unknown as Record<string, unknown>[]));
  }
  return out;
}

async function seedOrg(key: keyof typeof orgs) {
  const [org] = await insertAll("organizations", [{ name: `Phase 2G Leak Count Test Org (${key})`, timezone: "UTC" }]);
  orgs[key] = org.id as string;
  const [contact] = await insertAll("contacts", [{ organization_id: org.id, phone: `+155555960${Object.keys(orgs).indexOf(key)}0` }]);
  return { orgId: org.id as string, contactId: contact.id as string };
}

const appointment = (orgId: string, contactId: string, leadId: string, status: string, i: number) => ({
  organization_id: orgId, contact_id: contactId, lead_id: leadId, title: "Phase 2G fixture visit", status, start_at: iso(NOW - (i + 2) * 3_600_000), end_at: iso(NOW - (i + 1) * 3_600_000),
});
const estimate = (orgId: string, contactId: string, leadId: string | null, status: string, amount: number, sentAt: string | null, expiresAt: string | null) => ({
  organization_id: orgId, contact_id: contactId, lead_id: leadId, title: "Phase 2G fixture estimate", status, amount, sent_at: sentAt, expires_at: expiresAt,
});

before(async () => {
  // Visits, no estimate.
  {
    const { orgId, contactId } = await seedOrg("visits");
    const leads = (await insertAll("leads", Array.from({ length: 450 }, () => ({ organization_id: orgId, contact_id: contactId, status: "estimate", temperature: "warm", source: "website" })), "id")).map((l) => l.id as string);
    await insertAll("appointments", [
      ...leads.map((leadId, i) => appointment(orgId, contactId, leadId, "completed", i)),
      ...leads.slice(400).map((leadId, i) => appointment(orgId, contactId, leadId, "completed", 500 + i)), // a second visit for 50 unestimated leads
    ]);
    await insertAll("estimates", [
      ...leads.slice(0, 300).map((leadId) => estimate(orgId, contactId, leadId, "draft", 100, null, null)),
      ...leads.slice(0, 100).flatMap((leadId) => [estimate(orgId, contactId, leadId, "accepted", 100, null, null), estimate(orgId, contactId, leadId, "declined", 100, null, null)]),
    ]);
  }
  // Qualified, no appointment + booking rate.
  {
    const { orgId, contactId } = await seedOrg("qualified");
    const leads = (await insertAll("leads", Array.from({ length: 1100 }, () => ({ organization_id: orgId, contact_id: contactId, status: "qualified", temperature: "warm", source: "website" })), "id")).map((l) => l.id as string);
    const statuses = ["scheduled", "confirmed", "completed", "cancelled", "no_show"];
    await insertAll("appointments", leads.slice(0, 1050).map((leadId, i) => appointment(orgId, contactId, leadId, statuses[i % statuses.length], i)));
  }
  // Estimate values and aging: 600 sent, 500 expired, 400 declined.
  {
    const { orgId, contactId } = await seedOrg("estimates");
    await insertAll("estimates", [
      ...Array.from({ length: 600 }, (_, i) => estimate(orgId, contactId, null, "sent", 100, noonDaysAgo(i < 200 ? 3 : i < 400 ? 15 : 45), i % 3 === 0 ? iso(NOW - DAY) : iso(NOW + 10 * DAY))),
      ...Array.from({ length: 500 }, () => estimate(orgId, contactId, null, "expired", 50, noonDaysAgo(60), iso(NOW - 30 * DAY))),
      ...Array.from({ length: 400 }, () => estimate(orgId, contactId, null, "declined", 25.5, noonDaysAgo(20), null)),
    ]);
  }
  // Another organization - one of everything, never counted for the others.
  {
    const { orgId, contactId } = await seedOrg("other");
    const [qualified, visited] = (await insertAll("leads", [{ organization_id: orgId, contact_id: contactId, status: "qualified", temperature: "warm" }, { organization_id: orgId, contact_id: contactId, status: "estimate", temperature: "warm" }], "id")).map((l) => l.id as string);
    void qualified;
    await insertAll("appointments", [appointment(orgId, contactId, visited, "completed", 0)]);
    // Phase 2-8 (L5): created before the visit, so it stays "one visit with no estimate" - a lead-less estimate
    // for the same contact created after the visit would now satisfy it.
    await insertAll("estimates", [{ ...estimate(orgId, contactId, null, "sent", 7777, noonDaysAgo(2), null), created_at: noonDaysAgo(3) }]);
  }
  // Phase 2-8 (M9): "Qualified, no appointment" and "Visits, no estimate" count Today's open opportunity rows, which the sync maintains.
  for (const orgId of Object.values(orgs)) {
    const result = await syncOpportunities(service, orgId);
    if (result.failed) throw new Error(`fixture sync failed for ${orgId}`);
  }
});

after(async () => {
  for (const orgId of Object.values(orgs).filter(Boolean)) {
    const { error } = await service.from("organizations").delete().eq("id", orgId);
    if (error) console.error(`PHASE2G_FIXTURE_CLEANUP_FAILED=${orgId}: ${error.message}`);
  }
});

test("visits, no estimate: 450 leads with a completed visit, 300 with estimates (some several), 50 with two visits - exactly 150, each lead once", async () => {
  const snapshot = await getBusinessMetricsSnapshot(service, orgs.visits, "last30Days");
  assert.equal(snapshot.revenueOpportunityUnavailable.visitsNoEstimate, false);
  assert.equal(snapshot.revenueOpportunity.completedAppointmentsWithoutEstimate, 150);
});

// Phase 2-8 (M6): this used to count cancelled and no-show appointments as bookings (exactly 50) - the old
// Insights rule that disagreed with Today. Insights now uses Today's rule: 50 with no appointment plus the
// 420 (2 in 5 of 1,050) whose only appointment is cancelled or a no-show.
test("qualified, no appointment (Phase 2-8): 1,100 qualified leads with 1,050 appointments - cancelled and no-show are not bookings - exactly 470, never inflated; booking rate exact", async () => {
  const snapshot = await getBusinessMetricsSnapshot(service, orgs.qualified, "last30Days");
  assert.equal(snapshot.revenueOpportunityUnavailable.qualifiedNoAppointment, false);
  assert.equal(snapshot.revenueOpportunity.qualifiedLeadsWithoutAppointment, 470);
  assert.equal(snapshot.leadMetrics.leadToBookingRate, (1050 / 1100) * 100);
});

test("estimates: 1,500 sent/expired/declined - exact recoverable and declined value, complete aging buckets and past-expiry", async () => {
  const { revenueOpportunity: o, estimateAging: aging, revenueOpportunityUnavailable } = await getBusinessMetricsSnapshot(service, orgs.estimates, "last30Days");
  assert.equal(revenueOpportunityUnavailable.estimates, false);
  assert.deepEqual([o.openEstimateValue, o.expiredEstimateValue, o.lostEstimateValue, o.recoverableEstimateValue], [60_000, 25_000, 10_200, 85_000]);
  assert.deepEqual(aging.buckets.map((b) => [b.key, b.count, b.value]), [["0-7", 200, 20_000], ["8-30", 200, 20_000], ["31+", 200, 20_000], ["undated", 0, 0]]);
  assert.deepEqual([aging.pastExpiryCount, aging.pastExpiryValue], [200, 20_000]);
});

test("organization isolation: each organization sees only its own leaks", async () => {
  const other = await getBusinessMetricsSnapshot(service, orgs.other, "last30Days");
  assert.deepEqual(other.revenueOpportunityUnavailable, { qualifiedNoAppointment: false, visitsNoEstimate: false, estimates: false });
  assert.deepEqual([other.revenueOpportunity.qualifiedLeadsWithoutAppointment, other.revenueOpportunity.completedAppointmentsWithoutEstimate, other.revenueOpportunity.recoverableEstimateValue], [1, 1, 7777]);
  const visits = await getBusinessMetricsSnapshot(service, orgs.visits, "last30Days");
  assert.deepEqual([visits.revenueOpportunity.qualifiedLeadsWithoutAppointment, visits.revenueOpportunity.recoverableEstimateValue], [0, 0]);
});

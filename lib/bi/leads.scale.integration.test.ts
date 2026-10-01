/**
 * Phase 2I: the lead reads at real volume against disposable TEST fixtures,
 * read exactly as Analytics reads them:
 *   - 1,500 leads in the last 30 days (mixed statuses, temperatures and
 *     sources): Leads, stage, temperature and source counts, lost rate - and
 *     the same 1,500 in Revenue by source (2C), Lead -> booking's "of N
 *     leads" (2D) and the leads-per-day chart;
 *   - 1,100 leads in the previous 30 days: the comparison is complete;
 *   - 1,200 open leads created long ago with known values: open count,
 *     value and average (plus the open leads among the 1,500);
 *   - organization isolation.
 * A source-read failure can't be induced safely on TEST; it is unit-tested
 * in leads.scale.test.ts.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/bi/leads.scale.integration.test.ts
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
if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("lwofqffxagxiqodqvcfr")) throw new Error("Phase 2I scale fixtures run against the TEST project only.");

const { createServiceRoleClient }: typeof import("@/lib/supabase/service") = require(path.join(REPO_ROOT, "lib/supabase/service.ts"));
const { getBusinessMetricsSnapshot }: typeof import("./metrics") = require(path.join(REPO_ROOT, "lib/bi/metrics.ts"));
const { resolveDateRange }: typeof import("./queries") = require(path.join(REPO_ROOT, "lib/bi/queries.ts"));
const { getRevenueAttribution }: typeof import("./revenue-attribution") = require(path.join(REPO_ROOT, "lib/bi/revenue-attribution.ts"));
const { getOutcomeMetrics }: typeof import("./outcome-metrics") = require(path.join(REPO_ROOT, "lib/bi/outcome-metrics.ts"));
const { getLeadsCreatedPerDay }: typeof import("./series") = require(path.join(REPO_ROOT, "lib/bi/series.ts"));

const service = createServiceRoleClient();
const TZ = "UTC";
const NOW = new Date();
const DAY = 86_400_000;
const noonDaysAgo = (days: number) => {
  const d = new Date(NOW.getTime() - days * DAY);
  d.setUTCHours(12, 0, 0, 0);
  return d.toISOString();
};
const STATUSES = ["new", "contacted", "qualified", "appointment", "estimate", "won", "lost"];
const OPEN = new Set(["new", "contacted", "qualified", "appointment", "estimate"]);
const TEMPERATURES = ["hot", "warm", "cold"];
const SOURCES = ["Google", " Google ", "Referral", "", "   ", null, "Yelp"];
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const current = range(1500).map((i) => ({ status: STATUSES[i % 7], temperature: TEMPERATURES[i % 3], source: SOURCES[i % 7], created_at: noonDaysAgo(1 + (i % 28)) }));
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

before(async () => {
  const orgs = await insertAll("organizations", [{ name: "Phase 2I Lead Scale Test Org A", timezone: TZ }, { name: "Phase 2I Lead Scale Test Org B", timezone: TZ }], "id, name");
  orgA = orgs.find((o) => String(o.name).endsWith("A"))!.id as string;
  orgB = orgs.find((o) => String(o.name).endsWith("B"))!.id as string;
  const [contactA] = await insertAll("contacts", [{ organization_id: orgA, phone: "+15557900001" }]);
  const [contactB] = await insertAll("contacts", [{ organization_id: orgB, phone: "+15557900002" }]);
  const lead = (org: string, contact: unknown, fields: Record<string, unknown>) => ({ organization_id: org, contact_id: contact, temperature: "warm", ...fields });

  await insertAll("leads", [
    ...current.map((fields) => lead(orgA, contactA.id, fields)),
    // The previous 30 days: 1,100 won leads.
    ...range(1100).map((i) => lead(orgA, contactA.id, { status: "won", created_at: noonDaysAgo(32 + (i % 25)) })),
    // Long ago: 1,200 open leads with known values.
    ...range(1200).map((i) => lead(orgA, contactA.id, { status: OPEN.has(STATUSES[i % 5]) ? STATUSES[i % 5] : "new", estimated_value: i < 600 ? 1000 : 500, created_at: noonDaysAgo(200) })),
  ]);
  await insertAll("leads", range(3).map(() => lead(orgB, contactB.id, { status: "new", source: "Google", estimated_value: 7, created_at: noonDaysAgo(2) })));
});

after(async () => {
  for (const orgId of [orgA, orgB].filter(Boolean)) {
    const { error } = await service.from("organizations").delete().eq("id", orgId);
    if (error) console.error(`PHASE2I_FIXTURE_CLEANUP_FAILED=${orgId}: ${error.message}`);
  }
});

test("1,500 leads in the period: Leads, every stage and temperature, lost rate and source counts are exact", async () => {
  const s = await getBusinessMetricsSnapshot(service, orgA, "last30Days", { timeZone: TZ, now: NOW });
  const m = s.leadMetrics;
  const count = (status: string) => current.filter((l) => l.status === status).length;
  assert.equal(m.totalLeads, 1500);
  assert.deepEqual([m.newLeads, m.contactedLeads, m.qualifiedLeads, m.appointmentStageLeads, m.estimateStageLeads, m.wonLeads, m.lostLeads], STATUSES.map(count));
  assert.deepEqual([m.hotLeads, m.warmLeads, m.coldLeads], [500, 500, 500]);
  assert.equal(m.lostRate, (count("lost") / (count("won") + count("lost"))) * 100);
  assert.deepEqual(m.sourceCounts, { Google: 214 * 2 + 2, Referral: 214, unknown: 214 * 3, Yelp: 214 });
  assert.equal(s.sourceCountsUnavailable, false);
  assert.equal(s.partialData, false);
});

test("the comparison uses the complete 1,100-lead previous period", async () => {
  const s = await getBusinessMetricsSnapshot(service, orgA, "last30Days", { timeZone: TZ, now: NOW });
  assert.deepEqual([s.comparisons.leadCount.current, s.comparisons.leadCount.previous], [1500, 1100]);
});

test("open leads: the 1,200 old open leads plus the period's open ones - exact count, value and average", async () => {
  const s = await getBusinessMetricsSnapshot(service, orgA, "last30Days", { timeZone: TZ, now: NOW });
  const openInPeriod = current.filter((l) => OPEN.has(l.status)).length;
  assert.equal(s.pipelineMetrics.openOpportunityCount, 1200 + openInPeriod);
  assert.equal(s.pipelineMetrics.pipelineValue, 900_000, "the period's leads carry no estimated value");
  assert.equal(s.pipelineMetrics.averagePipelineValue, 900_000 / (1200 + openInPeriod));
});

test("every Analytics lead count agrees: Leads = Revenue by source leads = Lead -> booking's 'of N leads' = the chart's total", async () => {
  const range30 = resolveDateRange("last30Days", NOW, TZ);
  const [s, attribution, outcomes] = await Promise.all([
    getBusinessMetricsSnapshot(service, orgA, "last30Days", { timeZone: TZ, now: NOW }),
    getRevenueAttribution(service, orgA, range30),
    getOutcomeMetrics(service, orgA, range30),
  ]);
  const chart = await getLeadsCreatedPerDay(service, orgA, { from: range30.from!, to: range30.to! }, TZ);
  assert.equal(chart.failed, false);
  assert.deepEqual([s.comparisons.leadCount.current, attribution.totals.leads, outcomes.leadsInRange, chart.data.reduce((sum, day) => sum + day.count, 0)], [1500, 1500, 1500, 1500]);
});

test("organization isolation: B sees only its own 3 leads, and A never sees them", async () => {
  const b = await getBusinessMetricsSnapshot(service, orgB, "last30Days", { timeZone: TZ, now: NOW });
  assert.deepEqual([b.leadMetrics.totalLeads, b.pipelineMetrics.openOpportunityCount, b.pipelineMetrics.pipelineValue, b.leadMetrics.sourceCounts], [3, 3, 21, { Google: 3 }]);
});

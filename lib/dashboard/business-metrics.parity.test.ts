/**
 * Phase 2A-1: parity between the Dashboard's old business-metrics path (two
 * whole getBusinessMetricsSnapshot calls) and its new one
 * (getDashboardPipelineValue + getDashboardAiHandled).
 *
 * Both paths run for real - the real @supabase/supabase-js client, the real
 * lib/bi helpers - against a small fake PostgREST server on 127.0.0.1 that
 * serves deterministic seeded rows and understands the filters these
 * helpers use (eq, neq, in, gte, lt, lte, gt, is/not.is null, limit, exact
 * counts). No network, no real project.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/dashboard/business-metrics.parity.test.ts
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(path.join(process.cwd(), "package.json"));

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const NOW = Date.now();
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();

type Row = Record<string, unknown>;
const SEED: Record<string, Row[]> = {
  organizations: [{ id: ORG, timezone: "UTC" }],
  leads: [
    { id: "l1", organization_id: ORG, status: "new", temperature: "hot", estimated_value: 1200, source: "web", contact_id: "c1", created_at: iso(0) },
    { id: "l2", organization_id: ORG, status: "qualified", temperature: "warm", estimated_value: 3400.5, source: "phone", contact_id: "c2", created_at: iso(3) },
    { id: "l3", organization_id: ORG, status: "estimate", temperature: "cold", estimated_value: null, source: "web", contact_id: "c3", created_at: iso(12) },
    { id: "l4", organization_id: ORG, status: "contacted", temperature: "warm", estimated_value: 800, source: "referral", contact_id: "c4", created_at: iso(90) },
    { id: "l5", organization_id: ORG, status: "won", temperature: "hot", estimated_value: 9999, source: "web", contact_id: "c5", created_at: iso(5) },
    { id: "l6", organization_id: ORG, status: "lost", temperature: "cold", estimated_value: 5000, source: "web", contact_id: "c6", created_at: iso(8) },
    // Another organization's open lead - must never be counted.
    { id: "l7", organization_id: OTHER_ORG, status: "new", temperature: "hot", estimated_value: 777777, source: "web", contact_id: "c7", created_at: iso(0) },
  ],
  ai_interactions: [
    { id: "a1", organization_id: ORG, interaction_type: "customer_reply_response", model: "m", output: { should_send: true, needs_human: false }, tokens_used: 120, created_at: iso(0) },
    { id: "a2", organization_id: ORG, interaction_type: "lead_followup", model: "m", output: { should_send: true, needs_human: true }, tokens_used: 80, created_at: iso(0) },
    { id: "a3", organization_id: ORG, interaction_type: "customer_reply_response", model: "m", output: { should_send: false }, tokens_used: null, created_at: iso(0) },
    { id: "a4", organization_id: ORG, interaction_type: "lead_followup", model: "m", output: { should_send: true }, tokens_used: 300, created_at: iso(5) },
    { id: "a5", organization_id: OTHER_ORG, interaction_type: "customer_reply_response", model: "m", output: { should_send: true, needs_human: true }, tokens_used: 5000, created_at: iso(0) },
  ],
};

const requests: string[] = [];
let failTables = new Set<string>();

function parseList(value: string): string[] {
  return value.replace(/^\(|\)$/g, "").split(",").map((v) => v.replace(/^"|"$/g, ""));
}

function matches(row: Row, key: string, raw: string): boolean {
  const cell = row[key];
  const [op, ...rest] = raw.split(".");
  const value = rest.join(".");
  if (op === "not") {
    const [innerOp, ...innerRest] = value.split(".");
    return !matches(row, key, `${innerOp}.${innerRest.join(".")}`);
  }
  if (op === "is") return value === "null" ? cell === null || cell === undefined : String(cell) === value;
  if (op === "eq") return String(cell) === value;
  if (op === "neq") return String(cell) !== value;
  if (op === "in") return parseList(value).includes(String(cell));
  if (op === "gte") return String(cell) >= value;
  if (op === "gt") return String(cell) > value;
  if (op === "lt") return String(cell) < value;
  if (op === "lte") return String(cell) <= value;
  throw new Error(`fake PostgREST: unsupported operator ${op} on ${key}`);
}

const server = http.createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const table = url.pathname.replace(/^\/rest\/v1\//, "");
    requests.push(`${req.method} ${table}`);
    if (failTables.has(table)) {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ code: "XX000", message: "injected failure", details: null, hint: null }));
      return;
    }
    let rows = (SEED[table] ?? []).slice();
    for (const [key, value] of url.searchParams.entries()) {
      if (["select", "order", "limit", "offset"].includes(key)) continue;
      rows = rows.filter((row) => matches(row, key, value));
    }
    const limit = Number(url.searchParams.get("limit") ?? "0");
    if (limit > 0) rows = rows.slice(0, limit);
    const headers: Record<string, string> = { "content-type": "application/json", "content-range": `0-${Math.max(rows.length - 1, 0)}/${rows.length}` };
    if (req.method === "HEAD") {
      res.writeHead(200, headers).end();
      return;
    }
    if ((req.headers.accept ?? "").includes("application/vnd.pgrst.object+json")) {
      if (rows.length !== 1) {
        res.writeHead(406, { "content-type": "application/json" }).end(JSON.stringify({ code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: `The result contains ${rows.length} rows`, hint: null }));
        return;
      }
      res.writeHead(200, { ...headers, "content-type": "application/vnd.pgrst.object+json" }).end(JSON.stringify(rows[0]));
      return;
    }
    res.writeHead(200, headers).end(JSON.stringify(rows));
  });
});

let supabase: SupabaseClient;
let getBusinessMetricsSnapshot: typeof import("@/lib/bi/metrics").getBusinessMetricsSnapshot;
let getDashboardBusinessMetrics: typeof import("./business-metrics").getDashboardBusinessMetrics;
let getDashboardPipelineValue: typeof import("./business-metrics").getDashboardPipelineValue;
let getDashboardAiHandled: typeof import("./business-metrics").getDashboardAiHandled;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  supabase = createClient(`http://127.0.0.1:${port}`, "fake-anon-key-for-local-test-only", { auth: { persistSession: false, autoRefreshToken: false } });
  ({ getBusinessMetricsSnapshot } = require(path.join(process.cwd(), "lib/bi/metrics.ts")));
  ({ getDashboardBusinessMetrics, getDashboardPipelineValue, getDashboardAiHandled } = require(path.join(process.cwd(), "lib/dashboard/business-metrics.ts")));
});

after(() => server.close());

beforeEach(() => {
  requests.length = 0;
  failTables = new Set();
});

// The old path, exactly as app/(app)/today/page.tsx used it before Phase 2A-1.
async function oldDashboardPath() {
  const [businessMetrics, todaySnapshot] = await Promise.all([getDashboardBusinessMetrics(supabase, ORG), getBusinessMetricsSnapshot(supabase, ORG, "today")]);
  return { pipelineValue: businessMetrics.pipelineMetrics.pipelineValue, aiMetrics: todaySnapshot.aiMetrics, businessMetricsPartial: businessMetrics.partialData, todaySnapshotPartial: todaySnapshot.partialData };
}

async function newDashboardPath() {
  const [pipeline, aiHandled] = await Promise.all([getDashboardPipelineValue(supabase, ORG), getDashboardAiHandled(supabase, ORG)]);
  return { pipeline, aiHandled };
}

test("pipeline value parity: identical to the old last-30-days snapshot's pipelineMetrics.pipelineValue (every open lead, any age, this organization only)", async () => {
  const before = await oldDashboardPath();
  const after = await newDashboardPath();
  assert.equal(after.pipeline.pipelineValue, before.pipelineValue);
  assert.equal(after.pipeline.pipelineValue, 1200 + 3400.5 + 800, "open statuses only; null values count as 0; won/lost and the other organization excluded");
  assert.equal(after.pipeline.failed, false);
});

test("AI handled parity: identical to the old today snapshot's aiMetrics - today's interactions only, this organization only", async () => {
  const before = await oldDashboardPath();
  const after = await newDashboardPath();
  assert.deepEqual(after.aiHandled.aiMetrics, before.aiMetrics);
  assert.equal(after.aiHandled.aiMetrics.aiInteractions, 3, "the 5-days-ago interaction and the other organization's are excluded");
  assert.equal(after.aiHandled.aiMetrics.aiOutboundInteractions, 2);
  assert.equal(after.aiHandled.aiMetrics.aiNeedsHumanCount, 1);
  assert.equal(after.aiHandled.aiMetrics.customerReplyAiInteractions, 2);
  assert.equal(after.aiHandled.aiMetrics.totalTokensUsed, 200);
  assert.equal(after.aiHandled.failed, false);
});

test("partial-data parity: a failed leads read or a failed AI read raises the Dashboard notice exactly as before", async () => {
  failTables = new Set(["leads"]);
  assert.equal((await oldDashboardPath()).businessMetricsPartial, true);
  assert.equal((await newDashboardPath()).pipeline.failed, true);

  failTables = new Set(["ai_interactions"]);
  const oldAi = await oldDashboardPath();
  assert.equal(oldAi.businessMetricsPartial, true, "before: the last-30-days snapshot's own AI read failure raised the notice");
  assert.equal((await newDashboardPath()).aiHandled.failed, true, "after: the AI read behind the panel raises it");
});

test("partial-data: failures in BI reads the Dashboard never displays no longer raise the notice (the one intended semantic narrowing)", async () => {
  // Estimates/jobs/appointments/billing BI reads fed figures the Dashboard
  // never rendered from the snapshot (its Money cards read the ledger and
  // estimates/jobs themselves and disclose their own failures).
  for (const table of ["estimates", "jobs", "appointments", "invoices"]) {
    failTables = new Set([table]);
    const oldPath = await oldDashboardPath();
    const newPath = await newDashboardPath();
    assert.equal(oldPath.businessMetricsPartial, true, `${table}: raised the old notice`);
    assert.equal(newPath.pipeline.failed || newPath.aiHandled.failed, false, `${table}: not a read behind any figure the new path shows`);
    assert.equal(newPath.pipeline.pipelineValue, oldPath.pipelineValue, `${table}: the shown values are unaffected either way`);
  }
});

test("query reduction: the new path issues 5 queries where the two snapshots issued dozens", async () => {
  await oldDashboardPath();
  const oldCount = requests.length;
  requests.length = 0;
  await newDashboardPath();
  assert.deepEqual(requests.slice().sort(), ["GET ai_interactions", "GET ai_interactions", "GET ai_interactions", "GET leads", "GET leads"]);
  assert.ok(oldCount >= 50, `the old path issued ${oldCount} queries`);
});

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/.*$/gm, "");

test("regression guard: /today never calls the full BI snapshot path again", () => {
  const page = read("app/(app)/today/page.tsx");
  assert.doesNotMatch(page, /getBusinessMetricsSnapshot|getDashboardBusinessMetrics|@\/lib\/bi\/metrics/, "the Dashboard must not build whole BI snapshots");
  // Phase 2D: the pipeline value now comes from dashboard_summary (same
  // definition, proved at cent precision by supabase/pending/scratch/
  // validate-dashboard-sql.mjs); a failed summary is disclosed as the
  // pipeline read's failure was.
  assert.doesNotMatch(page, /getDashboardPipelineValue/);
  assert.match(page, /getDashboardSummary\(supabase, membership\.organizationId\)/);
  assert.match(page, /getDashboardAiHandled\(supabase, membership\.organizationId\)/);
  // Trackpr 2.0 (step 2E): the pipeline value now opens the "Where the work
  // stands" flow, and today's AI metrics feed "Trackpr handled today".
  assert.match(page, /openLeads: formatCurrency\(summary\.data\.pipeline_value\)/);
  assert.match(page, /handledItems\(aiHandled\.aiMetrics\)/);
  assert.match(page, /data\.partialData \|\| summary\.failed \|\| aiHandled\.failed \|\| dailyBriefing\.partialData \|\| endOfDaySummary\.partialData \|\| moneyDataFailed/);
});

test("the narrow loaders use the snapshot's own helpers and ranges - no redefinition", () => {
  const loaders = read("lib/dashboard/business-metrics.ts");
  assert.match(loaders, /getLeadAndPipelineMetrics\(supabase, organizationId, resolveDateRange\(DASHBOARD_DEFAULT_RANGE\)\)/);
  assert.match(loaders, /buildAiMetrics\(supabase, organizationId, resolveDateRange\("today"\)\)/);
  assert.match(loaders, /export const DASHBOARD_DEFAULT_RANGE = "last30Days" as const;/);
  const metrics = read("lib/bi/metrics.ts");
  assert.match(metrics, /buildLeadMetrics\(supabase, organizationId, range\)/, "the snapshot still derives pipeline from buildLeadMetrics -> getLeadAndPipelineMetrics");
  assert.match(metrics, /pipelineValue: pipeline\.pipelineValue,/);
  assert.match(metrics, /buildAiMetrics\(supabase, organizationId, range\)/);
});

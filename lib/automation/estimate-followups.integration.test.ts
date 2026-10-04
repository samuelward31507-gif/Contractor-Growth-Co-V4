/**
 * K5: processEstimateFollowups against real rows on the TEST project
 * configured in .env.local - through the TEST-ONLY organization scope, so
 * only the disposable organizations here are processed (never the permanent
 * QA organization or any other TEST data), and through the existing sendSmsFn
 * seam, so no real SMS is ever sent. Every row is deleted in after().
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/estimate-followups.integration.test.ts
 */
import { test, before, after } from "node:test";
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
if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("lwofqffxagxiqodqvcfr")) throw new Error("K5 integration runs against the TEST project only.");

const { createServiceRoleClient }: typeof import("@/lib/supabase/service") = require(path.join(REPO_ROOT, "lib/supabase/service.ts"));
const { processEstimateFollowups }: typeof import("./estimate-followups") = require(path.join(REPO_ROOT, "lib/automation/estimate-followups.ts"));

const service = createServiceRoleClient();
const H = 3600_000;
const ago = (hours: number) => new Date(Date.now() - hours * H).toISOString();
const sent: string[] = [];
const fakeSend = async (input: { body: string }) => (sent.push(input.body), { ok: true as const, providerMessageId: `FAKE-K5-${Date.now()}-${Math.random()}` });

const orgs: string[] = [];
let disabledOrg = "";
let enabledOrg = "";
const ids: Record<string, string> = {};

async function insert(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await service.from(table).insert(row).select("id").single();
  assert.ifError(error);
  return data!.id as string;
}

async function org(name: string) {
  const id = await insert("organizations", { name, automation_mode: "live", payment_status: "active", timezone: "UTC" });
  orgs.push(id);
  return id;
}

async function estimateFor(orgId: string, key: string, phone: string, extra: Record<string, unknown>) {
  const contactId = await insert("contacts", { organization_id: orgId, first_name: "K5", last_name: key, phone, sms_opt_out: false });
  ids[key] = await insert("estimates", { organization_id: orgId, contact_id: contactId, title: `K5 ${key}`, status: "sent", amount: 900, ...extra });
}

const QA_ORG = "8da35b67-4460-4550-b386-682abee48665";
let qaEventsBefore = 0;
let qaEstimatesBefore = "";
const qaState = async () => {
  const { count } = await service.from("automation_events").select("id", { count: "exact", head: true }).eq("organization_id", QA_ORG);
  const { data } = await service.from("estimates").select("id, status").eq("organization_id", QA_ORG).order("id");
  return { events: count ?? 0, estimates: JSON.stringify(data) };
};

before(async () => {
  ({ events: qaEventsBefore, estimates: qaEstimatesBefore } = await qaState());
  disabledOrg = await org("K5 Estimate Followup Test Org (disabled)");
  await insert("automation_settings", { organization_id: disabledOrg, automation_id: "estimate-followup", enabled: false, config: {} });
  await estimateFor(disabledOrg, "D-expired", "+15555635001", { sent_at: ago(500), expires_at: ago(2) });
  await estimateFor(disabledOrg, "D-due", "+15555635002", { sent_at: ago(30) });

  enabledOrg = await org("K5 Estimate Followup Test Org (enabled)");
  await estimateFor(enabledOrg, "E-due", "+15555635003", { sent_at: ago(30) });
  await estimateFor(enabledOrg, "E-starved", "+15555635004", { sent_at: ago(24 * 30) });
  await estimateFor(enabledOrg, "E-new", "+15555635005", { sent_at: ago(1) });
});

after(async () => {
  for (const orgId of orgs) {
    for (const table of ["messages", "conversations", "workflow_executions", "automation_events", "sms_cost_events", "estimates", "automation_settings", "contacts"]) await service.from(table).delete().eq("organization_id", orgId);
    await service.from("organizations").delete().eq("id", orgId);
  }
});

const statusOf = async (key: string) => (await service.from("estimates").select("status").eq("id", ids[key]).single()).data!.status as string;

test("1. (K5-2) automation disabled: the past-expiry estimate expires with no message; the due follow-up is not sent", async () => {
  const result = await processEstimateFollowups(service, new Date(), fakeSend, "event", { organizationId: disabledOrg });
  const byId = Object.fromEntries(result.outcomes.map((o) => [o.estimateId, o.outcome]));
  assert.deepEqual([byId[ids["D-expired"]], byId[ids["D-due"]], result.candidates], ["expired", "skipped_disabled", 2]);
  assert.equal(await statusOf("D-expired"), "expired");
  assert.equal(await statusOf("D-due"), "sent");
  const { count } = await service.from("messages").select("id", { count: "exact", head: true }).eq("organization_id", disabledOrg);
  assert.equal(count, 0);
});

test("2. (K5-1, K5-3) automation enabled: the due follow-up sends through the real gate (fake SMS); the starved one is recorded as overdue, not sent; the new one is not due; a second run sends nothing", async () => {
  const result = await processEstimateFollowups(service, new Date(), fakeSend, "event", { organizationId: enabledOrg });
  const byId = Object.fromEntries(result.outcomes.map((o) => [o.estimateId, o.outcome === "blocked" ? `blocked:${o.reason}` : o.outcome]));
  assert.deepEqual([byId[ids["E-due"]], byId[ids["E-starved"]], byId[ids["E-new"]]], ["sent", "blocked:followup_overdue", "not_due"]);
  assert.equal(sent.length, 1, "exactly one (fake) SMS");
  const { data: events } = await service.from("automation_events").select("idempotency_key").eq("organization_id", enabledOrg).order("idempotency_key");
  assert.deepEqual(events!.map((e) => e.idempotency_key).sort(), [`estimate.followup:${ids["E-due"]}:1`, `estimate.followup:${ids["E-starved"]}:2`].sort());

  const again = await processEstimateFollowups(service, new Date(), fakeSend, "event", { organizationId: enabledOrg });
  assert.deepEqual(again.outcomes.filter((o) => o.outcome !== "not_due").map((o) => o.outcome).sort(), ["skipped_duplicate", "skipped_duplicate"]);
  assert.equal(sent.length, 1, "no second send, and the overdue one never sends");
});

test("3. (K5-4) the permanent QA organization was never processed - no new events, no estimate status changes", async () => {
  const now = await qaState();
  assert.equal(now.events, qaEventsBefore);
  assert.equal(now.estimates, qaEstimatesBefore);
});

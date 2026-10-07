/**
 * Final Batch 3: estimate send truthfulness and the accepted-estimate ->
 * job next action.
 *
 * Runs the REAL sendEstimate / createJobFromAcceptedEstimate server actions,
 * the REAL describeEstimateDelivery / getEstimateDeliveryState and the REAL
 * getJobByEstimateId against an in-memory store. The customer-text delivery
 * (deliverEstimateToCustomer, covered by lib/automation/estimate-delivery.test.ts)
 * and the job insert (emitJobCreatedFromEstimate) are mocked to return each
 * outcome. Nothing reaches TEST, Production, Twilio or n8n.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test "app/(app)/estimates/actions.batch3.test.ts"
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;

type Row = Record<string, unknown>;
const ORG = "org-1";
const OTHER_ORG = "org-2";
let store: Record<string, Row[]> = {};
let ids = 0;
let delivery: unknown = { status: "sent", messageId: "m1" };
let jobInsertWorks = true;
const calls = { deliver: 0, emitJob: 0, emitSent: 0 };

class Query {
  private filters: ((row: Row) => boolean)[] = [];
  private patch: Row | null = null;
  private sort: { column: string; ascending: boolean } | null = null;
  private max: number | null = null;
  private table: string;
  constructor(table: string) {
    this.table = table;
  }
  select() { return this; }
  eq(column: string, value: unknown) { this.filters.push((row) => row[column] === value); return this; }
  update(values: Row) { this.patch = values; return this; }
  order(column: string, options?: { ascending?: boolean }) { this.sort = { column, ascending: options?.ascending !== false }; return this; }
  limit(n: number) { this.max = n; return this; }
  maybeSingle() { return this.run(); }
  single() { return this.run(); }
  private async run(): Promise<{ data: unknown; error: unknown }> {
    let rows = (store[this.table] ?? []).filter((row) => this.filters.every((f) => f(row)));
    if (this.patch) for (const row of rows) Object.assign(row, this.patch);
    if (this.sort) {
      const { column, ascending } = this.sort;
      rows = [...rows].sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : 1) * (ascending ? 1 : -1));
    }
    if (this.max !== null) rows = rows.slice(0, this.max);
    return { data: rows[0] ? { ...rows[0] } : null, error: null };
  }
}
const db = { from: (table: string) => new Query(table), auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) } };

mock.module(lib("lib/supabase/server.ts"), { namedExports: { createClient: async () => db } });
mock.module(lib("lib/auth/organization.ts"), { namedExports: { getUserOrganization: async () => ({ organizationId: ORG, role: "owner" }) } });
mock.module("next/cache", { namedExports: { revalidatePath: () => undefined } });
mock.module("next/headers", { namedExports: { headers: async () => new Headers({ host: "preview.example" }) } });
mock.module("next/navigation", { namedExports: { redirect: (to: string) => { throw new Error(`redirect:${to}`); } } });
mock.module(lib("lib/automation/estimates.ts"), {
  namedExports: {
    emitEstimateSent: async () => { calls.emitSent += 1; },
    emitEstimateLifecycleEvent: async () => undefined,
  },
});
const realDelivery = await import(lib("lib/automation/estimate-delivery.ts"));
mock.module(lib("lib/automation/estimate-delivery.ts"), {
  namedExports: {
    ...realDelivery,
    deliverEstimateToCustomer: async () => {
      calls.deliver += 1;
      return delivery;
    },
  },
});
mock.module(lib("lib/automation/jobs.ts"), {
  namedExports: {
    emitJobCreatedFromEstimate: async (_s: unknown, organizationId: string, estimateId: string) => {
      calls.emitJob += 1;
      if (!jobInsertWorks) return; // the existing path never throws - it logs and returns
      const estimate = store.estimates!.find((row) => row.id === estimateId)!;
      store.jobs!.push({ id: `job-${++ids}`, organization_id: organizationId, contact_id: estimate.contact_id, lead_id: estimate.lead_id, estimate_id: estimateId, title: estimate.title, status: "scheduled" });
    },
  },
});

const { sendEstimate, createJobFromAcceptedEstimate } = await import(lib("app/(app)/estimates/actions.ts"));
const { describeEstimateDelivery, getEstimateDeliveryState, describeEstimateDeliveryState } = realDelivery;

beforeEach(() => {
  ids = 0;
  delivery = { status: "sent", messageId: "m1" };
  jobInsertWorks = true;
  calls.deliver = 0;
  calls.emitJob = 0;
  calls.emitSent = 0;
  store = {
    estimates: [
      { id: "E-draft", organization_id: ORG, contact_id: "C1", lead_id: "L1", title: "Roof", status: "draft", sent_at: null },
      { id: "E-accepted", organization_id: ORG, contact_id: "C1", lead_id: "L1", title: "Deck", status: "accepted" },
      { id: "E-sent", organization_id: ORG, contact_id: "C1", lead_id: "L1", title: "Fence", status: "sent" },
      { id: "E-foreign", organization_id: OTHER_ORG, contact_id: "C9", lead_id: null, title: "Other", status: "accepted" },
    ],
    jobs: [],
    automation_events: [],
    workflow_executions: [],
  };
});

// --------------------------------------------------------------- sending

test("successful provider send -> success, and only then: 'Estimate sent and texted to the customer.'", async () => {
  const result = await sendEstimate("E-draft");
  assert.deepEqual(result, { ok: true, id: "E-draft", delivery: { texted: true, message: "Estimate sent and texted to the customer." } });
  assert.equal(calls.deliver, 1);
});

test("provider failure -> reported as NOT texted (no false 'sent'), the estimate's own status is still recorded", async () => {
  delivery = { status: "send_failed", error: "The SMS provider rejected the request." };
  const result = await sendEstimate("E-draft");
  assert.equal(result.ok, true);
  assert.deepEqual((result as { delivery: unknown }).delivery, { texted: false, message: "Estimate marked as sent, but the customer was NOT texted: the text failed to send. Share the approval link yourself." });
  assert.equal(store.estimates![0].status, "sent", "the approval link is live and shareable");
});

for (const [outcome, why] of [
  [{ status: "blocked", reason: "organization_not_live" }, "Trackpr is in TEST mode"],
  [{ status: "blocked", reason: "contact_opted_out" }, "this customer has opted out of texts (STOP)"],
  [{ status: "blocked", reason: "lead_sms_consent_missing" }, "this customer hasn't agreed to texts"],
  [{ status: "blocked", reason: "something_new" }, "Trackpr's safety checks didn't allow the text"],
  [{ status: "skipped", reason: "no_contact" }, "this estimate has no customer"],
  [{ status: "skipped", reason: "no_link_base" }, "no app address is configured, so the approval link couldn't be built"],
  [{ status: "skipped", reason: "duplicate" }, "a text for this estimate was already attempted"],
  [{ status: "skipped", reason: "error" }, "the text couldn't be sent"],
] as const) {
  test(`delivery ${outcome.status}/${outcome.reason} -> not texted, with the reason`, async () => {
    delivery = outcome;
    const result = (await sendEstimate("E-draft")) as { ok: true; delivery: { texted: boolean; message: string } };
    assert.equal(result.delivery.texted, false);
    assert.equal(result.delivery.message, `Estimate marked as sent, but the customer was NOT texted: ${why}. Share the approval link yourself.`);
  });
}

test("no duplicate success: re-sending an already-sent estimate is refused and never delivers again", async () => {
  await sendEstimate("E-draft");
  const again = await sendEstimate("E-draft");
  assert.deepEqual(again, { ok: false, error: "This estimate could not be found or has already been sent." });
  assert.equal(calls.deliver, 1);
  assert.equal(calls.emitSent, 1);
});

test("only 'sent' is ever reported as texted", () => {
  assert.equal(describeEstimateDelivery({ status: "sent", messageId: null }).texted, true);
  for (const outcome of [{ status: "blocked", reason: "x" }, { status: "send_failed", error: "x" }, { status: "skipped", reason: "duplicate" }] as const) {
    assert.equal(describeEstimateDelivery(outcome as never).texted, false);
  }
});

test("the estimate page's stored 'Customer text' reads the latest delivery execution truthfully", async () => {
  assert.deepEqual(await getEstimateDeliveryState(db as never, ORG, "E-sent"), { state: "not_attempted" });
  store.automation_events!.push({ id: "ev1", organization_id: ORG, event_type: "estimate.delivery", entity_id: "E-sent", created_at: "2026-10-01T00:00:00Z" });
  const execution: Row = { id: "x1", organization_id: ORG, automation_event_id: "ev1", status: "failed", started_at: "2026-10-01T00:00:01Z", metadata: {} };
  store.workflow_executions!.push(execution);
  assert.deepEqual(await getEstimateDeliveryState(db as never, ORG, "E-sent"), { state: "failed" });
  Object.assign(execution, { status: "completed", metadata: { should_send: false, blocked_reason: "organization_not_live" } });
  const blocked = await getEstimateDeliveryState(db as never, ORG, "E-sent");
  assert.deepEqual(blocked, { state: "not_texted", reason: "organization_not_live" });
  assert.equal(describeEstimateDeliveryState(blocked), "Not texted (Trackpr is in TEST mode)");
  Object.assign(execution, { metadata: { should_send: true, blocked_reason: null } });
  assert.equal(describeEstimateDeliveryState(await getEstimateDeliveryState(db as never, ORG, "E-sent")), "Texted to the customer");
  assert.deepEqual(await getEstimateDeliveryState(db as never, OTHER_ORG, "E-sent"), { state: "not_attempted" }, "organization-scoped");
});

// ---------------------------------------------------- accepted estimate -> job

test("accepted estimate with no job -> Create Job runs the existing estimate->job path and returns the new job", async () => {
  const result = await createJobFromAcceptedEstimate("E-accepted");
  assert.equal(result.ok, true);
  assert.equal(calls.emitJob, 1);
  assert.deepEqual(store.jobs!.map((job) => ({ estimate: job.estimate_id, org: job.organization_id })), [{ estimate: "E-accepted", org: ORG }]);
  assert.equal((result as { id: string }).id, store.jobs![0].id);
});

test("never a second job: an existing job for the estimate is returned without creating another", async () => {
  store.jobs!.push({ id: "J-existing", organization_id: ORG, estimate_id: "E-accepted", title: "Deck", status: "scheduled" });
  assert.deepEqual(await createJobFromAcceptedEstimate("E-accepted"), { ok: true, id: "J-existing" });
  assert.equal(calls.emitJob, 0);
});

test("only an accepted estimate can become a job; another organization's estimate is not found", async () => {
  assert.deepEqual(await createJobFromAcceptedEstimate("E-sent"), { ok: false, error: "Only an accepted estimate can become a job." });
  assert.deepEqual(await createJobFromAcceptedEstimate("E-foreign"), { ok: false, error: "This estimate could not be found." });
  assert.equal(calls.emitJob, 0);
  assert.equal(store.jobs!.length, 0);
});

test("a job insert that silently fails is reported as a failure, never as success", async () => {
  jobInsertWorks = false;
  assert.deepEqual(await createJobFromAcceptedEstimate("E-accepted"), { ok: false, error: "We couldn't create the job. Please try again." });
});

test("the estimate page offers Create Job exactly for an accepted estimate with no job", async () => {
  const { readFileSync } = await import("node:fs");
  const actions = readFileSync("app/(app)/estimates/[id]/_components/estimate-actions.tsx", "utf8");
  assert.match(actions, /estimate\.status === "accepted" && !hasJob \?/);
  assert.match(actions, /createJobFromAcceptedEstimate\(estimate\.id\)/);
  const page = readFileSync("app/(app)/estimates/[id]/page.tsx", "utf8");
  assert.match(page, /hasJob=\{Boolean\(job\)\}/);
});

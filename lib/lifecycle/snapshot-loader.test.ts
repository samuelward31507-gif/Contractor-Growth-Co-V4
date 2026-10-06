/**
 * P0-B B1: loadLifecycleSnapshot against a recording fake client - proves it
 * is read-only, scopes every query by organization AND contact, maps rows into
 * the typed snapshot, takes the lifecycle policy from the organization's
 * automation config (with the existing defaults), and reports a failed read
 * instead of an empty snapshot.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/lifecycle/snapshot-loader.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadLifecycleSnapshot } from "./snapshot-loader";
import { deriveLifecycleStage } from "./derive";

type Row = Record<string, unknown>;
const ORG = "org-1";
const CONTACT = "c-1";

function fakeClient(tables: Record<string, Row[]>, failTable: string | null = null) {
  const calls: { table: string; op: string; filters: string[] }[] = [];
  const from = (table: string) => {
    const filters: string[] = [];
    const record = { table, op: "select", filters };
    calls.push(record);
    const predicates: ((r: Row) => boolean)[] = [];
    const builder = {
      select: () => builder,
      eq: (c: string, v: unknown) => (filters.push(`eq ${c}`), predicates.push((r) => r[c] === v), builder),
      in: (c: string, vs: unknown[]) => (filters.push(`in ${c}`), predicates.push((r) => vs.includes(r[c])), builder),
      order: () => builder,
      limit: () => builder,
      insert: () => ((record.op = "insert"), builder),
      update: () => ((record.op = "update"), builder),
      delete: () => ((record.op = "delete"), builder),
      upsert: () => ((record.op = "upsert"), builder),
      maybeSingle: () => run(true),
      then: (resolve: (v: unknown) => unknown) => run(false).then(resolve),
    };
    const run = async (single: boolean) => {
      if (table === failTable) return { data: null, error: { message: `${table} read failed` } };
      const rows = (tables[table] ?? []).filter((r) => predicates.every((p) => p(r)));
      return { data: single ? (rows[0] ?? null) : rows, error: null };
    };
    return builder;
  };
  return { client: { from, rpc: () => assert.fail("no rpc") } as never, calls };
}

const tables = (): Record<string, Row[]> => ({
  contacts: [{ id: CONTACT, organization_id: ORG, sms_opt_out: true }],
  leads: [
    { id: "L1", organization_id: ORG, contact_id: CONTACT, status: "qualified", created_at: "2027-03-01T00:00:00.000Z" },
    { id: "LX", organization_id: ORG, contact_id: "someone-else", status: "won", created_at: "2027-03-01T00:00:00.000Z" },
    { id: "LY", organization_id: "other-org", contact_id: CONTACT, status: "won", created_at: "2027-03-01T00:00:00.000Z" },
  ],
  appointments: [{ id: "A1", organization_id: ORG, contact_id: CONTACT, lead_id: "L1", status: "scheduled", start_at: "2027-03-12T15:00:00.000Z", end_at: "2027-03-12T16:00:00.000Z", created_at: "2027-03-02T00:00:00.000Z" }],
  estimates: [],
  jobs: [{ id: "J1", organization_id: ORG, contact_id: CONTACT, lead_id: null, estimate_id: null, status: "completed", created_at: "2026-12-01T00:00:00.000Z", completed_at: "2026-12-02T00:00:00.000Z" }],
  invoices: [{ id: "I1", organization_id: ORG, contact_id: CONTACT, job_id: "J1", status: "paid", due_date: null }],
  review_requests: [{ id: "R1", organization_id: ORG, contact_id: null, job_id: "J1", status: "requested", requested_at: "2026-12-03T00:00:00.000Z" }],
  referral_requests: [],
  conversations: [{ id: "V1", organization_id: ORG, contact_id: CONTACT }],
  messages: [{ organization_id: ORG, conversation_id: "V1", direction: "outbound", status: "delivered", created_at: "2027-03-02T00:00:00.000Z" }],
  opportunities: [{ organization_id: ORG, contact_id: CONTACT, status: "open", type: "qualified_lead_unbooked" }],
  automation_settings: [{ organization_id: ORG, automation_id: "customer-reactivation", config: { inactivity_days: 90 } }],
});

test("loads a typed snapshot scoped to the organization AND contact, read-only", async () => {
  const { client, calls } = fakeClient(tables());
  const asOf = new Date("2027-03-10T15:00:00.000Z");
  const result = await loadLifecycleSnapshot(client, ORG, CONTACT, { asOf });
  assert.equal(result.failed, false);
  const snapshot = result.snapshot!;
  assert.equal(snapshot.asOf, asOf.toISOString());
  assert.equal(snapshot.smsOptOut, true);
  assert.deepEqual(snapshot.leads, [{ id: "L1", status: "qualified", createdAt: "2027-03-01T00:00:00.000Z" }], "other contacts' and other organizations' rows never leak in");
  assert.deepEqual(snapshot.appointments, [{ id: "A1", leadId: "L1", status: "scheduled", startAt: "2027-03-12T15:00:00.000Z", endAt: "2027-03-12T16:00:00.000Z", createdAt: "2027-03-02T00:00:00.000Z" }]);
  assert.deepEqual(snapshot.reviewRequests, [{ id: "R1", jobId: "J1", status: "requested", requestedAt: "2026-12-03T00:00:00.000Z" }], "requests are found by the contact's jobs (their own contact_id may be null)");
  assert.deepEqual(snapshot.messages, [{ direction: "outbound", status: "delivered", createdAt: "2027-03-02T00:00:00.000Z" }]);
  assert.deepEqual(snapshot.openOpportunityTypes, ["qualified_lead_unbooked"]);
  assert.deepEqual(snapshot.policy, { dormancyDays: 90, estimateFollowupHours: 24, invoicingLiveAt: "2026-09-28T16:25:00.000Z" }, "org config overrides; the estimate default applies when unset");

  assert.ok(calls.every((call) => call.op === "select"), "never writes");
  for (const call of calls.filter((c) => !["automation_settings", "messages", "review_requests", "referral_requests"].includes(c.table))) {
    assert.ok(call.filters.includes("eq organization_id"), `${call.table} scoped by organization`);
    assert.ok(call.filters.includes("eq contact_id") || call.filters.includes("eq id"), `${call.table} scoped by contact`);
  }
  for (const call of calls.filter((c) => ["messages", "review_requests", "referral_requests"].includes(c.table))) assert.ok(call.filters.includes("eq organization_id"), `${call.table} scoped by organization`);

  // The loaded snapshot derives like any other.
  assert.equal(deriveLifecycleStage(snapshot).stage, "booked");
});

test("a failed read is reported - never an empty (and therefore wrong) snapshot", async () => {
  for (const table of ["leads", "jobs", "messages", "review_requests"]) {
    const { client } = fakeClient(tables(), table);
    const result = await loadLifecycleSnapshot(client, ORG, CONTACT);
    assert.equal(result.failed, true, table);
    assert.equal(result.snapshot, null);
  }
});

test("an unknown contact (or another organization's) is contact_not_found", async () => {
  const { client } = fakeClient(tables());
  const result = await loadLifecycleSnapshot(client, "other-org", CONTACT);
  assert.deepEqual(result, { snapshot: null, failed: true, error: "contact_not_found" });
});

test("defaults: no automation config -> dormancy 180 days, estimate follow-up 24 hours", async () => {
  const t = tables();
  t.automation_settings = [];
  const { client } = fakeClient(t);
  const result = await loadLifecycleSnapshot(client, ORG, CONTACT);
  assert.equal(result.snapshot!.policy.dormancyDays, 180);
  assert.equal(result.snapshot!.policy.estimateFollowupHours, 24);
});

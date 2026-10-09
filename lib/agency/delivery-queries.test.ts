/**
 * Agency delivery reads (lib/agency/delivery-queries.ts): the admin check
 * runs before any read; nothing is read for a linked account unless it is
 * confirmed Agency-managed; a failed read is "unavailable", never "healthy"
 * or "none"; the link picker offers only Agency-managed accounts not
 * already linked.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test lib/agency/delivery-queries.test.ts
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;
let admin = true;
let reads: string[] = [];
let healthCalls: string[] = [];
let healthResult: unknown = { status: "healthy", incidentsUnavailable: false };
let checklistThrows = false;
type Result = { data: unknown; error: unknown };
let tables: Record<string, Result> = {};

/** A chainable stand-in for a Supabase query: every filter returns itself; awaiting or maybeSingle yields the table's result. */
function client(label: string) {
  return {
    label,
    from(table: string) {
      reads.push(`${label}:${table}`);
      const r = tables[`${label}:${table}`] ?? { data: [], error: null };
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "limit", "not", "in"]) q[m] = () => q;
      q.maybeSingle = async () => r;
      q.then = (resolve: (v: Result) => unknown) => resolve(r);
      return q;
    },
    rpc: async (name: string) => (reads.push(`${label}:rpc:${name}`), tables[`${label}:rpc:${name}`] ?? { data: [], error: null }),
  };
}
const session = client("session");
const service = client("service");

mock.module(lib("lib/agency/queries.ts"), { namedExports: { isAgencyAdmin: async (c: unknown) => c === session && admin } });
mock.module(lib("lib/automation-health/health.ts"), { namedExports: { getOrganizationHealth: async (_c: unknown, id: string) => (healthCalls.push(id), healthResult) } });
mock.module(lib("lib/automation-health/queries.ts"), { namedExports: { listIncidents: async () => [] } });
mock.module(lib("lib/onboarding/checklist.ts"), {
  namedExports: {
    computeSetupChecklist: async () => {
      if (checklistThrows) throw new Error("boom");
      return { items: [] };
    },
  },
});
const q = await import(lib("lib/agency/delivery-queries.ts"));

beforeEach(() => {
  admin = true;
  reads = [];
  healthCalls = [];
  healthResult = { status: "healthy", incidentsUnavailable: false };
  checklistThrows = false;
  tables = {};
});

test("a non-admin gets 'not_agency_admin' with no table read", async () => {
  admin = false;
  assert.deepEqual(await q.getDeliveryOverview(session), { ok: false, reason: "not_agency_admin" });
  assert.deepEqual(await q.getDeliveryClient(session, "c1"), { ok: false, reason: "not_agency_admin" });
  assert.deepEqual(reads, []);
});

test("overview and detail read only with the session client; missing schema is 'not enabled', other errors are load failures", async () => {
  await q.getDeliveryOverview(session);
  await q.getDeliveryClient(session, "c1");
  assert.ok(reads.length > 0 && reads.every((r) => r.startsWith("session:")), reads.join(","));
  tables["session:agency_client_tasks"] = { data: null, error: { code: "42P01", message: "relation agency_client_tasks does not exist" } };
  assert.deepEqual(await q.getDeliveryOverview(session), { ok: true, available: false, clients: [], tasks: [] });
  tables["session:agency_client_tasks"] = { data: null, error: { code: "57014", message: "timeout" } };
  assert.deepEqual(await q.getDeliveryOverview(session), { ok: false, reason: "load_failed" });
  tables["session:agency_client_tasks"] = { data: [], error: null };
  tables["session:agency_clients"] = { data: null, error: null };
  assert.deepEqual(await q.getDeliveryClient(session, "c1"), { ok: false, reason: "not_found" });
});

test("signals: not linked reads nothing; unmanaged or unreadable link reads nothing more", async () => {
  assert.deepEqual(await q.getLinkedSignals(service, null), { signals: { kind: "not_linked" }, incidents: null });
  assert.deepEqual(reads, []);
  tables["service:agency_organizations"] = { data: null, error: null };
  assert.deepEqual((await q.getLinkedSignals(service, "o1")).signals, { kind: "not_managed", organizationId: "o1" });
  tables["service:agency_organizations"] = { data: null, error: { code: "57014" } };
  assert.deepEqual((await q.getLinkedSignals(service, "o1")).signals, { kind: "unavailable", organizationId: "o1" });
  assert.deepEqual(reads, ["service:agency_organizations", "service:agency_organizations"], "no organizations/health read for an unconfirmed account");
  assert.deepEqual(healthCalls, []);
});

test("signals: a managed link reads health, checklist, incidents and payment/pause; any failed piece is null, never assumed", async () => {
  tables["service:agency_organizations"] = { data: { organization_id: "o1", organizations: { name: "Acme TP" } }, error: null };
  tables["service:organizations"] = { data: { payment_status: "active", automation_paused: true }, error: null };
  const ok = await q.getLinkedSignals(service, "o1");
  assert.deepEqual(ok.signals, { kind: "linked", organizationId: "o1", organizationName: "Acme TP", health: healthResult, checklist: { items: [] }, paymentStatus: "active", paused: true });
  assert.deepEqual(ok.incidents, []);
  assert.deepEqual(healthCalls, ["o1"]);

  checklistThrows = true;
  healthResult = { status: "healthy", incidentsUnavailable: true };
  tables["service:organizations"] = { data: null, error: { code: "57014" } };
  const partial = await q.getLinkedSignals(service, "o1");
  const s = partial.signals as { checklist: unknown; paymentStatus: unknown; paused: unknown };
  assert.deepEqual([s.checklist, s.paymentStatus, s.paused], [null, null, null]);
  assert.equal(partial.incidents, null, "an empty incident list isn't 'none' when health couldn't read incidents");
});

test("link picker: only Agency-managed accounts, minus those already linked; a failed read offers none", async () => {
  tables["service:agency_organizations"] = {
    data: [
      { organization_id: "o1", organizations: { name: "One" } },
      { organization_id: "o2", organizations: [{ name: "Two" }] },
    ],
    error: null,
  };
  tables["session:agency_clients"] = { data: [{ organization_id: "o1" }], error: null };
  assert.deepEqual(await q.getLinkableOrganizations(session, service), { ok: true, organizations: [{ organizationId: "o2", organizationName: "Two" }] });
  tables["session:agency_clients"] = { data: null, error: { code: "57014" } };
  assert.deepEqual(await q.getLinkableOrganizations(session, service), { ok: false });
});

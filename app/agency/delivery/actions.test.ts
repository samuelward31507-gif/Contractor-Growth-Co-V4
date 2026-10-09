/**
 * Agency delivery actions (app/agency/delivery/actions.ts): input is
 * validated first; the agency-admin check runs on the caller's own session
 * before any database call; every write goes through the session client's
 * database function; launch evidence is computed on the server from fresh
 * reads (the browser sends only the acknowledgement and request id);
 * refusals read clearly without leaking internals. The database rules
 * themselves are proven by supabase/pending/scratch/validate-agency-client-delivery.mjs.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test app/agency/delivery/actions.test.ts
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;
const C = "11111111-1111-4111-8111-111111111111";
const T = "22222222-2222-4222-8222-222222222222";
const R = "33333333-3333-4333-8333-333333333333";
const O = "44444444-4444-4444-8444-444444444444";
const V = "2026-10-09T18:00:00.123456+00:00";

let admin = true;
let calls: { name: string; args: Record<string, unknown> }[] = [];
let response: { data: unknown; error: unknown } = { data: { status: "recorded" }, error: null };
let detail: unknown;
let signals: unknown = { kind: "not_linked" };
let signalCalls: unknown[] = [];
const session = { rpc: async (name: string, args: Record<string, unknown>) => (calls.push({ name, args }), response) };
const service = { service: true };

mock.module(lib("lib/supabase/server.ts"), { namedExports: { createClient: async () => session } });
mock.module(lib("lib/supabase/service.ts"), { namedExports: { createServiceRoleClient: () => service } });
mock.module(lib("lib/agency/queries.ts"), { namedExports: { isAgencyAdmin: async (client: unknown) => client === session && admin } });
mock.module(lib("lib/agency/delivery-queries.ts"), {
  namedExports: {
    getDeliveryClient: async (client: unknown, id: string) => (client === session && id === C ? detail : { ok: false, reason: "not_found" }),
    getLinkedSignals: async (client: unknown, orgId: string | null) => (signalCalls.push([client, orgId]), { signals, incidents: null }),
  },
});
mock.module("next/cache", { namedExports: { revalidatePath: () => undefined } });
const actions = await import(lib("app/agency/delivery/actions.ts"));

const doneTask = (key: string | null, o: Record<string, unknown> = {}) => ({
  id: `t-${key}`,
  clientId: C,
  templateKey: key,
  module: "core",
  category: "testing",
  title: key ?? "custom",
  description: null,
  required: true,
  waitingOn: "agency",
  status: "done",
  blockedReason: null,
  wontDoReason: null,
  ownerUserId: null,
  dueDate: null,
  sortOrder: 1,
  completedAt: V,
  completedBy: "u",
  updatedAt: V,
  ...o,
});
const readyDetail = (tasks = [doneTask("core.end_to_end_test"), doneTask("core.client_acceptance")], o: Record<string, unknown> = {}) => ({
  ok: true,
  available: true,
  detail: {
    client: { id: C, name: "Acme", status: "ready_to_launch", services: ["sms"], organizationId: null, updatedAt: V, ...o },
    tasks,
    events: [],
    launch: null,
    admins: [],
  },
});
const rpcCall = (i: number) => calls[i];

beforeEach(() => {
  admin = true;
  calls = [];
  signalCalls = [];
  response = { data: { status: "recorded" }, error: null };
  detail = readyDetail();
  signals = { kind: "not_linked" };
});

test("a non-admin is refused before any database call or read", async () => {
  admin = false;
  const refused = { ok: false, error: "Not authorized." };
  assert.deepEqual(await actions.startOnboarding(C, { expectedUpdatedAt: V, services: ["sms"] }), refused);
  assert.deepEqual(await actions.addServices(C, { expectedUpdatedAt: V, services: ["crm"] }), refused);
  assert.deepEqual(await actions.addTask(C, { requestId: R, title: "Do it" }), refused);
  assert.deepEqual(await actions.setTaskStatus(C, T, { expectedUpdatedAt: V, status: "done" }), refused);
  assert.deepEqual(await actions.setTaskDetails(C, T, { expectedUpdatedAt: V }), refused);
  assert.deepEqual(await actions.setClientDetails(C, { expectedUpdatedAt: V }), refused);
  assert.deepEqual(await actions.markReadyToLaunch(C, { expectedUpdatedAt: V }), refused);
  assert.deepEqual(await actions.moveToOngoing(C, { expectedUpdatedAt: V }), refused);
  assert.deepEqual(await actions.linkOrganization(C, { expectedUpdatedAt: V, organizationId: O }), refused);
  assert.deepEqual(await actions.approveLaunch(C, { requestId: R, expectedUpdatedAt: V, acknowledgement: "Checked by hand on site." }), refused);
  assert.deepEqual(calls, []);
  assert.deepEqual(signalCalls, [], "no service-role read for a non-admin");
});

test("input is validated before the admin check and the database", async () => {
  const bad = [
    await actions.startOnboarding("nope", { expectedUpdatedAt: V, services: ["sms"] }),
    await actions.startOnboarding(C, { expectedUpdatedAt: "yesterday-ish", services: ["sms"] }),
    await actions.startOnboarding(C, { expectedUpdatedAt: V, services: [] }),
    await actions.startOnboarding(C, { expectedUpdatedAt: V, services: ["sms", "free_money"] }),
    await actions.startOnboarding(C, { expectedUpdatedAt: V, services: ["sms"], ownerUserId: "bob" }),
    await actions.startOnboarding(C, { expectedUpdatedAt: V, services: ["sms"], targetLaunchDate: "2026-02-31" }),
    await actions.addServices(C, { expectedUpdatedAt: V, services: [] }),
    await actions.addTask(C, { requestId: "x", title: "Do it" }),
    await actions.addTask(C, { requestId: R, title: "  " }),
    await actions.setTaskStatus(C, "nope", { expectedUpdatedAt: V, status: "done" }),
    await actions.setTaskStatus(C, T, { expectedUpdatedAt: V, status: "deleted" }),
    await actions.setTaskStatus(C, T, { expectedUpdatedAt: V, status: "blocked", reason: " " }),
    await actions.setTaskStatus(C, T, { expectedUpdatedAt: V, status: "wont_do", reason: "x".repeat(501) }),
    await actions.setTaskDetails(C, T, { expectedUpdatedAt: V, dueDate: "soon" }),
    await actions.setClientDetails(C, { expectedUpdatedAt: V, ownerUserId: "x" }),
    await actions.markReadyToLaunch(C, { expectedUpdatedAt: null }),
    await actions.linkOrganization(C, { expectedUpdatedAt: V, organizationId: "acme" }),
    await actions.approveLaunch(C, { requestId: "x", expectedUpdatedAt: V }),
    await actions.approveLaunch(C, { requestId: R, expectedUpdatedAt: V, acknowledgement: "x".repeat(1001) }),
  ];
  for (const [i, r] of bad.entries()) assert.equal(r.ok, false, `case ${i}`);
  assert.deepEqual(calls, []);
});

test("writes call exactly one database function with the session client and the expected version", async () => {
  await actions.startOnboarding(C, { expectedUpdatedAt: V, services: ["sms", "crm", "sms"], ownerUserId: R, targetLaunchDate: "2026-11-01" });
  await actions.addServices(C, { expectedUpdatedAt: V, services: ["reporting"] });
  await actions.addTask(C, { requestId: R, title: " Order signs ", required: "on", waitingOn: "client", category: "other", dueDate: "", ownerUserId: "" });
  await actions.setTaskStatus(C, T, { expectedUpdatedAt: V, status: "blocked", reason: " waiting on login " });
  await actions.setTaskDetails(C, T, { expectedUpdatedAt: V, ownerUserId: "", dueDate: "2026-10-20" });
  await actions.setClientDetails(C, { expectedUpdatedAt: V, ownerUserId: R, targetLaunchDate: "" });
  await actions.markReadyToLaunch(C, { expectedUpdatedAt: V });
  await actions.moveToOngoing(C, { expectedUpdatedAt: V });
  await actions.linkOrganization(C, { expectedUpdatedAt: V, organizationId: O });
  assert.deepEqual(calls, [
    { name: "agency_start_onboarding", args: { p_client_id: C, p_expected_updated_at: V, p_services: ["crm", "sms"], p_owner_user_id: R, p_target_launch_date: "2026-11-01" } },
    { name: "agency_add_services", args: { p_client_id: C, p_expected_updated_at: V, p_services: ["reporting"] } },
    { name: "agency_add_task", args: { p_request_id: R, p_client_id: C, p_title: "Order signs", p_description: null, p_category: "other", p_required: true, p_waiting_on: "client", p_owner_user_id: null, p_due_date: null } },
    { name: "agency_set_task_status", args: { p_task_id: T, p_expected_updated_at: V, p_status: "blocked", p_reason: "waiting on login" } },
    { name: "agency_set_task_details", args: { p_task_id: T, p_expected_updated_at: V, p_owner_user_id: null, p_due_date: "2026-10-20" } },
    { name: "agency_set_client_details", args: { p_client_id: C, p_expected_updated_at: V, p_owner_user_id: R, p_target_launch_date: null } },
    { name: "agency_mark_ready_to_launch", args: { p_client_id: C, p_expected_updated_at: V } },
    { name: "agency_move_to_ongoing", args: { p_client_id: C, p_expected_updated_at: V } },
    { name: "agency_link_client_organization", args: { p_client_id: C, p_expected_updated_at: V, p_organization_id: O } },
  ]);
  response = { data: { status: "duplicate" }, error: null };
  assert.deepEqual(await actions.markReadyToLaunch(C, { expectedUpdatedAt: V }), { ok: true, status: "duplicate" });
});

test("refusals read clearly; stale writes say to refresh; internals never leak", async () => {
  response = { data: null, error: { code: "FS409", message: "this client changed since it was loaded" } };
  assert.deepEqual(await actions.markReadyToLaunch(C, { expectedUpdatedAt: V }), { ok: false, error: "This client changed since it was loaded. Refresh to see the latest." });
  response = { data: null, error: { code: "FS422", message: "not ready: 3 of 13 required tasks done, 1 blocked" } };
  assert.deepEqual(await actions.markReadyToLaunch(C, { expectedUpdatedAt: V }), { ok: false, error: "Not ready: 3 of 13 required tasks done, 1 blocked." });
  response = { data: null, error: { code: "FS404", message: "agency client not found" } };
  assert.deepEqual(await actions.moveToOngoing(C, { expectedUpdatedAt: V }), { ok: false, error: "That client or task could not be found." });
  response = { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint agency_clients_organization_id_key" } };
  assert.deepEqual(await actions.linkOrganization(C, { expectedUpdatedAt: V, organizationId: O }), { ok: false, error: "Someone else just made the same change. Refresh to see the latest." });
  response = { data: null, error: { code: "PGRST202", message: "x" } };
  assert.deepEqual(await actions.moveToOngoing(C, { expectedUpdatedAt: V }), { ok: false, error: "Client delivery isn't enabled on this database yet." });
  response = { data: null, error: { code: "XX000", message: "relation secret_internal_table" } };
  const r = await actions.moveToOngoing(C, { expectedUpdatedAt: V });
  assert.equal(r.ok, false);
  assert.doesNotMatch((r as { error: string }).error, /secret|relation/);
});

test("approve launch: evidence is computed on the server from fresh reads - Unverified when no account is linked", async () => {
  const result = await actions.approveLaunch(C, { requestId: R, expectedUpdatedAt: V, acknowledgement: "  Checked texting by hand with the client.  " });
  assert.deepEqual(result, { ok: true, status: "recorded" });
  assert.deepEqual(signalCalls, [[service, null]], "signals read with the service client for this client's own link only");
  assert.equal(calls.length, 1);
  const call = rpcCall(0);
  assert.equal(call.name, "agency_approve_launch");
  assert.deepEqual({ ...call.args, p_evidence: undefined }, { p_request_id: R, p_client_id: C, p_expected_updated_at: V, p_evidence: undefined });
  const evidence = call.args.p_evidence as { checks: { key: string; status: string; detail: string }[]; unverified_acknowledgement: string };
  assert.equal(evidence.unverified_acknowledgement, "Checked texting by hand with the client.");
  assert.deepEqual(
    evidence.checks.filter((c) => c.status === "unverified").map((c) => c.key),
    ["trackpr_account", "payment_status", "automation_health", "module_sms"],
  );
  for (const c of evidence.checks.filter((x) => x.status === "unverified")) assert.equal(c.detail, "Unverified - no Trackpr account linked");
  assert.ok(evidence.checks.filter((c) => c.status === "passed").length >= 4);
});

test("approve launch: unverified checks need a written acknowledgement; critical failures are refused before the database", async () => {
  assert.deepEqual(await actions.approveLaunch(C, { requestId: R, expectedUpdatedAt: V, acknowledgement: "ok" }), { ok: false, error: "Acknowledge the unverified checks in writing before launching." });
  assert.deepEqual(calls, []);

  detail = readyDetail([doneTask("core.end_to_end_test"), doneTask("core.client_acceptance", { status: "todo", completedAt: null, completedBy: null })]);
  const r = await actions.approveLaunch(C, { requestId: R, expectedUpdatedAt: V, acknowledgement: "Long enough acknowledgement" });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /^Can't launch yet: Required onboarding tasks \(1 of 2 done\)/);
  assert.deepEqual(calls, []);

  detail = readyDetail(undefined, { organizationId: O });
  signals = { kind: "linked", organizationId: O, organizationName: "Acme TP", health: null, checklist: null, paymentStatus: "suspended", paused: false };
  const unpaid = await actions.approveLaunch(C, { requestId: R, expectedUpdatedAt: V, acknowledgement: "Long enough acknowledgement" });
  assert.match((unpaid as { error: string }).error, /Client's Trackpr payment status \(Payment status: suspended\)/);
  assert.deepEqual(signalCalls.at(-1), [service, O]);
  assert.deepEqual(calls, []);
});

test("approve launch: fully verified linked account needs no acknowledgement; an existing launch is a duplicate; a missing client is not found", async () => {
  detail = readyDetail(undefined, { organizationId: O, services: ["sms"] });
  signals = {
    kind: "linked",
    organizationId: O,
    organizationName: "Acme TP",
    health: { status: "healthy", incidentsUnavailable: false, criticalIncidentCount: 0, activeIncidentCount: 0, staleScheduledAutomationCount: 0, paymentStatus: "active" },
    checklist: { items: [{ key: "testVerified", complete: true, state: "ready" }, { key: "sms", complete: true, state: "ready" }] },
    paymentStatus: "active",
    paused: false,
  };
  assert.deepEqual(await actions.approveLaunch(C, { requestId: R, expectedUpdatedAt: V }), { ok: true, status: "recorded" });
  assert.equal((rpcCall(0).args.p_evidence as { unverified_acknowledgement: unknown }).unverified_acknowledgement, null);

  calls = [];
  detail = { ...readyDetail(), detail: { ...(readyDetail() as { detail: object }).detail, launch: { id: R } } };
  assert.deepEqual(await actions.approveLaunch(C, { requestId: R, expectedUpdatedAt: V, acknowledgement: "Long enough acknowledgement" }), { ok: true, status: "duplicate" });
  assert.deepEqual(calls, []);

  detail = { ok: false, reason: "load_failed" };
  assert.equal((await actions.approveLaunch(C, { requestId: R, expectedUpdatedAt: V })).ok, false);
  assert.deepEqual(await actions.approveLaunch("55555555-5555-4555-8555-555555555555", { requestId: R, expectedUpdatedAt: V }), { ok: false, error: "That client or task could not be found." });
  assert.deepEqual(calls, []);
});

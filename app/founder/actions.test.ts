/**
 * Founder Command Center server actions (app/founder/actions.ts): access is
 * re-checked on every call (a non-founder writes nothing), every write is
 * scoped to the caller's own owner_id (another founder's rows are never
 * touched), and the CRUD paths behave. Runs the REAL actions against an
 * in-memory store; founder resolution is mocked. The database-side rules
 * (RLS, allow-list, triggers) are proven by
 * supabase/pending/scratch/validate-founder-command-center.mjs.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test app/founder/actions.test.ts
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;

type Row = Record<string, unknown>;
const ME = "founder-1";
const REQ = "11111111-1111-4111-8111-111111111111";
const REQ2 = "22222222-2222-4222-8222-222222222222";
const OTHER = "founder-2";
let store: Record<string, Row[]> = {};
let ids = 0;
let caller: string | null = ME;
/** Database functions called (name + args), and what the next call returns. */
let rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
/** Read through a function: assert.deepEqual(rpcCalls, []) narrows the variable itself. */
const rpcCall = (i: number) => rpcCalls[i];
let rpcResponse: { data: unknown; error: unknown } = { data: { status: "recorded", updated_at: "v2" }, error: null };
/** Makes the next write of this kind on this table fail with `error` (e.g. a foreign-key refusal). */
let failNext: { table: string; op: "delete" | "update" | "insert"; error: { code: string; message?: string } } | null = null;

class Query {
  private filters: ((row: Row) => boolean)[] = [];
  private patch: Row | null = null;
  private insertRows: Row[] | null = null;
  private upsertConflict: string[] | null = null;
  private deleting = false;
  private table: string;
  constructor(table: string) {
    this.table = table;
  }
  select() { return this; }
  eq(column: string, value: unknown) { this.filters.push((row) => row[column] === value); return this; }
  is(column: string, value: unknown) { this.filters.push((row) => (row[column] ?? null) === value); return this; }
  not(column: string, _op: string, value: unknown) { this.filters.push((row) => (row[column] ?? null) !== value); return this; }
  update(values: Row) { this.patch = values; return this; }
  insert(values: Row | Row[]) { this.insertRows = Array.isArray(values) ? values : [values]; return this; }
  upsert(values: Row, options: { onConflict: string }) { this.insertRows = [values]; this.upsertConflict = options.onConflict.split(","); return this; }
  delete() { this.deleting = true; return this; }
  single() { return this.run(); }
  maybeSingle() { return this.run(); }
  private async run(): Promise<{ data: unknown; error: unknown }> {
    const table = (store[this.table] ??= []);
    const op = this.insertRows ? "insert" : this.deleting ? "delete" : this.patch ? "update" : null;
    if (failNext && failNext.table === this.table && failNext.op === op) {
      const error = failNext.error;
      failNext = null;
      return { data: null, error };
    }
    if (this.insertRows) {
      const row = this.insertRows[0];
      if (this.upsertConflict) {
        const existing = table.find((r) => this.upsertConflict!.every((c) => r[c] === row[c]));
        if (existing) {
          Object.assign(existing, row);
          return { data: { ...existing }, error: null };
        }
      }
      const inserted = { id: `id-${++ids}`, completed_at: null, ...row };
      table.push(inserted);
      return { data: { ...inserted }, error: null };
    }
    const rows = table.filter((row) => this.filters.every((f) => f(row)));
    if (this.patch) for (const row of rows) Object.assign(row, this.patch);
    if (this.deleting) store[this.table] = table.filter((row) => !rows.includes(row));
    return { data: rows[0] ? { ...rows[0] } : null, error: null };
  }
}
const db = {
  from: (table: string) => new Query(table),
  rpc: async (name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    return rpcResponse;
  },
};

mock.module(lib("lib/founder/access.ts"), {
  namedExports: { getFounderContext: async () => (caller ? { supabase: db, userId: caller, email: "f@example.com", timeZone: "America/Denver" } : null) },
});
mock.module("next/cache", { namedExports: { revalidatePath: () => undefined } });

const actions = await import(lib("app/founder/actions.ts"));

beforeEach(() => {
  ids = 0;
  caller = ME;
  rpcCalls = [];
  rpcResponse = { data: { status: "recorded", updated_at: "v2" }, error: null };
  failNext = null;
  store = {
    founder_items: [{ id: "theirs-item", owner_id: OTHER, kind: "task", title: "Theirs", completed_at: null }],
    founder_deals: [{ id: "theirs-deal", owner_id: OTHER, name: "Their deal", stage: "negotiation", updated_at: "v1" }],
    founder_mrr_entries: [{ id: "theirs-mrr", owner_id: OTHER, month: "2026-10-01", kind: "new", amount: 1 }],
    founder_reviews: [],
  };
});

test("a non-founder is refused by every action and nothing is written", async () => {
  caller = null;
  const before = JSON.stringify(store);
  const refused = { ok: false, error: "The Founder Command Center isn't available for this account." };
  for (const result of [
    await actions.createFounderItem({ title: "x" }),
    await actions.quickCaptureFounderItem("x"),
    await actions.updateFounderItem("theirs-item", { title: "x" }),
    await actions.setFounderItemCompleted("theirs-item", true),
    await actions.deleteFounderItem("theirs-item"),
    await actions.createFounderDeal({ name: "x" }),
    await actions.updateFounderDeal("theirs-deal", { name: "x" }),
    await actions.changeFounderDealStage("theirs-deal", { toStage: "replied", requestId: REQ, expectedUpdatedAt: "v1" }),
    await actions.logFounderDealActivity("theirs-deal", { kind: "outreach", occurredAt: "2026-10-01T09:00", requestId: REQ }),
    await actions.voidFounderDealActivity(REQ, "wrong"),
    await actions.prepareClientHandoff("theirs-deal", { requestId: REQ, scope: "Lead response automation" }),
    await actions.cancelFounderClientHandoff(REQ, "wrong"),
    await actions.deleteFounderDeal("theirs-deal"),
    await actions.createFounderMrrEntry({ month: "2026-10", kind: "new", amount: "1" }),
    await actions.deleteFounderMrrEntry("theirs-mrr"),
    await actions.saveFounderReview({ reviewDate: "2026-10-09", wins: "x" }),
  ]) {
    assert.deepEqual(result, refused);
  }
  assert.equal(JSON.stringify(store), before);
  assert.deepEqual(rpcCalls, [], "no database function is even called");
});

test("tasks: create (owned by the caller), quick capture, edit, complete once, reopen, delete", async () => {
  const created = await actions.createFounderItem({ kind: "task", title: "Send proposal", priority: "high", dueAt: "2026-10-09T17:00" });
  assert.equal(created.ok, true);
  const row = store.founder_items.find((r) => r.title === "Send proposal")!;
  assert.equal(row.owner_id, ME);
  assert.equal(row.due_at, "2026-10-09T23:00:00.000Z");
  assert.equal((await actions.quickCaptureFounderItem("Call the accountant")).ok, true);
  assert.equal(store.founder_items.find((r) => r.title === "Call the accountant")?.due_at, null, "a capture is undated");
  assert.equal((await actions.updateFounderItem(row.id as string, { kind: "follow_up", title: "Send proposal v2", priority: "low" })).ok, true);
  assert.equal(row.title, "Send proposal v2");

  assert.equal((await actions.setFounderItemCompleted(row.id as string, true)).ok, true);
  const completedAt = row.completed_at;
  assert.ok(completedAt);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await actions.setFounderItemCompleted(row.id as string, true)).ok, true);
  assert.equal(row.completed_at, completedAt, "completing twice keeps the first completion time");
  assert.equal((await actions.setFounderItemCompleted(row.id as string, false)).ok, true);
  assert.equal(row.completed_at, null);
  assert.equal((await actions.deleteFounderItem(row.id as string)).ok, true);
  assert.equal(store.founder_items.some((r) => r.id === row.id), false);
  assert.equal((await actions.createFounderItem({ kind: "meeting", title: "Demo" })).ok, false, "validation runs before any write");
});

test("another founder's rows can't be read, changed, completed, deleted or linked", async () => {
  const before = JSON.stringify(store);
  assert.deepEqual(await actions.updateFounderItem("theirs-item", { title: "mine now" }), { ok: false, error: "That item could not be found." });
  assert.deepEqual(await actions.setFounderItemCompleted("theirs-item", true), { ok: false, error: "That item could not be found." });
  assert.deepEqual(await actions.deleteFounderItem("theirs-item"), { ok: false, error: "That item could not be found." });
  assert.deepEqual(await actions.updateFounderDeal("theirs-deal", { name: "x" }), { ok: false, error: "That deal could not be found." });
  assert.deepEqual(await actions.changeFounderDealStage("theirs-deal", { toStage: "replied", requestId: REQ, expectedUpdatedAt: "v1" }), { ok: false, error: "That deal could not be found." });
  assert.deepEqual(await actions.logFounderDealActivity("theirs-deal", { kind: "outreach", occurredAt: "2026-10-01T09:00", requestId: REQ }), { ok: false, error: "That deal could not be found." });
  assert.deepEqual(rpcCalls, [], "another founder's deal never reaches the database functions");
  assert.deepEqual(await actions.deleteFounderDeal("theirs-deal"), { ok: false, error: "That deal could not be found." });
  assert.deepEqual(await actions.deleteFounderMrrEntry("theirs-mrr"), { ok: false, error: "That entry could not be found." });
  assert.deepEqual(await actions.createFounderItem({ title: "Link", dealId: "theirs-deal" }), { ok: false, error: "That deal could not be found." });
  assert.equal(JSON.stringify(store), before);
});

test("deals: create at an open stage (duplicate-safe), details-only edits with a required version check", async () => {
  assert.deepEqual(await actions.createFounderDeal({ name: "Instant win", stage: "won" }), { ok: false, error: "Choose a valid starting stage." });
  const fields = { name: "Acme Roofing", stage: "qualified", trade: "Roofing", source: "referral", expectedSetupFee: "2,500", expectedMrr: "1497", nextAction: "Send intro", nextActionAt: "2026-10-10T09:00", clientId: REQ };
  const created = await actions.createFounderDeal(fields);
  assert.equal(created.ok, true);
  assert.deepEqual(await actions.createFounderDeal(fields), created, "the same clientId again finds the same deal");
  const mine = store.founder_deals.filter((r) => r.owner_id === ME);
  assert.equal(mine.length, 1);
  const row = mine[0];
  assert.deepEqual([row.id, row.stage, row.trade, row.source, row.expected_setup_fee, row.expected_mrr, row.currency], [REQ, "qualified", "Roofing", "referral", 2500, 1497, "USD"]);
  for (const key of ["won_setup_fee", "won_monthly_fee", "won_amount", "won_on", "lost_reason", "last_activity_at"]) assert.ok(!(key in row), `create never writes ${key}`);
  row.updated_at = "v1";

  const stale = { ok: false, error: "This deal changed since you opened it. Close and reopen it to see the latest version, then try again." };
  assert.deepEqual(await actions.updateFounderDeal(REQ, { name: "Acme" }), stale, "no version = refused");
  assert.deepEqual(await actions.updateFounderDeal(REQ, { name: "Acme", expectedUpdatedAt: "v0" }), stale);
  assert.equal(row.name, "Acme Roofing");
  assert.equal((await actions.updateFounderDeal(REQ, { name: "Acme", stage: "won", wonSetupFee: "1", expectedUpdatedAt: "v1" })).ok, true);
  assert.deepEqual([row.name, row.stage, "won_setup_fee" in row], ["Acme", "qualified", false], "edits never change the stage or outcome");
});

test("deal deletion: a deal with recorded history is refused with a clear way forward", async () => {
  store.founder_deals.push({ id: "mine", owner_id: ME, name: "Mine", stage: "outreach" });
  failNext = { table: "founder_deals", op: "delete", error: { code: "23503" } };
  assert.deepEqual(await actions.deleteFounderDeal("mine"), { ok: false, error: "This deal has recorded sales history, so it can't be deleted. Mark it lost instead." });
  assert.ok(store.founder_deals.some((r) => r.id === "mine"));
  assert.equal((await actions.deleteFounderDeal("mine")).ok, true, "a deal with no history can be deleted");
});

test("stage changes: request id and loaded version required; terms/reason validated before the database is called", async () => {
  store.founder_deals.push({ id: "mine", owner_id: ME, name: "Mine", stage: "negotiation", updated_at: "v1" });
  assert.equal((await actions.changeFounderDealStage("mine", { toStage: "replied", expectedUpdatedAt: "v1" })).ok, false, "no request id");
  assert.equal((await actions.changeFounderDealStage("mine", { toStage: "replied", requestId: REQ })).ok, false, "no version");
  assert.deepEqual(await actions.changeFounderDealStage("mine", { toStage: "won", requestId: REQ, expectedUpdatedAt: "v1" }), { ok: false, error: "Enter the agreed setup fee." });
  assert.deepEqual(await actions.changeFounderDealStage("mine", { toStage: "lost", requestId: REQ, expectedUpdatedAt: "v1" }), { ok: false, error: "Enter why the deal was lost." });
  assert.deepEqual(rpcCalls, []);
  const won = await actions.changeFounderDealStage("mine", { toStage: "won", setupFee: "2500", monthlyFee: "1497", currency: "usd", wonOn: "2026-10-01", requestId: REQ, expectedUpdatedAt: "v1" });
  assert.deepEqual(won, { ok: true, status: "recorded", updatedAt: "v2" });
  assert.deepEqual(rpcCall(0), {
    name: "founder_change_deal_stage",
    args: { p_request_id: REQ, p_deal_id: "mine", p_to_stage: "won", p_expected_updated_at: "v1", p_occurred_at: null, p_setup_fee: 2500, p_monthly_fee: 1497, p_currency: "USD", p_won_on: "2026-10-01", p_reason: null },
  });
  assert.equal(store.founder_deals.find((r) => r.id === "mine")!.stage, "negotiation", "the action never writes the stage itself - only the database function does");
});

test("stage changes: database refusals become clear messages; a retry reports duplicate", async () => {
  store.founder_deals.push({ id: "mine", owner_id: ME, name: "Mine", stage: "replied", updated_at: "v1" });
  const move = () => actions.changeFounderDealStage("mine", { toStage: "meeting_booked", requestId: REQ, expectedUpdatedAt: "v1" });
  rpcResponse = { data: null, error: { code: "FS409", message: "the deal changed since it was loaded" } };
  assert.deepEqual(await move(), { ok: false, error: "This deal changed since you opened it. Close and reopen it to see the latest version, then try again." });
  rpcResponse = { data: null, error: { code: "FS422", message: "reopen the deal before changing its outcome" } };
  assert.deepEqual(await move(), { ok: false, error: "Reopen the deal before changing its outcome." });
  rpcResponse = { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
  assert.deepEqual(await move(), { ok: false, error: "Sales history isn't enabled on this database yet." });
  rpcResponse = { data: null, error: { code: "XX000", message: "internal detail that must not leak" } };
  assert.deepEqual(await move(), { ok: false, error: "We couldn't record that. Please try again." });
  rpcResponse = { data: { status: "duplicate", updated_at: "v2" }, error: null };
  assert.deepEqual(await move(), { ok: true, status: "duplicate", updatedAt: "v2" });
  store.founder_deals.find((r) => r.id === "mine")!.stage = "meeting_booked";
  assert.deepEqual(await move(), { ok: true, status: "duplicate", updatedAt: "v2" }, "a retry after the change applied still reaches the database, which reports the duplicate");
});

test("logging activity: past only, optional atomic stage advance needs the loaded version", async () => {
  store.founder_deals.push({ id: "mine", owner_id: ME, name: "Mine", stage: "outreach", updated_at: "v1" });
  assert.equal((await actions.logFounderDealActivity("mine", { kind: "reply_received", occurredAt: "2999-01-01T09:00", requestId: REQ })).ok, false);
  assert.equal((await actions.logFounderDealActivity("mine", { kind: "reply_received", occurredAt: "2026-10-01T09:00", requestId: REQ, advance: "on" })).ok, false, "advancing without a version is refused");
  assert.deepEqual(rpcCalls, []);
  assert.equal((await actions.logFounderDealActivity("mine", { kind: "reply_received", occurredAt: "2026-10-01T09:00", channel: "email", requestId: REQ, advance: "on", expectedUpdatedAt: "v1" })).ok, true);
  assert.deepEqual(rpcCall(0), {
    name: "founder_log_deal_activity",
    args: { p_request_id: REQ, p_deal_id: "mine", p_kind: "reply_received", p_occurred_at: "2026-10-01T15:00:00.000Z", p_channel: "email", p_summary: null, p_scheduled_for: null, p_to_stage: "replied", p_expected_updated_at: "v1" },
  });
  assert.equal((await actions.logFounderDealActivity("mine", { kind: "note", occurredAt: "2026-10-01T09:00", requestId: REQ2, summary: "Asked about pricing" })).ok, true);
  assert.equal(rpcCall(1).args.p_to_stage, null);
  assert.equal(rpcCall(1).args.p_expected_updated_at, null, "no stage move = no version needed");
  assert.equal((await actions.voidFounderDealActivity(REQ, " ")).ok, false, "void needs a reason");
  assert.equal((await actions.voidFounderDealActivity("not-a-uuid", "x")).ok, false);
  assert.equal((await actions.voidFounderDealActivity(REQ, "Logged on the wrong deal")).ok, true);
  assert.deepEqual(rpcCall(2), { name: "founder_void_deal_activity", args: { p_activity_id: REQ, p_reason: "Logged on the wrong deal" } });
});

test("client handoff: only a won deal with terms and contact; scope required; nothing reaches the database until complete", async () => {
  store.founder_deals.push(
    { id: "open", owner_id: ME, name: "Open", stage: "negotiation", won_setup_fee: null, won_monthly_fee: null, contact_name: "Dana", contact_email: "d@x.co", contact_phone: null },
    { id: "nocontact", owner_id: ME, name: "No contact", stage: "won", won_setup_fee: 2500, won_monthly_fee: 1497, contact_name: null, contact_email: null, contact_phone: null },
    { id: "ready", owner_id: ME, name: "Ready", stage: "won", won_setup_fee: 2500, won_monthly_fee: 1497, contact_name: "Dana", contact_email: null, contact_phone: "555-0100" },
  );
  const scope = "Lead response automation and monthly reporting";
  assert.deepEqual(await actions.prepareClientHandoff("open", { requestId: REQ, scope }), { ok: false, error: "Before handing off, add: the deal must be won; agreed setup and monthly fees." });
  assert.deepEqual(await actions.prepareClientHandoff("nocontact", { requestId: REQ, scope }), { ok: false, error: "Before handing off, add: a decision-maker name; a contact email or phone." });
  assert.deepEqual(await actions.prepareClientHandoff("ready", { requestId: REQ, scope: "short" }), { ok: false, error: "Describe the agreed scope (at least 10 characters)." });
  assert.equal((await actions.prepareClientHandoff("ready", { scope })).ok, false, "a request id is required");
  assert.deepEqual(await actions.prepareClientHandoff("theirs-deal", { requestId: REQ, scope }), { ok: false, error: "That deal could not be found." });
  assert.deepEqual(rpcCalls, []);
  rpcResponse = { data: { status: "prepared", handoff_id: REQ, handoff_status: "prepared" }, error: null };
  assert.deepEqual(await actions.prepareClientHandoff("ready", { requestId: REQ, scope: `  ${scope}  ` }), { ok: true, status: "prepared", handoffId: REQ });
  assert.deepEqual(rpcCall(0), { name: "founder_prepare_client_handoff", args: { p_request_id: REQ, p_deal_id: "ready", p_scope: scope } });
  rpcResponse = { data: { status: "exists", handoff_id: REQ2, handoff_status: "prepared" }, error: null };
  assert.deepEqual(await actions.prepareClientHandoff("ready", { requestId: REQ, scope }), { ok: true, status: "exists", handoffId: REQ2 }, "a second request reports the existing handoff");
  for (const key of ["stage", "won_setup_fee", "contact_name", "contact_email"]) assert.ok(store.founder_deals.find((r) => r.id === "ready")![key] !== undefined, "the deal is only read");
  assert.equal(store.agency_clients, undefined, "no client is created from the founder side");
});

test("client handoff: database refusals become clear messages; cancel needs a reason", async () => {
  store.founder_deals.push({ id: "ready", owner_id: ME, name: "Ready", stage: "won", won_setup_fee: 1, won_monthly_fee: 1, contact_name: "Dana", contact_email: "d@x.co", contact_phone: null });
  const scope = "Lead response automation";
  rpcResponse = { data: null, error: { code: "FS422", message: "before handing off, add: a written scope (at least 10 characters)" } };
  assert.deepEqual(await actions.prepareClientHandoff("ready", { requestId: REQ, scope }), { ok: false, error: "Before handing off, add: a written scope (at least 10 characters)." });
  rpcResponse = { data: null, error: { code: "PGRST202", message: "x" } };
  assert.deepEqual(await actions.prepareClientHandoff("ready", { requestId: REQ, scope }), { ok: false, error: "Client handoff isn't enabled on this database yet." });
  rpcResponse = { data: null, error: { code: "XX000", message: "internal detail" } };
  assert.deepEqual(await actions.prepareClientHandoff("ready", { requestId: REQ, scope }), { ok: false, error: "We couldn't complete the handoff step. Please try again - nothing was saved twice." });
  const calls = rpcCalls.length;
  assert.equal((await actions.cancelFounderClientHandoff(REQ, "  ")).ok, false);
  assert.equal((await actions.cancelFounderClientHandoff("nope", "x")).ok, false);
  assert.equal(rpcCalls.length, calls);
  rpcResponse = { data: { status: "cancelled" }, error: null };
  assert.deepEqual(await actions.cancelFounderClientHandoff(REQ, "Client asked to wait"), { ok: true, status: "cancelled", handoffId: REQ });
  assert.deepEqual(rpcCall(calls), { name: "cancel_client_handoff", args: { p_handoff_id: REQ, p_reason: "Client asked to wait" } });
  rpcResponse = { data: null, error: { code: "FS422", message: "this handoff is confirmed - the Agency client already exists" } };
  assert.deepEqual(await actions.cancelFounderClientHandoff(REQ, "x"), { ok: false, error: "This handoff is confirmed - the Agency client already exists." });
});

test("MRR entries are always stored as manual; reviews upsert one per day", async () => {
  assert.equal((await actions.createFounderMrrEntry({ month: "2026-10", kind: "new", amount: "500", source: "stripe" })).ok, true);
  const entry = store.founder_mrr_entries.find((r) => r.owner_id === ME)!;
  assert.equal(entry.source, "manual", "a caller can't label an entry as synced");
  assert.equal(entry.is_forecast, false);
  assert.equal((await actions.deleteFounderMrrEntry(entry.id as string)).ok, true);

  assert.equal((await actions.saveFounderReview({ reviewDate: "2026-10-09", wins: "Closed Acme" })).ok, true);
  assert.equal((await actions.saveFounderReview({ reviewDate: "2026-10-09", wins: "Closed Acme", blockers: "Hiring" })).ok, true);
  const reviews = store.founder_reviews.filter((r) => r.owner_id === ME);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].blockers, "Hiring");
});

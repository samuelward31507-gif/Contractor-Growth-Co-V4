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
const OTHER = "founder-2";
let store: Record<string, Row[]> = {};
let ids = 0;
let caller: string | null = ME;

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
const db = { from: (table: string) => new Query(table) };

mock.module(lib("lib/founder/access.ts"), {
  namedExports: { getFounderContext: async () => (caller ? { supabase: db, userId: caller, email: "f@example.com", timeZone: "America/Denver" } : null) },
});
mock.module("next/cache", { namedExports: { revalidatePath: () => undefined } });

const actions = await import(lib("app/founder/actions.ts"));

beforeEach(() => {
  ids = 0;
  caller = ME;
  store = {
    founder_items: [{ id: "theirs-item", owner_id: OTHER, kind: "task", title: "Theirs", completed_at: null }],
    founder_deals: [{ id: "theirs-deal", owner_id: OTHER, name: "Their deal", stage: "lead" }],
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
    await actions.moveFounderDealStage("theirs-deal", "contacted"),
    await actions.deleteFounderDeal("theirs-deal"),
    await actions.createFounderMrrEntry({ month: "2026-10", kind: "new", amount: "1" }),
    await actions.deleteFounderMrrEntry("theirs-mrr"),
    await actions.saveFounderReview({ reviewDate: "2026-10-09", wins: "x" }),
  ]) {
    assert.deepEqual(result, refused);
  }
  assert.equal(JSON.stringify(store), before);
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
  assert.deepEqual(await actions.moveFounderDealStage("theirs-deal", "contacted"), { ok: false, error: "That deal could not be found." });
  assert.deepEqual(await actions.deleteFounderDeal("theirs-deal"), { ok: false, error: "That deal could not be found." });
  assert.deepEqual(await actions.deleteFounderMrrEntry("theirs-mrr"), { ok: false, error: "That entry could not be found." });
  assert.deepEqual(await actions.createFounderItem({ title: "Link", dealId: "theirs-deal" }), { ok: false, error: "That deal could not be found." });
  assert.equal(JSON.stringify(store), before);
});

test("deals: create, edit, move stage; won only through the form with amount and date", async () => {
  const created = await actions.createFounderDeal({ name: "Acme Roofing", stage: "lead", expectedMrr: "299", nextAction: "Send pricing", nextActionAt: "2026-10-10T09:00" });
  assert.equal(created.ok, true);
  const row = store.founder_deals.find((r) => r.name === "Acme Roofing")!;
  assert.equal(row.owner_id, ME);
  assert.equal(row.expected_mrr, 299);
  assert.equal((await actions.moveFounderDealStage(row.id as string, "meeting_booked")).ok, true);
  assert.equal(row.stage, "meeting_booked");
  assert.equal((await actions.moveFounderDealStage(row.id as string, "won")).ok, false, "won needs the amount and date");
  assert.equal((await actions.moveFounderDealStage(row.id as string, "closed")).ok, false);
  assert.equal(row.stage, "meeting_booked");
  assert.equal((await actions.updateFounderDeal(row.id as string, { name: "Acme Roofing", stage: "won", wonAmount: "299", wonOn: "2026-10-09" })).ok, true);
  assert.equal(row.stage, "won");
  assert.equal(row.won_amount, 299);
  assert.equal(row.won_on, "2026-10-09");
  assert.equal((await actions.moveFounderDealStage(row.id as string, "negotiation")).ok, true);
  assert.equal(row.won_amount, null, "reopening clears the won figures");
  assert.equal((await actions.deleteFounderDeal(row.id as string)).ok, true);
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

/**
 * Daily operating-system actions (app/founder/actions.ts) through the REAL
 * server code: setting, adding, reordering, completing and removing daily
 * priorities; quick capture (validation, optional due date, duplicate
 * prevention); moving unfinished work to another day (only on request,
 * keeping local times, refusing stale or finished items); founder-only
 * access and owner isolation; and a database without the daily-focus
 * columns. The store emulates founder_items_focus_guard (three per founder
 * per day, no events) and bumps updated_at on every write; the real
 * trigger is proven by supabase/pending/scratch/validate-founder-daily-focus.mjs.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test app/founder/daily-actions.test.ts
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;

type Row = Record<string, unknown>;
const ME = "founder-1";
const OTHER = "founder-2";
const TZ = "America/Denver";
const DAY = "2026-10-09";
let store: Record<string, Row[]> = {};
let clock = 0;
let caller: string | null = ME;
let focusMissing = false;
const stamp = () => new Date(Date.UTC(2026, 9, 9, 12, 0, 0, ++clock)).toISOString();

class Query {
  private filters: ((row: Row) => boolean)[] = [];
  private patch: Row | null = null;
  private insertRows: Row[] | null = null;
  private deleting = false;
  private columns = "*";
  private sorts: { column: string; ascending: boolean }[] = [];
  private one = false;
  private table: string;
  constructor(table: string) {
    this.table = table;
  }
  select(columns = "*") { this.columns = columns; return this; }
  eq(column: string, value: unknown) { this.filters.push((row) => row[column] === value); return this; }
  is(column: string, value: unknown) { this.filters.push((row) => (row[column] ?? null) === value); return this; }
  not(column: string, _op: string, value: unknown) { this.filters.push((row) => (row[column] ?? null) !== value); return this; }
  gte(column: string, value: string) { this.filters.push((row) => row[column] != null && String(row[column]) >= value); return this; }
  lte(column: string, value: string) { this.filters.push((row) => row[column] != null && String(row[column]) <= value); return this; }
  order(column: string, options?: { ascending?: boolean }) { this.sorts.push({ column, ascending: options?.ascending !== false }); return this; }
  update(values: Row) { this.patch = values; return this; }
  insert(values: Row | Row[]) { this.insertRows = Array.isArray(values) ? values : [values]; return this; }
  delete() { this.deleting = true; return this; }
  single() { this.one = true; return this.run(); }
  maybeSingle() { this.one = true; return this.run(); }
  then<T>(resolve: (value: { data: unknown; error: unknown }) => T, reject?: (reason: unknown) => T) { return this.run().then(resolve, reject); }
  /** founder_items_focus_guard, as on the database. */
  private focusGuard(next: Row, prev: Row | null): string | null {
    if (!next.focus_date) return null;
    if (next.kind === "event" || next.kind === "meeting") return "events and meetings cannot be daily priorities";
    if (prev && prev.focus_date === next.focus_date) return null;
    const others = store.founder_items.filter((r) => r.owner_id === next.owner_id && r.focus_date === next.focus_date && r.id !== next.id).length;
    return others >= 3 ? "a day can have at most three priorities" : null;
  }
  private async run(): Promise<{ data: unknown; error: unknown }> {
    if (this.table === "founder_items" && focusMissing && /focus_/.test(this.columns + JSON.stringify(this.patch ?? {}) + this.filters.length)) {
      if (/focus_/.test(this.columns + JSON.stringify(this.patch ?? {}))) return { data: null, error: { code: "42703", message: 'column founder_items.focus_date does not exist' } };
    }
    const table = (store[this.table] ??= []);
    if (this.insertRows) {
      const row: Row = { id: `id-${++clock}`, completed_at: null, focus_date: null, focus_rank: null, created_at: stamp(), ...this.insertRows[0] };
      row.updated_at = stamp();
      if (table.some((r) => r.id === row.id)) return { data: null, error: { code: "23505", message: "duplicate key" } };
      table.push(row);
      return { data: { ...row }, error: null };
    }
    let rows = table.filter((row) => this.filters.every((f) => f(row)));
    if (this.patch) {
      for (const row of rows) {
        const blocked = this.table === "founder_items" ? this.focusGuard({ ...row, ...this.patch }, row) : null;
        if (blocked) return { data: null, error: { message: blocked } };
      }
      for (const row of rows) Object.assign(row, this.patch, { updated_at: stamp() });
    }
    if (this.deleting) store[this.table] = table.filter((row) => !rows.includes(row));
    for (const { column, ascending } of [...this.sorts].reverse()) rows = [...rows].sort((a, b) => String(a[column] ?? "").localeCompare(String(b[column] ?? "")) * (ascending ? 1 : -1));
    return { data: this.one ? (rows[0] ? { ...rows[0] } : null) : rows.map((r) => ({ ...r })), error: null };
  }
}
const db = { from: (table: string) => new Query(table) };

mock.module(lib("lib/founder/access.ts"), {
  namedExports: { getFounderContext: async () => (caller ? { supabase: db, userId: caller, email: "f@example.com", timeZone: TZ } : null) },
});
mock.module("next/cache", { namedExports: { revalidatePath: () => undefined } });

const actions = await import(lib("app/founder/actions.ts"));
const { getFounderFocus } = await import(lib("lib/founder/queries.ts"));

const row = (title: string) => store.founder_items.find((r) => r.title === title)!;
const ranks = (date = DAY) => store.founder_items.filter((r) => r.owner_id === ME && r.focus_date === date).sort((a, b) => Number(a.focus_rank) - Number(b.focus_rank)).map((r) => [r.title, r.focus_rank]);
const base = (o: Row): Row => ({ kind: "task", priority: "medium", notes: null, due_at: null, starts_at: null, ends_at: null, completed_at: null, deal_id: null, focus_date: null, focus_rank: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", ...o });

beforeEach(() => {
  clock = 0;
  caller = ME;
  focusMissing = false;
  store = {
    founder_deals: [],
    founder_items: [
      base({ id: "a", owner_id: ME, title: "Ship pricing page" }),
      base({ id: "b", owner_id: ME, title: "Call Dana" , kind: "follow_up" }),
      base({ id: "c", owner_id: ME, title: "File taxes", kind: "deadline", due_at: "2026-10-12T05:59:00.000Z" }),
      base({ id: "d", owner_id: ME, title: "Hire", due_at: "2026-10-09T16:00:00.000Z" }),
      base({ id: "m", owner_id: ME, title: "Demo", kind: "meeting", starts_at: "2026-10-09T16:00:00.000Z", ends_at: "2026-10-09T17:30:00.000Z" }),
      base({ id: "done", owner_id: ME, title: "Old", completed_at: "2026-10-08T00:00:00Z" }),
      base({ id: "theirs", owner_id: OTHER, title: "Their task" }),
    ],
  };
});

test("set up to three priorities, in order; events and finished items refused; setting twice is a no-op", async () => {
  assert.deepEqual(await actions.setFounderPriority("a", DAY), { ok: true, id: "a" });
  assert.deepEqual(await actions.setFounderPriority("b", DAY), { ok: true, id: "b" });
  assert.deepEqual(await actions.setFounderPriority("a", DAY), { ok: true, id: "a" });
  assert.deepEqual(await actions.setFounderPriority("c", DAY), { ok: true, id: "c" });
  assert.deepEqual(ranks(), [["Ship pricing page", 1], ["Call Dana", 2], ["File taxes", 3]]);
  assert.match((await actions.setFounderPriority("d", DAY) as { error: string }).error, /at most 3 priorities/);
  assert.match((await actions.setFounderPriority("m", "2026-10-10") as { error: string }).error, /Meetings and events can't be priorities/);
  assert.match((await actions.setFounderPriority("done", "2026-10-10") as { error: string }).error, /already complete/);
  assert.match((await actions.setFounderPriority("a", "2026-13-01") as { error: string }).error, /valid day/);
  assert.deepEqual(await actions.setFounderPriority("d", "2026-10-10"), { ok: true, id: "d" }, "another day has its own three");
});

test("reorder, complete and remove (the item is kept, the order closes up)", async () => {
  for (const id of ["a", "b", "c"]) await actions.setFounderPriority(id, DAY);
  assert.equal((await actions.moveFounderPriority("c", "up")).ok, true);
  assert.deepEqual(ranks(), [["Ship pricing page", 1], ["File taxes", 2], ["Call Dana", 3]]);
  assert.equal((await actions.moveFounderPriority("a", "up")).ok, true, "already first: no-op");
  assert.equal((await actions.moveFounderPriority("a", "down")).ok, true);
  assert.deepEqual(ranks(), [["File taxes", 1], ["Ship pricing page", 2], ["Call Dana", 3]]);
  assert.equal((await actions.setFounderItemCompleted("a", true)).ok, true);
  assert.ok(row("Ship pricing page").completed_at, "completing a priority completes the item");
  assert.equal((await actions.removeFounderPriority("c")).ok, true);
  assert.deepEqual(ranks(), [["Ship pricing page", 1], ["Call Dana", 2]]);
  assert.ok(store.founder_items.some((r) => r.id === "c"), "removing a priority keeps the item");
  assert.equal(row("File taxes").focus_date, null);
});

test("add a new priority by title: a task due that day, marked - and a double submit creates one", async () => {
  const clientId = "9d2a8f0e-4b1c-4e7a-9a3b-1c2d3e4f5a6b";
  assert.deepEqual(await actions.addFounderPriority({ title: "Close Acme", date: DAY, clientId }), { ok: true, id: clientId });
  assert.deepEqual(await actions.addFounderPriority({ title: "Close Acme", date: DAY, clientId }), { ok: true, id: clientId });
  assert.equal(store.founder_items.filter((r) => r.title === "Close Acme").length, 1);
  const created = row("Close Acme");
  assert.deepEqual([created.owner_id, created.kind, created.priority, created.focus_date, created.focus_rank], [ME, "task", "high", DAY, 1]);
  assert.equal(created.due_at, "2026-10-10T05:59:00.000Z", "due by the end of that local day");
  assert.equal((await actions.addFounderPriority({ title: "  ", date: DAY })).ok, false, "a title is required");
  for (const id of ["a", "b"]) await actions.setFounderPriority(id, DAY);
  const before = store.founder_items.length;
  assert.match((await actions.addFounderPriority({ title: "Fourth", date: DAY }) as { error: string }).error, /at most 3/);
  assert.equal(store.founder_items.length, before, "a full day creates nothing");
});

test("isolation: another founder's item can't be marked, moved, reordered or unmarked; a non-founder is refused everywhere", async () => {
  const before = JSON.stringify(store);
  assert.deepEqual(await actions.setFounderPriority("theirs", DAY), { ok: false, error: "That item could not be found." });
  assert.deepEqual(await actions.moveFounderItemToDay("theirs", "2026-10-10"), { ok: false, error: "That item could not be found." });
  assert.deepEqual(await actions.removeFounderPriority("theirs"), { ok: false, error: "That item could not be found." });
  assert.equal((await actions.moveFounderPriority("theirs", "up")).ok, false);
  assert.equal(JSON.stringify(store), before);
  // Their priorities don't count against mine, and mine aren't returned to them.
  store.founder_items.push(base({ id: "t1", owner_id: OTHER, title: "T1", focus_date: DAY, focus_rank: 1 }), base({ id: "t2", owner_id: OTHER, title: "T2", focus_date: DAY, focus_rank: 2 }), base({ id: "t3", owner_id: OTHER, title: "T3", focus_date: DAY, focus_rank: 3 }));
  assert.equal((await actions.setFounderPriority("a", DAY)).ok, true);
  const loaded = await getFounderFocus(db, ME, DAY, DAY);
  assert.ok(loaded.ok);
  assert.deepEqual(loaded.data.focus.map((f: { itemId: string }) => f.itemId), ["a"]);

  caller = null;
  const refused = { ok: false, error: "The Founder Command Center isn't available for this account." };
  for (const result of [
    await actions.setFounderPriority("a", DAY),
    await actions.addFounderPriority({ title: "x", date: DAY }),
    await actions.removeFounderPriority("a"),
    await actions.moveFounderPriority("a", "down"),
    await actions.moveFounderItemToDay("a", DAY),
    await actions.quickCaptureFounderItem("x"),
  ]) {
    assert.deepEqual(result, refused);
  }
});

test("quick capture: title required, optional due date (end of that local day), duplicate-safe", async () => {
  assert.equal((await actions.quickCaptureFounderItem("   ")).ok, false);
  assert.equal((await actions.quickCaptureFounderItem("Pay invoice", { dueDate: "2026-02-30" })).ok, false, "invalid date refused");
  const clientId = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
  assert.deepEqual(await actions.quickCaptureFounderItem("Pay invoice", { dueDate: "2026-10-12", clientId }), { ok: true, id: clientId });
  assert.deepEqual(await actions.quickCaptureFounderItem("Pay invoice", { dueDate: "2026-10-12", clientId }), { ok: true, id: clientId });
  assert.equal(store.founder_items.filter((r) => r.title === "Pay invoice").length, 1, "a double submit creates one");
  assert.deepEqual([row("Pay invoice").owner_id, row("Pay invoice").due_at], [ME, "2026-10-13T05:59:00.000Z"]);
  assert.equal((await actions.quickCaptureFounderItem("Undated idea")).ok, true);
  assert.equal(row("Undated idea").due_at, null);
});

test("move to another day: keeps the local time (and end-of-day, and event length); refuses stale or finished items", async () => {
  // "Hire" is due 10:00am Oct 9 local; "File taxes" is end of day Oct 11.
  assert.equal((await actions.moveFounderItemToDay("d", "2026-11-02", "2026-10-01T00:00:00Z")).ok, true);
  assert.equal(row("Hire").due_at, "2026-11-02T17:00:00.000Z", "10:00am local, now in MST (UTC-7)");
  assert.equal((await actions.moveFounderItemToDay("c", "2026-10-13")).ok, true);
  assert.equal(row("File taxes").due_at, "2026-10-14T05:59:00.000Z", "still end of day");
  assert.equal((await actions.moveFounderItemToDay("m", "2026-10-10")).ok, true);
  assert.deepEqual([row("Demo").starts_at, row("Demo").ends_at], ["2026-10-10T16:00:00.000Z", "2026-10-10T17:30:00.000Z"], "same local time and length");
  const stale = await actions.moveFounderItemToDay("a", "2026-10-10", "2025-01-01T00:00:00Z");
  assert.match((stale as { error: string }).error, /changed since you opened it/);
  assert.equal(row("Ship pricing page").due_at, null, "nothing moved");
  assert.match((await actions.moveFounderItemToDay("done", "2026-10-10") as { error: string }).error, /already complete/);
  assert.match((await actions.moveFounderItemToDay("a", "tomorrow") as { error: string }).error, /valid day/);
});

test("without the daily-focus columns: priorities read as unavailable, writes say why, everything else still works", async () => {
  focusMissing = true;
  const loaded = await getFounderFocus(db, ME, DAY, DAY);
  assert.deepEqual(loaded, { ok: true, data: { available: false, focus: [] } });
  const expected = { ok: false, error: "Daily priorities need a database update (founder_daily_focus.sql) before they can be saved." };
  assert.deepEqual(await actions.setFounderPriority("a", DAY), expected);
  assert.deepEqual(await actions.addFounderPriority({ title: "x", date: DAY }), expected);
  assert.equal((await actions.quickCaptureFounderItem("Still works")).ok, true);
  assert.equal((await actions.moveFounderItemToDay("d", "2026-10-10")).ok, true);
});

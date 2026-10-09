/**
 * Founder calendar items, end to end through the REAL server actions and the
 * REAL calendar read (lib/founder/queries.ts getFounderCalendarItems):
 * creating and editing every item type, validation, completing,
 * rescheduling, stale-edit protection, duplicate-safe creates, deal links
 * (and rejecting another founder's deal), owner isolation, and loading a
 * range including undated tasks and failures.
 *
 * The in-memory store mirrors the database where it matters: updated_at
 * changes on every write (the founder_items updated_at trigger), a reused
 * primary key fails with 23505, and founder_items_guard's same-owner deal
 * rule is enforced. RLS itself is proven by
 * supabase/pending/scratch/validate-founder-command-center.mjs.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test app/founder/calendar-items.test.ts
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
let store: Record<string, Row[]> = {};
let clock = 0;
let caller: string | null = ME;
let failTable: string | null = null;
const stamp = () => new Date(Date.UTC(2026, 9, 9, 12, 0, 0, ++clock)).toISOString();

class Query {
  private filters: ((row: Row) => boolean)[] = [];
  private patch: Row | null = null;
  private insertRows: Row[] | null = null;
  private deleting = false;
  private sorts: { column: string; ascending: boolean }[] = [];
  private max: number | null = null;
  private one = false;
  private table: string;
  constructor(table: string) {
    this.table = table;
  }
  select() { return this; }
  eq(column: string, value: unknown) { this.filters.push((row) => row[column] === value); return this; }
  is(column: string, value: unknown) { this.filters.push((row) => (row[column] ?? null) === value); return this; }
  not(column: string, _op: string, value: unknown) { this.filters.push((row) => (row[column] ?? null) !== value); return this; }
  gte(column: string, value: string) { this.filters.push((row) => row[column] != null && String(row[column]) >= value); return this; }
  lt(column: string, value: string) { this.filters.push((row) => row[column] != null && String(row[column]) < value); return this; }
  order(column: string, options?: { ascending?: boolean }) { this.sorts.push({ column, ascending: options?.ascending !== false }); return this; }
  limit(n: number) { this.max = n; return this; }
  update(values: Row) { this.patch = values; return this; }
  insert(values: Row | Row[]) { this.insertRows = Array.isArray(values) ? values : [values]; return this; }
  delete() { this.deleting = true; return this; }
  single() { this.one = true; return this.run(); }
  maybeSingle() { this.one = true; return this.run(); }
  then<T>(resolve: (value: { data: unknown; error: unknown }) => T, reject?: (reason: unknown) => T) { return this.run().then(resolve, reject); }
  /** founder_items_guard: a linked deal must belong to the same founder. */
  private guard(row: Row): string | null {
    if (this.table !== "founder_items" || !row.deal_id) return null;
    return (store.founder_deals ?? []).some((d) => d.id === row.deal_id && d.owner_id === row.owner_id) ? null : "linked deal must belong to the same founder";
  }
  private async run(): Promise<{ data: unknown; error: unknown }> {
    if (failTable === this.table) return { data: null, error: { message: "boom" } };
    const table = (store[this.table] ??= []);
    if (this.insertRows) {
      const row: Row = { id: `id-${++clock}`, completed_at: null, created_at: stamp(), ...this.insertRows[0] };
      row.updated_at = stamp();
      if (table.some((r) => r.id === row.id)) return { data: null, error: { code: "23505", message: "duplicate key" } };
      const blocked = this.guard(row);
      if (blocked) return { data: null, error: { message: blocked } };
      table.push(row);
      return { data: { ...row }, error: null };
    }
    let rows = table.filter((row) => this.filters.every((f) => f(row)));
    if (this.patch) {
      for (const row of rows) {
        const blocked = this.guard({ ...row, ...this.patch });
        if (blocked) return { data: null, error: { message: blocked } };
      }
      for (const row of rows) Object.assign(row, this.patch, { updated_at: stamp() });
    }
    if (this.deleting) store[this.table] = table.filter((row) => !rows.includes(row));
    for (const { column, ascending } of [...this.sorts].reverse()) rows = [...rows].sort((a, b) => String(a[column] ?? "").localeCompare(String(b[column] ?? "")) * (ascending ? 1 : -1));
    if (this.max !== null) rows = rows.slice(0, this.max);
    return { data: this.one ? (rows[0] ? { ...rows[0] } : null) : rows.map((r) => ({ ...r })), error: null };
  }
}
const db = { from: (table: string) => new Query(table) };

mock.module(lib("lib/founder/access.ts"), {
  namedExports: { getFounderContext: async () => (caller ? { supabase: db, userId: caller, email: "f@example.com", timeZone: TZ } : null) },
});
mock.module("next/cache", { namedExports: { revalidatePath: () => undefined } });

const actions = await import(lib("app/founder/actions.ts"));
const { getFounderCalendarItems, toItem } = await import(lib("lib/founder/queries.ts"));
const { calendarRange, placeItems, isAllDayEvent } = await import(lib("lib/founder/calendar.ts"));

const item = (title: string) => store.founder_items.find((r) => r.title === title)!;

beforeEach(() => {
  clock = 0;
  caller = ME;
  failTable = null;
  store = {
    founder_deals: [
      { id: "deal-mine", owner_id: ME, name: "Acme Roofing", stage: "negotiation" },
      { id: "deal-won", owner_id: ME, name: "Birch Co", stage: "won" },
      { id: "deal-theirs", owner_id: OTHER, name: "Their deal", stage: "lead" },
    ],
    founder_items: [{ id: "item-theirs", owner_id: OTHER, kind: "meeting", title: "Their meeting", priority: "medium", starts_at: "2026-10-09T16:00:00.000Z", ends_at: null, due_at: null, completed_at: null, deal_id: null, notes: "private", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" }],
  };
});

test("creates every type with the right times, in the founder's zone", async () => {
  const ok = { ok: true };
  assert.deepEqual({ ok: (await actions.createFounderItem({ kind: "task", title: "Send proposal", priority: "high", dueDate: "2026-10-09", dueTime: "17:00", dealId: "deal-mine" })).ok }, ok);
  assert.equal((await actions.createFounderItem({ kind: "follow_up", title: "Call Dana", dueDate: "2026-10-10", dueTime: "" })).ok, true);
  assert.equal((await actions.createFounderItem({ kind: "deadline", title: "Taxes", dueDate: "2026-10-15" })).ok, true);
  assert.equal((await actions.createFounderItem({ kind: "meeting", title: "Demo", startsAt: "2026-10-09T10:00", endsAt: "2026-10-09T11:00" })).ok, true);
  assert.equal((await actions.createFounderItem({ kind: "event", title: "Offsite", allDay: "on", startDate: "2026-10-12", endDate: "2026-10-13" })).ok, true);
  assert.equal((await actions.createFounderItem({ kind: "task", title: "Someday" })).ok, true);

  assert.deepEqual([item("Send proposal").due_at, item("Send proposal").deal_id, item("Send proposal").owner_id], ["2026-10-09T23:00:00.000Z", "deal-mine", ME]);
  assert.equal(item("Call Dana").due_at, "2026-10-11T05:59:00.000Z", "no time = end of that local day");
  assert.deepEqual([item("Demo").starts_at, item("Demo").ends_at, item("Demo").due_at], ["2026-10-09T16:00:00.000Z", "2026-10-09T17:00:00.000Z", null]);
  assert.deepEqual([item("Offsite").starts_at, item("Offsite").ends_at], ["2026-10-12T06:00:00.000Z", "2026-10-14T06:00:00.000Z"]);
  assert.equal(isAllDayEvent(toItem(item("Offsite")), TZ), true);
  assert.deepEqual([item("Someday").due_at, item("Someday").starts_at], [null, null]);
});

test("validation: required title and start, end after start, valid dates and times - nothing written", async () => {
  const before = store.founder_items.length;
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ kind: "task", title: "  " }, /title/],
    [{ kind: "meeting", title: "Demo" }, /start time/],
    [{ kind: "meeting", title: "Demo", startsAt: "2026-10-09T11:00", endsAt: "2026-10-09T10:00" }, /end must be after the start/],
    [{ kind: "meeting", title: "Demo", startsAt: "2026-10-09T11:00", endsAt: "2026-10-09T11:00" }, /end must be after the start/],
    [{ kind: "event", title: "Trip", allDay: "on", startDate: "2026-10-13", endDate: "2026-10-12" }, /end day/],
    [{ kind: "task", title: "Call", dueDate: "", dueTime: "09:00" }, /due date for that time/],
    [{ kind: "task", title: "Call", dueDate: "2026-10-09", dueTime: "25:00" }, /valid due time/],
    [{ kind: "task", title: "Call", dueDate: "2026-02-30" }, /valid date/],
    [{ kind: "appointment", title: "Call" }, /valid type/],
  ];
  for (const [fields, message] of cases) {
    const result = await actions.createFounderItem(fields);
    assert.equal(result.ok, false, JSON.stringify(fields));
    assert.match((result as { error: string }).error, message);
  }
  assert.equal(store.founder_items.length, before);
});

test("a double submit with the same client id creates one item", async () => {
  const clientId = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
  const first = await actions.createFounderItem({ kind: "meeting", title: "Demo", startsAt: "2026-10-09T10:00", clientId });
  const second = await actions.createFounderItem({ kind: "meeting", title: "Demo", startsAt: "2026-10-09T10:00", clientId });
  assert.deepEqual(first, { ok: true, id: clientId });
  assert.deepEqual(second, { ok: true, id: clientId });
  assert.equal(store.founder_items.filter((r) => r.title === "Demo").length, 1);
  // Another founder's id can't be claimed or read through a client id.
  const claim = await actions.createFounderItem({ kind: "task", title: "Mine", clientId: "item-theirs" });
  assert.equal(claim.ok, true, "a non-UUID client id is ignored, the server picks the id");
  assert.equal(item("Their meeting").title, "Their meeting");
});

test("complete, reopen, and complete through the edit form (keeping the first completion time)", async () => {
  await actions.createFounderItem({ kind: "task", title: "Invoice", dueDate: "2026-10-09" });
  const row = item("Invoice");
  assert.equal((await actions.setFounderItemCompleted(row.id as string, true)).ok, true);
  const completedAt = row.completed_at;
  assert.ok(completedAt);
  const edit = await actions.updateFounderItem(row.id as string, { kind: "task", title: "Invoice", dueDate: "2026-10-09", completed: true, expectedUpdatedAt: row.updated_at });
  assert.equal(edit.ok, true);
  assert.equal(row.completed_at, completedAt, "still completed at the original time");
  assert.equal((await actions.updateFounderItem(row.id as string, { kind: "task", title: "Invoice", dueDate: "2026-10-09", completed: false, expectedUpdatedAt: row.updated_at })).ok, true);
  assert.equal(row.completed_at, null, "reopened");
  assert.equal((await actions.updateFounderItem(row.id as string, { kind: "task", title: "Invoice renamed", dueDate: "2026-10-09" })).ok, true);
  assert.equal(row.completed_at, null, "a form without the completion field leaves it alone");
});

test("reschedule through edit; a stale edit (opened before another change) is refused, not lost", async () => {
  await actions.createFounderItem({ kind: "meeting", title: "Demo", startsAt: "2026-10-09T10:00", endsAt: "2026-10-09T11:00" });
  const row = item("Demo");
  const openedAt = row.updated_at as string;
  const moved = await actions.updateFounderItem(row.id as string, { kind: "meeting", title: "Demo", startsAt: "2026-10-10T14:00", endsAt: "2026-10-10T15:00", expectedUpdatedAt: openedAt });
  assert.equal(moved.ok, true);
  assert.deepEqual([row.starts_at, row.ends_at], ["2026-10-10T20:00:00.000Z", "2026-10-10T21:00:00.000Z"]);
  const stale = await actions.updateFounderItem(row.id as string, { kind: "meeting", title: "Old tab", startsAt: "2026-10-09T10:00", expectedUpdatedAt: openedAt });
  assert.equal(stale.ok, false);
  assert.match((stale as { error: string }).error, /changed since you opened it/);
  assert.equal(row.title, "Demo", "the newer change survives");
  assert.equal((await actions.updateFounderItem(row.id as string, { kind: "meeting", title: "Demo", startsAt: "2026-10-10T14:00", endsAt: "2026-10-10T13:00", expectedUpdatedAt: row.updated_at })).ok, false, "rescheduling still validates the range");
});

test("deal links: shown and preserved (closed deals too); another founder's deal is rejected on create and edit", async () => {
  await actions.createFounderItem({ kind: "follow_up", title: "Check in", dueDate: "2026-10-12", dealId: "deal-won" });
  assert.equal(item("Check in").deal_id, "deal-won", "a closed deal can still be linked when chosen");
  const before = JSON.stringify(store);
  assert.deepEqual(await actions.createFounderItem({ kind: "follow_up", title: "Sneaky", dealId: "deal-theirs" }), { ok: false, error: "That deal could not be found." });
  const row = item("Check in");
  assert.deepEqual(await actions.updateFounderItem(row.id as string, { kind: "follow_up", title: "Check in", dealId: "deal-theirs" }), { ok: false, error: "That deal could not be found." });
  assert.equal(JSON.stringify(store), before);
  // Even if the action's check were bypassed, the database guard refuses the link (as on TEST).
  assert.ok((await db.from("founder_items").update({ deal_id: "deal-theirs" }).eq("id", row.id)).error);
});

test("isolation: a founder can't see, edit, complete or delete another founder's items; a non-founder gets nothing", async () => {
  const theirs = item("Their meeting");
  const snapshot = JSON.stringify(theirs);
  assert.deepEqual(await actions.updateFounderItem("item-theirs", { kind: "meeting", title: "Mine now", startsAt: "2026-10-09T10:00" }), { ok: false, error: "That item could not be found." });
  assert.deepEqual(await actions.setFounderItemCompleted("item-theirs", true), { ok: false, error: "That item could not be found." });
  assert.deepEqual(await actions.deleteFounderItem("item-theirs"), { ok: false, error: "That item could not be found." });
  assert.equal(JSON.stringify(item("Their meeting")), snapshot);
  const range = calendarRange("month", "2026-10-09", TZ);
  const loaded = await getFounderCalendarItems(db, ME, range.start, range.end);
  assert.ok(loaded.ok);
  assert.equal(loaded.data.inRange.some((i: { id: string }) => i.id === "item-theirs"), false);
  caller = null;
  assert.equal((await actions.createFounderItem({ kind: "task", title: "x" })).ok, false);
  assert.equal((await actions.updateFounderItem(theirs.id as string, { kind: "task", title: "x" })).ok, false);
});

test("loading a range: overlapping and multi-day events, due items, undated open tasks; completed undated tasks drop off; failures surface", async () => {
  await actions.createFounderItem({ kind: "event", title: "Conference", startsAt: "2026-09-29T09:00", endsAt: "2026-10-02T17:00" }); // starts before the week
  await actions.createFounderItem({ kind: "meeting", title: "Demo", startsAt: "2026-10-05T10:00" });
  await actions.createFounderItem({ kind: "deadline", title: "Taxes", dueDate: "2026-10-03" });
  await actions.createFounderItem({ kind: "meeting", title: "Next week", startsAt: "2026-10-12T10:00" });
  await actions.createFounderItem({ kind: "event", title: "Ended earlier", startsAt: "2026-09-20T09:00", endsAt: "2026-09-21T09:00" });
  await actions.createFounderItem({ kind: "task", title: "Undated" });
  await actions.createFounderItem({ kind: "task", title: "Undated done" });
  await actions.setFounderItemCompleted(item("Undated done").id as string, true);

  const week = calendarRange("week", "2026-10-01", TZ); // Sep 27 - Oct 3
  const loaded = await getFounderCalendarItems(db, ME, week.start, week.end);
  assert.ok(loaded.ok);
  assert.deepEqual(loaded.data.inRange.map((i: { title: string }) => i.title).sort(), ["Conference", "Taxes"]);
  assert.deepEqual(loaded.data.unscheduled.map((i: { title: string }) => i.title), ["Undated"], "undated open tasks are always returned, separately");
  const placed = placeItems(loaded.data.inRange, week.days, TZ);
  assert.deepEqual(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"].map((d) => placed.get(d)!.length), [1, 1, 1, 1], "a multi-day event spans each day");
  assert.equal(placed.get("2026-10-03")!.map((e: { item: { title: string } }) => e.item.title).join(), "Taxes");

  failTable = "founder_items";
  assert.deepEqual(await getFounderCalendarItems(db, ME, week.start, week.end), { ok: false }, "an error is an error, never an empty calendar");
});

/**
 * QA: estimate duplicate protection under CONCURRENT submissions (two
 * requests in flight at once - a double-click on a slow connection), not
 * only sequential repeats. Runs the REAL createEstimate server action
 * against an in-memory store whose every query yields to the event loop, so
 * two submissions interleave the way two server requests do. Nothing reaches
 * a real database.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test lib/estimates/estimate-concurrency.test.ts
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;

type Row = Record<string, unknown>;
const ORG = "org-1";
const CONTACT = "contact-1";

let store: Record<string, Row[]> = {};
let ids = 0;
const tick = () => new Promise((resolve) => setImmediate(resolve));

class Query {
  private filters: ((row: Row) => boolean)[] = [];
  private updateValues: Row | null = null;
  private insertRows: Row[] | null = null;
  private deleting = false;
  private sorts: { column: string; ascending: boolean }[] = [];
  private max: number | null = null;
  private singleRow = false;
  private table: string;
  constructor(table: string) {
    this.table = table;
  }
  select() { return this; }
  eq(column: string, value: unknown) { this.filters.push((row) => row[column] === value); return this; }
  neq(column: string, value: unknown) { this.filters.push((row) => row[column] !== value); return this; }
  in(column: string, values: unknown[]) { this.filters.push((row) => values.includes(row[column])); return this; }
  gte(column: string, value: string) { this.filters.push((row) => String(row[column]) >= value); return this; }
  order(column: string, options?: { ascending?: boolean }) { this.sorts.push({ column, ascending: options?.ascending !== false }); return this; }
  limit(n: number) { this.max = n; return this; }
  update(values: Row) { this.updateValues = values; return this; }
  insert(values: Row | Row[]) { this.insertRows = Array.isArray(values) ? values : [values]; return this; }
  delete() { this.deleting = true; return this; }
  single() { return this.maybeSingle(); }
  maybeSingle() { this.singleRow = true; return this.run(); }
  then<T>(resolve: (value: { data: unknown; error: null }) => T, reject?: (reason: unknown) => T) { return this.run().then(resolve, reject); }
  private async run() {
    await tick(); // every round trip yields - concurrent requests interleave here
    const table = (store[this.table] ??= []);
    if (this.insertRows) {
      // created_at is the server's clock at insert time, as in Postgres
      const inserted = this.insertRows.map((row) => ({ id: `est-${String(++ids).padStart(3, "0")}`, created_at: new Date(Date.now() + ids).toISOString(), ...row }));
      table.push(...inserted);
      return { data: this.singleRow ? { ...inserted[0] } : inserted.map((r) => ({ ...r })), error: null };
    }
    let rows = table.filter((row) => this.filters.every((f) => f(row)));
    if (this.deleting) {
      store[this.table] = table.filter((row) => !rows.includes(row));
      return { data: rows.map((r) => ({ ...r })), error: null };
    }
    if (this.updateValues) for (const row of rows) Object.assign(row, this.updateValues);
    if (this.sorts.length) {
      rows = [...rows].sort((a, b) => {
        for (const { column, ascending } of this.sorts) {
          if (a[column] === b[column]) continue;
          return (String(a[column]) < String(b[column]) ? -1 : 1) * (ascending ? 1 : -1);
        }
        return 0;
      });
    }
    if (this.max !== null) rows = rows.slice(0, this.max);
    const copy = rows.map((r) => ({ ...r }));
    return { data: this.singleRow ? (copy[0] ?? null) : copy, error: null };
  }
}
const supabase = { from: (table: string) => new Query(table), auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) } };

mock.module("next/cache", { namedExports: { revalidatePath: () => undefined } });
mock.module("next/headers", { namedExports: { headers: async () => new Headers() } });
mock.module("next/navigation", { namedExports: { redirect: () => { throw new Error("redirect"); } } });
mock.module(lib("lib/supabase/server.ts"), { namedExports: { createClient: async () => supabase } });
mock.module(lib("lib/supabase/service.ts"), { namedExports: { createServiceRoleClient: () => supabase } });
mock.module(lib("lib/auth/organization.ts"), { namedExports: { getUserOrganization: async () => ({ organizationId: ORG }) } });

const { createEstimate, cancelEstimate } = await import(lib("app/(app)/estimates/actions.ts"));

const FORM = { contactId: CONTACT, leadId: "lead-1", title: "Roof replacement – architectural shingles (TEST)", amount: "14850", notes: "TEST scope", expiresAt: "2026-11-04" };
function form(overrides: Partial<typeof FORM> = {}) {
  const data = new FormData();
  for (const [key, value] of Object.entries({ ...FORM, ...overrides })) data.set(key, value);
  return data;
}
const create = (overrides: Partial<typeof FORM> = {}) => createEstimate({}, form(overrides));
const estimates = () => store.estimates ?? [];

beforeEach(() => {
  store = { contacts: [{ id: CONTACT, organization_id: ORG }], estimates: [] };
  ids = 0;
});

test("two identical submissions in flight at the same time -> exactly one estimate, and both requests resolve to it", async () => {
  const [a, b] = await Promise.all([create(), create()]);
  assert.equal(a.success, true);
  assert.equal(b.success, true);
  assert.equal(estimates().length, 1, "the concurrent duplicate is not kept");
  assert.equal(a.id, estimates()[0].id);
  assert.equal(b.id, estimates()[0].id, "both submissions point at the surviving estimate");
});

test("three concurrent identical submissions still converge on one estimate", async () => {
  const results = await Promise.all([create(), create(), create()]);
  assert.equal(estimates().length, 1);
  assert.deepEqual(new Set(results.map((r) => r.id)), new Set([estimates()[0].id]));
});

test("concurrent submissions with DIFFERENT details are both kept - only true duplicates are collapsed", async () => {
  const [a, b] = await Promise.all([create(), create({ amount: "15200" })]);
  assert.equal(estimates().length, 2);
  assert.notEqual(a.id, b.id);
});

test("an identical draft that was already SENT is never removed by a new submission's reconciliation", async () => {
  store.estimates!.push({ id: "sent-1", organization_id: ORG, contact_id: CONTACT, lead_id: "lead-1", title: FORM.title, amount: 14850, notes: FORM.notes, expires_at: "2026-11-04T23:59:59.999Z", status: "sent", created_at: new Date(Date.now() - 1000).toISOString() });
  const result = await create();
  assert.equal(result.success, true);
  assert.equal(estimates().length, 2, "a deliberate re-quote of a sent estimate is a new draft");
  assert.ok(estimates().some((e) => e.id === "sent-1" && e.status === "sent"));
});

test("cancelling an estimate records who cancelled it and from which status, exactly once", async () => {
  const created = await create();
  const audits = () => (store.audit_log ?? []).filter((row) => row.entity_id === created.id);

  const first = await cancelEstimate(created.id);
  assert.equal(first.ok, true);
  assert.equal(estimates()[0].status, "cancelled");
  assert.equal(audits().length, 1, "one audit row");
  assert.deepEqual(
    [audits()[0].organization_id, audits()[0].user_id, audits()[0].action, audits()[0].entity_type, audits()[0].metadata],
    [ORG, "user-1", "estimate_cancelled", "estimate", { from_status: "draft", to_status: "cancelled" }],
  );

  const again = await cancelEstimate(created.id);
  assert.equal(again.ok, false, "a repeated cancel is refused");
  assert.equal(audits().length, 1, "and records nothing");
});

test("an accepted estimate cannot be cancelled, and the refused attempt is not audited", async () => {
  store.estimates!.push({ id: "acc-1", organization_id: ORG, contact_id: CONTACT, status: "accepted", created_at: new Date().toISOString() });
  const result = await cancelEstimate("acc-1");
  assert.equal(result.ok, false);
  assert.equal(store.estimates!.find((e) => e.id === "acc-1")?.status, "accepted");
  assert.equal((store.audit_log ?? []).length, 0);
});

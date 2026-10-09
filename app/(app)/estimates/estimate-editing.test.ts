/**
 * Estimate editing end to end: Scope of Work and Terms from the Create /
 * Edit Estimate form, line items and their totals, reloading what was saved,
 * what the customer's quote receives, and that a sent quote can't be changed.
 *
 * Runs the REAL createEstimate / updateEstimate / sendEstimate, the REAL
 * line-item actions, getEstimateDetails and the public loader against an
 * in-memory store that also enforces the database's draft-only line-item
 * guard (estimate_line_items_guard, verified on TEST). Delivery and
 * automation emitters are mocked; nothing reaches TEST, Production or SMS.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test "app/(app)/estimates/estimate-editing.test.ts"
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
/** Simulates a database without the scope/terms columns (estimate_quote_details not applied). */
let textColumnsMissing = false;

class Query {
  private filters: ((row: Row) => boolean)[] = [];
  private patch: Row | null = null;
  private insertRows: Row[] | null = null;
  private deleting = false;
  private columns = "*";
  private sortBy: { column: string; ascending: boolean }[] = [];
  private max: number | null = null;
  private one = false;
  private table: string;
  constructor(table: string) {
    this.table = table;
  }
  select(columns = "*") { this.columns = columns; return this; }
  eq(column: string, value: unknown) { this.filters.push((row) => row[column] === value); return this; }
  in(column: string, values: unknown[]) { this.filters.push((row) => values.includes(row[column])); return this; }
  is(column: string, value: unknown) { this.filters.push((row) => (row[column] ?? null) === value); return this; }
  gte(column: string, value: string) { this.filters.push((row) => String(row[column]) >= value); return this; }
  order(column: string, options?: { ascending?: boolean }) { this.sortBy.push({ column, ascending: options?.ascending !== false }); return this; }
  limit(n: number) { this.max = n; return this; }
  update(values: Row) { this.patch = values; return this; }
  insert(values: Row | Row[]) { this.insertRows = Array.isArray(values) ? values : [values]; return this; }
  delete() { this.deleting = true; return this; }
  single() { this.one = true; return this.run(); }
  maybeSingle() { this.one = true; return this.run(); }
  then<T>(resolve: (value: { data: unknown; error: unknown }) => T, reject?: (reason: unknown) => T) { return this.run().then(resolve, reject); }
  private fail(message: string) { return { data: null, error: { message } }; }
  /** estimate_line_items_guard: items change only while their estimate is a draft of the same organization. */
  private guard(item: Row): string | null {
    const estimate = (store.estimates ?? []).find((e) => e.id === item.estimate_id);
    if (!estimate) return "estimate not found";
    if (estimate.organization_id !== item.organization_id) return "line item organization_id must match its estimate";
    if (estimate.status !== "draft") return "line items can only change while the estimate is a draft";
    return null;
  }
  private async run(): Promise<{ data: unknown; error: unknown }> {
    const touchesText = /scope_of_work|terms/.test(this.columns + JSON.stringify(this.patch ?? {}) + JSON.stringify(this.insertRows ?? []));
    if (this.table === "estimates" && textColumnsMissing && touchesText) return this.fail('column "scope_of_work" does not exist');
    const table = (store[this.table] ??= []);
    if (this.insertRows) {
      const inserted = this.insertRows.map((row) => ({
        id: `id-${++ids}`,
        created_at: new Date(Date.UTC(2026, 9, 9, 12, 0, ids)).toISOString(),
        ...(this.table === "estimates" ? { number: table.filter((e) => e.organization_id === row.organization_id).length + 1, scope_of_work: null, terms: null } : {}),
        ...row,
      }));
      if (this.table === "estimate_line_items") for (const row of inserted) { const error = this.guard(row); if (error) return this.fail(error); }
      table.push(...inserted);
      return { data: this.one ? { ...inserted[0] } : inserted, error: null };
    }
    let rows = table.filter((row) => this.filters.every((f) => f(row)));
    if (this.table === "estimate_line_items" && (this.patch || this.deleting)) for (const row of rows) { const error = this.guard(row); if (error) return this.fail(error); }
    if (this.patch) for (const row of rows) Object.assign(row, this.patch);
    if (this.deleting) store[this.table] = table.filter((row) => !rows.includes(row));
    for (const { column, ascending } of [...this.sortBy].reverse()) rows = [...rows].sort((a, b) => (Number(a[column] ?? 0) - Number(b[column] ?? 0) || String(a[column]).localeCompare(String(b[column]))) * (ascending ? 1 : -1));
    if (this.max !== null) rows = rows.slice(0, this.max);
    const shaped = rows.map((row) => {
      const out: Row = { ...row };
      if (this.columns.includes("organization:organizations")) out.organization = (store.organizations ?? []).find((o) => o.id === row.organization_id) ?? null;
      if (this.columns.includes("contact:contacts")) out.contact = (store.contacts ?? []).find((c) => c.id === row.contact_id) ?? null;
      return out;
    });
    return { data: this.one ? (shaped[0] ?? null) : shaped, error: null };
  }
}
const db = { from: (table: string) => new Query(table), auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) } };

mock.module(lib("lib/supabase/server.ts"), { namedExports: { createClient: async () => db } });
mock.module(lib("lib/auth/organization.ts"), { namedExports: { getUserOrganization: async () => ({ organizationId: ORG, role: "owner" }) } });
mock.module("next/cache", { namedExports: { revalidatePath: () => undefined } });
mock.module("next/headers", { namedExports: { headers: async () => new Headers({ host: "preview.example" }) } });
mock.module("next/navigation", { namedExports: { redirect: (to: string) => { throw new Error(`redirect:${to}`); } } });
mock.module(lib("lib/automation/estimates.ts"), {
  namedExports: { emitEstimateSent: async () => undefined, emitEstimateLifecycleEvent: async () => undefined, emitEstimateLifecycleEventAsService: async () => undefined },
});
const realDelivery = await import(lib("lib/automation/estimate-delivery.ts"));
mock.module(lib("lib/automation/estimate-delivery.ts"), { namedExports: { ...realDelivery, deliverEstimateToCustomer: async () => ({ status: "skipped", reason: "duplicate" }) } });
mock.module(lib("lib/automation/jobs.ts"), { namedExports: { emitJobCreatedFromEstimate: async () => undefined, emitJobCreatedFromEstimateAsService: async () => undefined } });
mock.module(lib("lib/automation/events.ts"), { namedExports: { createAutomationEventAsService: async () => ({ ok: true }) } });

const actions = await import(lib("app/(app)/estimates/actions.ts"));
const lineItems = await import(lib("app/(app)/estimates/quote-details-actions.ts"));
const details = await import(lib("lib/estimates/details.ts"));
const { getEstimateByApprovalToken } = await import(lib("lib/estimates/approval.ts"));

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}
const BASE = { contactId: "contact-1", leadId: "", title: "Roof replacement", amount: "", notes: "Gate code 1234 - internal", expiresAt: "" };

beforeEach(() => {
  ids = 0;
  textColumnsMissing = false;
  store = {
    organizations: [{ id: ORG, name: "Ridgeline Roofing", sms_phone_number: "+12065550142", email: "office@ridgeline.example" }],
    contacts: [
      { id: "contact-1", organization_id: ORG, first_name: "Dana", last_name: "Price", company_name: null, phone: "+12065550199", email: "dana@example.com" },
      { id: "contact-x", organization_id: OTHER_ORG, first_name: "Other", last_name: "Org" },
    ],
    estimates: [],
    estimate_line_items: [],
  };
});

async function createDraft(extra: Record<string, string> = {}) {
  const result = await actions.createEstimate({}, form({ ...BASE, ...extra }));
  assert.equal(result.success, true, JSON.stringify(result));
  return store.estimates.find((e) => e.id === result.id)!;
}

test("create saves Scope of Work and Terms to the estimate's own columns; reload returns them; notes stay separate", async () => {
  const draft = await createDraft({ scopeOfWork: "  Tear off and replace the roof.  ", terms: "50% deposit, balance on completion." });
  assert.equal(draft.status, "draft");
  assert.equal(draft.scope_of_work, "Tear off and replace the roof.");
  assert.equal(draft.terms, "50% deposit, balance on completion.");
  assert.equal(draft.notes, "Gate code 1234 - internal");
  const reloaded = await details.getEstimateDetails(db, ORG, draft.id as string);
  assert.equal(reloaded.scopeOfWork, "Tear off and replace the roof.");
  assert.equal(reloaded.terms, "50% deposit, balance on completion.");
  assert.equal(reloaded.number, 1);
  assert.equal((await details.getEstimateDetails(db, OTHER_ORG, draft.id as string)).scopeOfWork, null, "another organization can't reload it");
});

test("create without scope/terms leaves them empty; over-long text is refused before anything is written", async () => {
  const draft = await createDraft();
  assert.equal(draft.scope_of_work, null);
  assert.equal(draft.terms, null);
  const before = store.estimates.length;
  const tooLong = await actions.createEstimate({}, form({ ...BASE, title: "Other", terms: "x".repeat(5001) }));
  assert.match(tooLong.error ?? "", /terms under 5000/);
  assert.equal(store.estimates.length, before);
});

test("editing a draft updates and clears scope/terms, keeps other fields, and the draft can be reopened and edited again", async () => {
  const draft = await createDraft({ scopeOfWork: "Old scope", terms: "Old terms" });
  const edit = (fields: Record<string, string>) => actions.updateEstimate({}, form({ ...BASE, id: draft.id as string, ...fields }));
  assert.deepEqual(await edit({ title: "Roof replacement v2", scopeOfWork: "New scope", terms: "" }), { success: true, id: draft.id });
  assert.equal(draft.title, "Roof replacement v2");
  assert.equal(draft.scope_of_work, "New scope");
  assert.equal(draft.terms, null, "clearing the field clears the column");
  assert.deepEqual(await edit({ title: "Roof replacement v3", scopeOfWork: "Final scope", terms: "Net 15" }), { success: true, id: draft.id });
  const reloaded = await details.getEstimateDetails(db, ORG, draft.id as string);
  assert.deepEqual([reloaded.scopeOfWork, reloaded.terms], ["Final scope", "Net 15"]);
  // A form without the fields (e.g. an older client) leaves them as they are.
  assert.deepEqual(await edit({ title: "Roof replacement v4" }), { success: true, id: draft.id });
  assert.equal(draft.scope_of_work, "Final scope");
});

test("line items: totals in cents, the estimate total follows the items on add, edit, remove, edit-form and send", async () => {
  const draft = await createDraft({ amount: "999" });
  const id = draft.id as string;
  assert.deepEqual(await lineItems.addEstimateLineItem(id, { description: "Tear-off", quantity: "24", unit: "sq", unitPrice: "95" }), { ok: true });
  assert.deepEqual(await lineItems.addEstimateLineItem(id, { description: "Drip edge", quantity: "3", unit: "", unitPrice: "0.10" }), { ok: true });
  assert.equal(draft.amount, 2280.3, "24 × 95 + 3 × 0.10, no float drift");
  const [first] = store.estimate_line_items;
  assert.deepEqual(await lineItems.updateEstimateLineItem(id, first.id as string, { description: "Tear-off", quantity: "30", unit: "sq", unitPrice: "95" }), { ok: true });
  assert.equal(draft.amount, 2850.3);
  // The Edit Estimate form can't set a different total while items exist.
  assert.equal((await actions.updateEstimate({}, form({ ...BASE, id, amount: "1" }))).success, true);
  assert.equal(draft.amount, 2850.3);
  const reloaded = await details.getEstimateDetails(db, ORG, id);
  assert.deepEqual(reloaded.lineItems.map((i: { description: string; quantity: number; unitPrice: number }) => [i.description, i.quantity, i.unitPrice]), [["Tear-off", 30, 95], ["Drip edge", 3, 0.1]]);
  assert.equal(details.lineItemsSubtotal(reloaded.lineItems), 2850.3);
  assert.equal(details.lineItemsMatchTotal(reloaded.lineItems, draft.amount as number), true);
  // Drift (e.g. a stale amount) is corrected in the same write that sends the quote.
  draft.amount = 5;
  assert.equal((await actions.sendEstimate(id)).ok, true);
  assert.equal(draft.status, "sent");
  assert.equal(draft.amount, 2850.3);
});

test("a sent quote is never silently altered: edit, scope/terms and every line-item change are refused and nothing changes", async () => {
  const draft = await createDraft({ scopeOfWork: "Sent scope", terms: "Sent terms" });
  const id = draft.id as string;
  await lineItems.addEstimateLineItem(id, { description: "Tear-off", quantity: "1", unit: "", unitPrice: "100" });
  assert.equal((await actions.sendEstimate(id)).ok, true);
  const snapshot = JSON.stringify(store);

  assert.deepEqual(await actions.updateEstimate({}, form({ ...BASE, id, title: "Changed", scopeOfWork: "Changed", terms: "Changed" })), { error: "This estimate could not be found or is no longer a draft." });
  const sentError = { ok: false, error: "This quote has been sent, so it can no longer be changed." };
  assert.deepEqual(await lineItems.saveEstimateQuoteText(id, { scopeOfWork: "Changed", terms: "Changed" }), sentError);
  assert.deepEqual(await lineItems.addEstimateLineItem(id, { description: "Extra", quantity: "1", unit: "", unitPrice: "5" }), sentError);
  const itemId = store.estimate_line_items[0].id as string;
  assert.deepEqual(await lineItems.updateEstimateLineItem(id, itemId, { description: "Cheaper", quantity: "1", unit: "", unitPrice: "1" }), sentError);
  assert.deepEqual(await lineItems.removeEstimateLineItem(id, itemId), sentError);
  // Even bypassing the actions, the guard (as on TEST) refuses direct writes.
  assert.ok((await db.from("estimate_line_items").update({ unit_price: 1 }).eq("estimate_id", id)).error);
  assert.equal(await details.saveQuoteTextFields(db, ORG, id, { scopeOfWork: "x", terms: "x" }), false);
  assert.equal(JSON.stringify(store), snapshot, "nothing about the sent quote changed");
  // Sending again is refused too - there is no silent re-send of an altered quote.
  assert.equal((await actions.sendEstimate(id)).ok, false);
});

test("the customer's quote receives the saved items, scope and terms - never notes or the customer's private contact details", async () => {
  const draft = await createDraft({ scopeOfWork: "Replace the roof", terms: "Net 15" });
  draft.approval_token = "tok_0123456789abcdef";
  const id = draft.id as string;
  await lineItems.addEstimateLineItem(id, { description: "Shingles", quantity: "10", unit: "sq", unitPrice: "340" });
  assert.equal(await getEstimateByApprovalToken(db, "tok_0123456789abcdef"), null, "a draft's link shows nothing");
  await actions.sendEstimate(id);
  const quote = await getEstimateByApprovalToken(db, "tok_0123456789abcdef");
  assert.ok(quote);
  assert.equal(quote.amount, 3400);
  assert.equal(quote.details.scopeOfWork, "Replace the roof");
  assert.equal(quote.details.terms, "Net 15");
  assert.deepEqual(quote.details.lineItems.map((i: { description: string }) => i.description), ["Shingles"]);
  assert.equal(details.lineItemsMatchTotal(quote.details.lineItems, quote.amount), true, "the page shows the itemization only when it equals the total");
  assert.equal(quote.customerName, "Dana Price");
  const serialized = JSON.stringify(quote);
  for (const secret of ["Gate code 1234", "dana@example.com", "+12065550199"]) assert.ok(!serialized.includes(secret), secret);
});

test("a database without the scope/terms columns still saves the estimate and says what didn't save", async () => {
  textColumnsMissing = true;
  const created = await actions.createEstimate({}, form({ ...BASE, scopeOfWork: "Scope", terms: "" }));
  assert.equal(created.success, true);
  assert.match(created.warning ?? "", /scope of work and terms couldn't be saved/);
  assert.equal(store.estimates.length, 1, "the estimate itself was created");
  const plain = await actions.createEstimate({}, form({ ...BASE, title: "No text" }));
  assert.deepEqual(plain, { success: true, id: plain.id }, "no scope/terms entered = no warning");
  const edited = await actions.updateEstimate({}, form({ ...BASE, id: plain.id as string, title: "Edited", scopeOfWork: "x", terms: "" }));
  assert.match(edited.error ?? "", /couldn't be saved/);
  assert.equal(store.estimates.find((e) => e.id === plain.id)?.title, "Edited", "the rest of the edit was kept");
});

/**
 * Customer-facing quote details (lib/estimates/details.ts, the public loader
 * in lib/estimates/approval.ts and the draft-only editor actions in
 * app/(app)/estimates/quote-details-actions.ts).
 *
 * Money math and parsing are tested directly. The loader and the REAL server
 * actions run against an in-memory table store with session plumbing
 * mocked; the database rules themselves (draft-only trigger, RLS, numbering)
 * are proven against real Postgres by
 * supabase/pending/scratch/validate-estimate-quote-details.mjs. Nothing
 * reaches TEST, Production, Twilio or n8n.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test lib/estimates/quote-details.test.ts
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
/** Tables (or "estimates.details" for the new columns) that behave as if the migration isn't applied. */
let missing = new Set<string>();
let ids = 0;
const calls = { lifecycle: [] as string[], jobCreated: 0 };

class Query {
  private filters: ((row: Row) => boolean)[] = [];
  private patch: Row | null = null;
  private insertRows: Row[] | null = null;
  private deleting = false;
  private columns = "*";
  private sorts: { column: string; ascending: boolean }[] = [];
  private max: number | null = null;
  private single = false;
  private table: string;
  constructor(table: string) {
    this.table = table;
  }
  select(columns = "*") { this.columns = columns; return this; }
  eq(column: string, value: unknown) { this.filters.push((row) => row[column] === value); return this; }
  in(column: string, values: unknown[]) { this.filters.push((row) => values.includes(row[column])); return this; }
  is(column: string, value: unknown) { this.filters.push((row) => (row[column] ?? null) === value); return this; }
  order(column: string, options?: { ascending?: boolean }) { this.sorts.push({ column, ascending: options?.ascending !== false }); return this; }
  limit(n: number) { this.max = n; return this; }
  update(values: Row) { this.patch = values; return this; }
  insert(values: Row | Row[]) { this.insertRows = Array.isArray(values) ? values : [values]; return this; }
  delete() { this.deleting = true; return this; }
  maybeSingle() { this.single = true; return this.run(); }
  then<T>(resolve: (value: { data: unknown; error: unknown }) => T, reject?: (reason: unknown) => T) { return this.run().then(resolve, reject); }
  private async run(): Promise<{ data: unknown; error: unknown }> {
    if (missing.has(this.table) || (this.table === "estimates" && missing.has("estimates.details") && /scope_of_work|terms|\bnumber\b/.test(this.columns + JSON.stringify(this.patch ?? {})))) {
      return { data: null, error: { code: "42703", message: "does not exist" } };
    }
    const table = (store[this.table] ??= []);
    if (this.insertRows) {
      const inserted = this.insertRows.map((row) => ({ id: `id-${++ids}`, created_at: new Date(Date.UTC(2026, 9, 1, 0, 0, ids)).toISOString(), ...row }));
      table.push(...inserted);
      return { data: this.single ? inserted[0] : inserted, error: null };
    }
    let rows = table.filter((row) => this.filters.every((f) => f(row)));
    if (this.patch) for (const row of rows) Object.assign(row, this.patch);
    if (this.deleting) store[this.table] = table.filter((row) => !rows.includes(row));
    for (const { column, ascending } of [...this.sorts].reverse()) {
      rows = [...rows].sort((a, b) => (Number(a[column] ?? 0) - Number(b[column] ?? 0) || String(a[column]).localeCompare(String(b[column]))) * (ascending ? 1 : -1));
    }
    if (this.max !== null) rows = rows.slice(0, this.max);
    const shaped = rows.map((row) => this.embed(row));
    return { data: this.single ? (shaped[0] ?? null) : shaped, error: null };
  }
  private embed(row: Row): Row {
    const out: Row = { ...row };
    if (this.table === "estimates" && this.columns.includes("organization:organizations")) out.organization = (store.organizations ?? []).find((o) => o.id === row.organization_id) ?? null;
    if (this.table === "estimates" && this.columns.includes("contact:contacts")) out.contact = (store.contacts ?? []).find((c) => c.id === row.contact_id) ?? null;
    return out;
  }
}
const db = { from: (table: string) => new Query(table), auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) } };

mock.module(lib("lib/supabase/server.ts"), { namedExports: { createClient: async () => db } });
mock.module(lib("lib/auth/organization.ts"), { namedExports: { getUserOrganization: async () => ({ organizationId: ORG, role: "owner" }) } });
mock.module("next/cache", { namedExports: { revalidatePath: () => undefined } });
mock.module("next/navigation", { namedExports: { redirect: (to: string) => { throw new Error(`redirect:${to}`); } } });
mock.module(lib("lib/automation/estimates.ts"), {
  namedExports: { emitEstimateLifecycleEventAsService: async (_s: unknown, _o: string, _id: string, type: string) => { calls.lifecycle.push(type); } },
});
mock.module(lib("lib/automation/jobs.ts"), { namedExports: { emitJobCreatedFromEstimateAsService: async () => { calls.jobCreated += 1; } } });
mock.module(lib("lib/automation/events.ts"), { namedExports: { createAutomationEventAsService: async () => ({ ok: true }) } });

const details = await import(lib("lib/estimates/details.ts"));
const { getEstimateByApprovalToken, respondToEstimateByToken, formatOrganizationAddress } = await import(lib("lib/estimates/approval.ts"));
const actions = await import(lib("app/(app)/estimates/quote-details-actions.ts"));

const TOKEN = "tok_0123456789abcdef";
beforeEach(() => {
  ids = 0;
  missing = new Set();
  calls.lifecycle = [];
  calls.jobCreated = 0;
  store = {
    organizations: [
      { id: ORG, name: "Ridgeline Roofing", sms_phone_number: "+12065550142", phone: null, email: "office@ridgeline.example", website: "ridgeline.example", address: "12 Main St", city: "Seattle", state: "WA", zip: "98101" },
      { id: OTHER_ORG, name: "Other Co", sms_phone_number: null },
    ],
    contacts: [{ id: "contact-1", organization_id: ORG, first_name: "Dana", last_name: "Price", company_name: null, phone: "+12065550199", email: "dana@example.com" }],
    estimates: [
      { id: "est-draft", organization_id: ORG, contact_id: "contact-1", title: "Roof", amount: 500, status: "draft", number: 7, scope_of_work: null, terms: null, approval_token: "tok_draft_000000000", notes: "internal" },
      { id: "est-sent", organization_id: ORG, contact_id: "contact-1", title: "Gutters", amount: 1110.5, status: "sent", number: 8, scope_of_work: "Replace gutters", terms: "Net 15", approval_token: TOKEN, notes: "internal only", sent_at: "2026-10-01T00:00:00Z", expires_at: "2099-01-01T00:00:00Z" },
      { id: "est-other", organization_id: OTHER_ORG, contact_id: null, title: "Other", amount: 10, status: "draft", number: 1 },
    ],
    estimate_line_items: [
      { id: "li-1", organization_id: ORG, estimate_id: "est-sent", position: 0, description: "Gutter", quantity: "110.000", unit: "lf", unit_price: "10.00" },
      { id: "li-2", organization_id: ORG, estimate_id: "est-sent", position: 1, description: "Downspout", quantity: "1.500", unit: null, unit_price: "7.00" },
      { id: "li-x", organization_id: OTHER_ORG, estimate_id: "est-other", position: 0, description: "Foreign", quantity: 1, unit: null, unit_price: 10 },
    ],
  };
});

// --- money and parsing -------------------------------------------------------

test("money is computed in cents: line totals, subtotal and the exact-match rule", () => {
  assert.equal(details.lineItemTotal({ quantity: 3, unitPrice: 0.1 }), 0.3, "no float drift");
  assert.equal(details.lineItemTotal({ quantity: 1.5, unitPrice: 7 }), 10.5);
  assert.equal(details.lineItemTotal({ quantity: 0.333, unitPrice: 10 }), 3.33, "rounded to the cent");
  assert.equal(details.lineItemsSubtotal([{ quantity: 110, unitPrice: 10 }, { quantity: 1.5, unitPrice: 7 }]), 1110.5);
  assert.equal(details.lineItemsMatchTotal([{ quantity: 110, unitPrice: 10 }, { quantity: 1.5, unitPrice: 7 }], 1110.5), true);
  assert.equal(details.lineItemsMatchTotal([{ quantity: 1, unitPrice: 10 }], 10.01), false, "off by a cent is a mismatch");
  assert.equal(details.lineItemsMatchTotal([], 0), false, "no items, no itemization");
  assert.equal(details.lineItemsMatchTotal([{ quantity: 1, unitPrice: 10 }], null), false);
  assert.equal(details.formatQuoteNumber(12), "Q-000012");
  assert.equal(details.formatLineMoney(1240), "$1,240.00");
  assert.equal(details.formatQuantity(2.5), "2.5");
});

test("line-item input mirrors the table's checks", () => {
  assert.deepEqual(details.parseLineItemInput({ description: "  Tear-off ", quantity: "", unit: " sq ", unitPrice: "$1,200.50" }), { ok: true, value: { description: "Tear-off", quantity: 1, unit: "sq", unitPrice: 1200.5 } });
  assert.deepEqual(details.parseLineItemInput({ description: "Free", quantity: "2", unit: "", unitPrice: "0" }), { ok: true, value: { description: "Free", quantity: 2, unit: null, unitPrice: 0 } });
  for (const bad of [
    { description: " ", quantity: "1", unit: "", unitPrice: "1" },
    { description: "x".repeat(501), quantity: "1", unit: "", unitPrice: "1" },
    { description: "x", quantity: "0", unit: "", unitPrice: "1" },
    { description: "x", quantity: "-1", unit: "", unitPrice: "1" },
    { description: "x", quantity: "1.2345", unit: "", unitPrice: "1" },
    { description: "x", quantity: "abc", unit: "", unitPrice: "1" },
    { description: "x", quantity: "1", unit: "", unitPrice: "" },
    { description: "x", quantity: "1", unit: "", unitPrice: "-5" },
    { description: "x", quantity: "1", unit: "", unitPrice: "1.005" },
    { description: "x", quantity: "1", unit: "u".repeat(21), unitPrice: "1" },
  ]) {
    assert.equal(details.parseLineItemInput(bad).ok, false, JSON.stringify(bad));
  }
  assert.deepEqual(details.parseQuoteText("  \r\n ", "terms"), { ok: true, value: null });
  assert.equal(details.parseQuoteText("x".repeat(5001), "terms").ok, false);
});

// --- loading -----------------------------------------------------------------

test("details load for one estimate of one organization, in position order", async () => {
  const loaded = await details.getEstimateDetails(db, ORG, "est-sent");
  assert.equal(loaded.number, 8);
  assert.equal(loaded.scopeOfWork, "Replace gutters");
  assert.deepEqual(loaded.lineItems.map((i: { description: string; quantity: number; unitPrice: number }) => [i.description, i.quantity, i.unitPrice]), [["Gutter", 110, 10], ["Downspout", 1.5, 7]]);
  assert.equal(loaded.lineItemsAvailable, true);
  const crossOrg = await details.getEstimateDetails(db, OTHER_ORG, "est-sent");
  assert.equal(crossOrg.lineItems.length, 0, "another organization's id never reads these items");
  assert.equal(crossOrg.number, null);
});

test("a database without the migration degrades to the previous quote, never an error", async () => {
  missing = new Set(["estimate_line_items", "estimates.details"]);
  const loaded = await details.getEstimateDetails(db, ORG, "est-sent");
  assert.deepEqual(loaded, details.NO_ESTIMATE_DETAILS);
  assert.equal(await details.getLineItemSubtotal(db, ORG, "est-sent"), null);
  const quote = await getEstimateByApprovalToken(db, TOKEN);
  assert.equal(quote?.title, "Gutters", "the quote still renders");
  assert.equal(quote?.details.lineItems.length, 0);
});

test("public quote: customer name, business contact, number, items, scope and terms - never notes or the customer's own contact details", async () => {
  const quote = await getEstimateByApprovalToken(db, TOKEN);
  assert.ok(quote);
  assert.equal(quote.customerName, "Dana Price");
  assert.equal(quote.organizationEmail, "office@ridgeline.example");
  assert.equal(quote.organizationAddress, "12 Main St, Seattle, WA 98101");
  assert.equal(quote.organizationPhone, "+12065550142");
  assert.equal(quote.details.number, 8);
  assert.equal(quote.details.terms, "Net 15");
  assert.equal(details.lineItemsMatchTotal(quote.details.lineItems, quote.amount), true);
  const serialized = JSON.stringify(quote);
  for (const secret of ["internal only", "dana@example.com", "+12065550199"]) assert.ok(!serialized.includes(secret), secret);
  assert.equal(await getEstimateByApprovalToken(db, "tok_draft_000000000"), null, "a draft's link does not exist");
  assert.equal(await getEstimateByApprovalToken(db, "tok_unknown_0000000"), null);
  assert.equal(formatOrganizationAddress({ address: null, city: " ", state: null, zip: null }), null);
});

test("approve persists once; a repeat, a decline after approval, and an expired quote are refused", async () => {
  assert.equal(await respondToEstimateByToken(db, TOKEN, "accept"), "accepted");
  const row = store.estimates.find((e) => e.id === "est-sent")!;
  assert.equal(row.status, "accepted");
  assert.ok(row.responded_at);
  assert.equal(await respondToEstimateByToken(db, TOKEN, "accept"), "already_responded");
  assert.equal(await respondToEstimateByToken(db, TOKEN, "decline"), "already_responded");
  assert.equal(row.status, "accepted");
  assert.deepEqual(calls.lifecycle, ["estimate.accepted"]);
  assert.equal(calls.jobCreated, 1);
  // An itemized quote stays exactly as approved.
  assert.equal(store.estimate_line_items.filter((i) => i.estimate_id === "est-sent").length, 2);

  row.status = "sent";
  row.expires_at = "2020-01-01T00:00:00Z";
  assert.equal(await respondToEstimateByToken(db, TOKEN, "decline"), "expired");
  assert.equal(row.status, "sent");
});

// --- editing (draft-only) ------------------------------------------------------

test("adding, editing and removing line items keeps the draft's amount equal to the subtotal", async () => {
  assert.deepEqual(await actions.addEstimateLineItem("est-draft", { description: "Tear-off", quantity: "24", unit: "sq", unitPrice: "95" }), { ok: true });
  assert.deepEqual(await actions.addEstimateLineItem("est-draft", { description: "Dumpster", quantity: "", unit: "", unitPrice: "800" }), { ok: true });
  const draft = store.estimates.find((e) => e.id === "est-draft")!;
  assert.equal(draft.amount, 3080);
  const items = store.estimate_line_items.filter((i) => i.estimate_id === "est-draft");
  assert.deepEqual(items.map((i) => [i.position, i.organization_id]), [[0, ORG], [1, ORG]]);

  assert.deepEqual(await actions.updateEstimateLineItem("est-draft", items[1].id as string, { description: "Dumpster", quantity: "2", unit: "", unitPrice: "800" }), { ok: true });
  assert.equal(draft.amount, 3880);
  assert.deepEqual(await actions.removeEstimateLineItem("est-draft", items[0].id as string), { ok: true });
  assert.equal(draft.amount, 1600);

  const invalid = await actions.addEstimateLineItem("est-draft", { description: "", quantity: "1", unit: "", unitPrice: "1" });
  assert.equal(invalid.ok, false);
  assert.equal(store.estimate_line_items.filter((i) => i.estimate_id === "est-draft").length, 1, "nothing written on invalid input");
});

test("a sent quote and another organization's estimate cannot be changed", async () => {
  const before = JSON.stringify(store);
  for (const result of [
    await actions.addEstimateLineItem("est-sent", { description: "Extra", quantity: "1", unit: "", unitPrice: "5" }),
    await actions.updateEstimateLineItem("est-sent", "li-1", { description: "Cheaper", quantity: "1", unit: "", unitPrice: "1" }),
    await actions.removeEstimateLineItem("est-sent", "li-1"),
    await actions.saveEstimateQuoteText("est-sent", { scopeOfWork: "changed", terms: "changed" }),
  ]) {
    assert.deepEqual(result, { ok: false, error: "This quote has been sent, so it can no longer be changed." });
  }
  for (const result of [
    await actions.addEstimateLineItem("est-other", { description: "Into B", quantity: "1", unit: "", unitPrice: "5" }),
    await actions.removeEstimateLineItem("est-other", "li-x"),
    await actions.saveEstimateQuoteText("est-other", { scopeOfWork: "x", terms: "" }),
  ]) {
    assert.deepEqual(result, { ok: false, error: "This estimate could not be found." });
  }
  // An item id from another estimate can't be edited through this one.
  assert.deepEqual(await actions.updateEstimateLineItem("est-draft", "li-x", { description: "x", quantity: "1", unit: "", unitPrice: "1" }), { ok: false, error: "This line item could not be found." });
  assert.equal(JSON.stringify(store), before, "nothing changed");
});

test("scope and terms save on a draft, trimmed, empty becomes null", async () => {
  assert.deepEqual(await actions.saveEstimateQuoteText("est-draft", { scopeOfWork: "  Full tear-off  ", terms: "   " }), { ok: true });
  const draft = store.estimates.find((e) => e.id === "est-draft")!;
  assert.equal(draft.scope_of_work, "Full tear-off");
  assert.equal(draft.terms, null);
  assert.equal(draft.notes, "internal", "internal notes untouched");
});

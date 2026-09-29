/**
 * Phase 1C cleanup: unit tests for lib/payments/payment-link.ts - the
 * contractor-facing "Copy payment link". Fake Supabase, no Stripe. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/payments/payment-link.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { makeFakeSupabase, type Row } from "./test-fakes";

const require = createRequire(import.meta.url);
const { buildPaymentUrl, describePaymentLink, getInvoicePaymentLink }: typeof import("./payment-link") = require("./payment-link.ts");

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const INVOICE = "33333333-3333-4333-8333-333333333333";
const ACCT = "acct_1TestConnect000001";
const TOKEN = "ab".repeat(24);
const BASE = "https://app.example.com";
const ACCEPTING = { accountId: ACCT, chargesEnabled: true };

function invoiceRow(overrides: Partial<Row> = {}): Row {
  return { id: INVOICE, organization_id: ORG, status: "sent", payment_token: TOKEN, notes: "INTERNAL-NOTE", ...overrides };
}

function orgRow(overrides: Partial<Row> = {}): Row {
  return { id: ORG, stripe_connect_account_id: ACCT, stripe_connect_charges_enabled: true, stripe_connect_payouts_enabled: true, stripe_connect_details_submitted: true, stripe_connect_synced_at: "2026-09-29T02:00:00.000Z", ...overrides };
}

// ---------------------------------------------------------------------------
// Public URL construction
// ---------------------------------------------------------------------------

test("buildPaymentUrl: <origin>/pay/<token> - trailing slashes and any path on the base are dropped", () => {
  assert.equal(buildPaymentUrl(BASE, TOKEN), `${BASE}/pay/${TOKEN}`);
  assert.equal(buildPaymentUrl(`${BASE}/`, TOKEN), `${BASE}/pay/${TOKEN}`);
  assert.equal(buildPaymentUrl(`${BASE}/some/path?x=1#y`, TOKEN), `${BASE}/pay/${TOKEN}`);
  assert.equal(buildPaymentUrl("http://localhost:3000", TOKEN), `http://localhost:3000/pay/${TOKEN}`);
});

test("buildPaymentUrl: a malformed token or base URL yields no link", () => {
  for (const token of ["", "AB".repeat(24), "ab".repeat(23), "ab".repeat(25), `${"ab".repeat(23)}/x`, "../settings"]) {
    assert.equal(buildPaymentUrl(BASE, token), null, JSON.stringify(token));
  }
  for (const base of ["", "not a url", "javascript:alert(1)", "ftp://example.com", "data:text/html,x"]) {
    assert.equal(buildPaymentUrl(base, TOKEN), null, base);
  }
});

// ---------------------------------------------------------------------------
// When the link is offered
// ---------------------------------------------------------------------------

test("describePaymentLink: offered only for sent and partially paid invoices", () => {
  for (const status of ["sent", "partially_paid"]) {
    assert.deepEqual(describePaymentLink({ invoiceStatus: status, token: TOKEN, paymentStatus: "active", connect: ACCEPTING, baseUrl: BASE }), { kind: "ready", url: `${BASE}/pay/${TOKEN}` }, status);
  }
  for (const status of ["draft", "paid", "void", "", null, undefined]) {
    assert.deepEqual(describePaymentLink({ invoiceStatus: status, token: TOKEN, paymentStatus: "active", connect: ACCEPTING, baseUrl: BASE }), { kind: "hidden" }, String(status));
  }
  assert.deepEqual(describePaymentLink({ invoiceStatus: "sent", token: null, paymentStatus: "active", connect: ACCEPTING, baseUrl: BASE }), { kind: "hidden" });
});

test("describePaymentLink: 'not accepting' follows canAcceptOnlinePayments exactly - not connected, charges off, or subscription inactive", () => {
  const cases: [string, Parameters<typeof describePaymentLink>[0]][] = [
    ["no status", { invoiceStatus: "sent", token: TOKEN, paymentStatus: "active", connect: null, baseUrl: BASE }],
    ["not connected", { invoiceStatus: "sent", token: TOKEN, paymentStatus: "active", connect: { accountId: null, chargesEnabled: false }, baseUrl: BASE }],
    ["charges off", { invoiceStatus: "sent", token: TOKEN, paymentStatus: "active", connect: { accountId: ACCT, chargesEnabled: false }, baseUrl: BASE }],
    ["subscription suspended", { invoiceStatus: "sent", token: TOKEN, paymentStatus: "suspended", connect: ACCEPTING, baseUrl: BASE }],
    ["payment required", { invoiceStatus: "partially_paid", token: TOKEN, paymentStatus: "payment_required", connect: ACCEPTING, baseUrl: BASE }],
  ];
  for (const [label, input] of cases) assert.deepEqual(describePaymentLink(input), { kind: "not_accepting" }, label);
});

test("describePaymentLink: no configured base URL degrades to 'not available in this environment'", () => {
  assert.deepEqual(describePaymentLink({ invoiceStatus: "sent", token: TOKEN, paymentStatus: "active", connect: ACCEPTING, baseUrl: null }), { kind: "no_base_url" });
});

// ---------------------------------------------------------------------------
// Authorization and side effects
// ---------------------------------------------------------------------------

test("getInvoicePaymentLink: reads only status and payment_token, scoped to the member's organization and the invoice id", async () => {
  const db = makeFakeSupabase({ invoices: [invoiceRow()], organizations: [orgRow()] });
  const view = await getInvoicePaymentLink(db.client, { organizationId: ORG, paymentStatus: "active", invoiceId: INVOICE, baseUrl: BASE });
  assert.deepEqual(view, { kind: "ready", url: `${BASE}/pay/${TOKEN}` });
  const invoiceRead = db.calls.find((call) => call.table === "invoices");
  assert.equal(invoiceRead?.columns, "status, payment_token");
  assert.deepEqual(invoiceRead?.filters, [["eq", "id", INVOICE], ["eq", "organization_id", ORG]]);
});

test("authorization: another organization's invoice is never linked - hidden, and its token never leaves the database", async () => {
  const db = makeFakeSupabase({ invoices: [invoiceRow({ organization_id: OTHER_ORG })], organizations: [orgRow(), orgRow({ id: OTHER_ORG })] });
  const view = await getInvoicePaymentLink(db.client, { organizationId: ORG, paymentStatus: "active", invoiceId: INVOICE, baseUrl: BASE });
  assert.deepEqual(view, { kind: "hidden" });
  assert.equal(JSON.stringify(view).includes(TOKEN), false);
  assert.equal(db.calls.some((call) => call.table === "organizations"), false, "no further reads once the invoice isn't found");
});

test("a draft, paid or void invoice is hidden without reading the organization's Stripe status", async () => {
  for (const status of ["draft", "paid", "void"]) {
    const db = makeFakeSupabase({ invoices: [invoiceRow({ status })], organizations: [orgRow()] });
    assert.deepEqual(await getInvoicePaymentLink(db.client, { organizationId: ORG, paymentStatus: "active", invoiceId: INVOICE, baseUrl: BASE }), { kind: "hidden" }, status);
    assert.equal(db.calls.some((call) => call.table === "organizations"), false, status);
  }
});

test("copying a link never writes: no insert, update, delete or RPC in any state - no token is created, no Checkout, no ledger row", async () => {
  const scenarios: [Row[], Row[]][] = [
    [[invoiceRow()], [orgRow()]],
    [[invoiceRow()], [orgRow({ stripe_connect_account_id: null, stripe_connect_charges_enabled: false })]],
    [[invoiceRow({ status: "paid" })], [orgRow()]],
    [[], [orgRow()]],
  ];
  for (const [invoices, organizations] of scenarios) {
    const db = makeFakeSupabase({ invoices, organizations });
    await getInvoicePaymentLink(db.client, { organizationId: ORG, paymentStatus: "active", invoiceId: INVOICE, baseUrl: BASE });
    assert.equal(db.writes().length, 0);
    assert.equal(db.rpcCalls.length, 0);
    assert.deepEqual([...new Set(db.calls.map((call) => call.op))], ["select"]);
  }
});

test("no sensitive data: the view carries only the public URL - no invoice, organization or Stripe account id, no notes", async () => {
  const db = makeFakeSupabase({ invoices: [invoiceRow()], organizations: [orgRow()] });
  const view = await getInvoicePaymentLink(db.client, { organizationId: ORG, paymentStatus: "active", invoiceId: INVOICE, baseUrl: BASE });
  assert.deepEqual(Object.keys(view).sort(), ["kind", "url"]);
  const serialized = JSON.stringify(view);
  for (const forbidden of [INVOICE, ORG, ACCT, "INTERNAL-NOTE", "organization", "acct_", "stripe"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

// ---------------------------------------------------------------------------
// Structural
// ---------------------------------------------------------------------------

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("structural: the payment-link module and row make no Stripe call, no write, no fetch and never use the service role", () => {
  const lib = read("lib/payments/payment-link.ts");
  assert.doesNotMatch(lib, /stripe\b(?!_)|paymentsStripe|getPaymentsStripeClient|createInvoiceCheckoutSession|createServiceRoleClient|\.insert\(|\.update\(|\.delete\(|\.upsert\(|\.rpc\(/);
  const row = read("app/(app)/invoices/[id]/_components/payment-link-row.tsx");
  assert.doesNotMatch(row, /fetch\(|\/api\/|action=|useActionState|"use server"/);
  assert.match(row, /navigator\.clipboard\.writeText\(view\.url\)/);
  assert.match(row, /copied \? "Copied" : "Copy payment link"/);
});

test("structural: the invoice page loads the link with the member's own session client and resolved membership, never request input", () => {
  const page = read("app/(app)/invoices/[id]/page.tsx");
  assert.match(page, /getInvoicePaymentLink\(supabase, \{ organizationId: membership\.organizationId, paymentStatus: membership\.paymentStatus, invoiceId: invoice\.id, baseUrl: resolveAppBaseUrl\(\) \}\)/);
  assert.match(page, /<PaymentLinkRow view=\{paymentLink\} \/>/);
  assert.doesNotMatch(page, /createServiceRoleClient/);
});

test("structural: the payment token stays out of the shared invoice columns (lists, job and contact views never carry it)", () => {
  assert.doesNotMatch(read("lib/invoices/queries.ts"), /payment_token/);
});

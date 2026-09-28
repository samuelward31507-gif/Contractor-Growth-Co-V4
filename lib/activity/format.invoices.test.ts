/**
 * Phase 1B-3: the Activity timeline's handling of invoice and payment audit
 * rows (written by create_invoice_audit_event via lib/invoices/service.ts).
 * Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/activity/format.invoices.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { activityEntityHref, activityEntityLabel, describeMetadata, humanizeText }: typeof import("./format") = require("./format.ts");

test("invoice and payment entities get labels and links; a payment links to its invoice via metadata", () => {
  assert.equal(activityEntityLabel("invoice"), "Invoice");
  assert.equal(activityEntityLabel("customer_payment"), "Payment");
  assert.equal(activityEntityHref("invoice", "inv-1"), "/invoices/inv-1");
  assert.equal(activityEntityHref("customer_payment", "pay-1", { invoice_id: "inv-1" }), "/invoices/inv-1");
  assert.equal(activityEntityHref("customer_payment", "pay-1", {}), null, "no page of its own and no invoice id in metadata renders as plain text");
  assert.equal(activityEntityHref("contact", "c-1"), "/people/c-1", "existing routes are unchanged");
});

test("money audit metadata reads as number · amount · method · resulting status", () => {
  assert.equal(describeMetadata({ number: 7, amount: 1300.25, method: "check", invoice_status_after: "partially_paid", invoice_id: "inv-1" }), "INV-000007 · $1,300.25 · Check · now Partially paid");
  assert.equal(describeMetadata({ number: 7, total: 1400, job_id: "job-1", job_amount_updated: true }), "INV-000007 · $1,400");
  assert.equal(describeMetadata({ number: 3, total: 500, previous_status: "sent", reason: "wrong amount" }), "INV-000003 · $500 · Reason: wrong amount");
  assert.equal(describeMetadata({ number: 3, total: 500, due_date: "2026-10-31" }), "INV-000003 · $500 · due 2026-10-31");
});

test("existing metadata shapes still describe the way they did", () => {
  assert.equal(describeMetadata({ old_status: "new", new_status: "won" }), "Status changed from New to Won");
  assert.equal(describeMetadata({ name: "Ann Lee", estimated_value: 2500 }), "Ann Lee · $2,500");
  assert.equal(describeMetadata(null), null);
  assert.equal(humanizeText("payment_recorded"), "Payment recorded");
});

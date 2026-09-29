/**
 * Phase 1C cleanup: unit tests for lib/invoices/payment-history-view.ts -
 * which action a payment-history row offers. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/invoices/payment-history-view.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { paymentRowAction, STRIPE_REFUND_URL } from "./payment-history-view";
import { MANUAL_PAYMENT_METHODS, type InvoiceStatus } from "./domain";
import { STRIPE_DASHBOARD_URL } from "@/lib/payments/online-payments-view";

const OPEN_STATUSES: InvoiceStatus[] = ["sent", "partially_paid", "paid"];

test("regression: a card_online payment never offers Reverse - it points to a refund in Stripe instead", () => {
  for (const invoiceStatus of OPEN_STATUSES) {
    assert.equal(paymentRowAction({ method: "card_online", isReversal: false, isReversed: false, invoiceStatus }), "refund_in_stripe", invoiceStatus);
  }
});

test("every manual method keeps its Reverse action on sent, partially paid and paid invoices", () => {
  for (const { value } of MANUAL_PAYMENT_METHODS) {
    for (const invoiceStatus of OPEN_STATUSES) {
      assert.equal(paymentRowAction({ method: value, isReversal: false, isReversed: false, invoiceStatus }), "reverse", `${value} on ${invoiceStatus}`);
    }
  }
});

test("reversal rows, already-reversed payments, and draft or void invoices offer nothing - for any method", () => {
  for (const method of ["cash", "card_online"]) {
    assert.equal(paymentRowAction({ method, isReversal: true, isReversed: false, invoiceStatus: "sent" }), null);
    assert.equal(paymentRowAction({ method, isReversal: false, isReversed: true, invoiceStatus: "paid" }), null);
    for (const invoiceStatus of ["draft", "void"] as InvoiceStatus[]) assert.equal(paymentRowAction({ method, isReversal: false, isReversed: false, invoiceStatus }), null);
  }
});

test("the refund link is the same Stripe dashboard Settings links to", () => {
  assert.equal(STRIPE_REFUND_URL, STRIPE_DASHBOARD_URL);
});

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("structural: the payment history renders Reverse only for the 'reverse' action, and the service's reversal rule is unchanged", () => {
  const history = read("app/(app)/invoices/[id]/_components/payment-history.tsx");
  assert.match(history, /const action = paymentRowAction\(\{ method: payment\.method, isReversal, isReversed, invoiceStatus \}\);/);
  assert.match(history, /\) : action === "reverse" \? \(\s*<button type="button" onClick=\{\(\) => setReversing\(payment\)\}/);
  assert.match(history, /action === "refund_in_stripe" \? \(\s*<a href=\{STRIPE_REFUND_URL\} target="_blank" rel="noopener noreferrer"/);
  assert.equal((history.match(/setReversing\(payment\)/g) ?? []).length, 1, "the reversal dialog opens from exactly one place");
  assert.match(read("lib/invoices/service.ts"), /if \(original\.method === "card_online"\) return \{ ok: false, error: "This payment was made online by card\. Refund it from your Stripe dashboard instead of reversing it here\." \};/);
});

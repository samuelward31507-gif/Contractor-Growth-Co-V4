/**
 * Phase 1B-3 structural tests for the invoice UI, verified against the real
 * source files (the middleware.*.test.ts convention - these components need
 * a Next.js request/render context, so the guarantees that matter most are
 * pinned at the source level). Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test "app/(app)/invoices/ui.structural.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), "utf8");

const paymentHistory = read("app/(app)/invoices/[id]/_components/payment-history.tsx");
const invoicePage = read("app/(app)/invoices/[id]/page.tsx");
const invoiceActions = read("app/(app)/invoices/[id]/_components/invoice-actions.tsx");
const recordDialog = read("app/(app)/invoices/[id]/_components/record-payment-dialog.tsx");
const reverseDialog = read("app/(app)/invoices/[id]/_components/reverse-payment-dialog.tsx");
const jobPage = read("app/(app)/jobs/[id]/page.tsx");
const invoiceSection = read("app/(app)/jobs/[id]/_components/invoice-section.tsx");
const createDialog = read("app/(app)/jobs/[id]/_components/create-invoice-dialog.tsx");
const moneyPage = read("app/(app)/money/page.tsx");
const summaryCards = read("app/(app)/invoices/_components/invoice-money-summary.tsx");

test("payment history offers no edit or delete control - only Reverse, submitted through the server action", () => {
  assert.doesNotMatch(paymentHistory, /\b(Edit|Delete|Remove)\b/);
  assert.doesNotMatch(paymentHistory, /\.update\(|\.delete\(/);
  assert.match(paymentHistory, /ReversePaymentDialog/);
  assert.match(reverseDialog, /reverseCustomerPayment\(payment\.id, notes\)/);
  assert.match(reverseDialog, /not deleted or changed/);
});

test("payment history keeps the original visible and marks reversals and reversed originals", () => {
  assert.match(paymentHistory, /Reversal<\/Badge>/);
  assert.match(paymentHistory, /Reversed<\/Badge>/);
  assert.match(paymentHistory, /!isReversal && !isReversed && canReverse/);
});

test("the invoice page never renders internal ids, organization ids or approval tokens", () => {
  for (const source of [invoicePage, invoiceSection, paymentHistory, invoiceActions, recordDialog, reverseDialog]) {
    // Ids may appear inside hrefs and action calls, never as rendered text.
    assert.doesNotMatch(source, />\{invoice\.id\}<|>\{payment\.id\}<|organization_id|approval_token|created_by|recorded_by/);
  }
  assert.match(invoicePage, /formatInvoiceNumber\(invoice\.number\)/);
});

test("invoice actions are derived from status: issue only for drafts, payment only for sent/partially paid, void only when the domain allows it", () => {
  assert.match(invoiceActions, /const showIssue = canIssue\(invoice\)/);
  assert.match(invoiceActions, /const showVoid = canVoid\(invoice\)/);
  assert.match(invoiceActions, /const showPayment = invoice\.status === "sent" \|\| invoice\.status === "partially_paid"/);
  assert.match(invoiceActions, /issueInvoice\(invoice\.id, \{ dueDate: issueDueDate \|\| null \}\)/);
  assert.match(invoiceActions, /voidInvoice\(invoice\.id, voidReason\)/);
  assert.doesNotMatch(invoiceActions, /fetch\(|n8n|twilio|stripe/i, "no outbound or automation call from the UI");
});

test("the record-payment dialog locks its submit button on submission and re-enables only on failure", () => {
  assert.match(recordDialog, /const locked = submitting \|\| isPending/);
  assert.match(recordDialog, /setSubmitting\(true\);\s*startTransition/);
  assert.match(recordDialog, /if \(!result\.ok\) \{\s*setError\(result\.error\);\s*setSubmitting\(false\);/);
  assert.match(recordDialog, /disabled=\{locked\} className=\{primaryButtonAutoClass\}/);
  assert.match(recordDialog, /buildRecordPaymentInput\(values, invoice\)/, "client validation runs first; the server and database stay authoritative");
  for (const method of ["cash", "check", "card_elsewhere", "bank_transfer", "other"]) {
    assert.match(read("lib/invoices/domain.ts"), new RegExp(`value: "${method}"`));
  }
});

test("the job page reads the one live invoice and today's date in the organization's timezone", () => {
  assert.match(jobPage, /getLiveInvoiceForJob\(supabase, membership\.organizationId, job\.id\)/);
  assert.match(jobPage, /calendarDateInTimeZone\(new Date\(\), timeZone \?\? "UTC"\)/);
  assert.match(jobPage, /<InvoiceSection job=\{job\} invoice=\{liveInvoice\} today=\{today\} \/>/);
});

test("the job invoice section creates drafts only, hides Create when a live invoice exists, and shows every required figure", () => {
  assert.match(createDialog, /createInvoiceFromJob\(built\.input\)/);
  assert.match(createDialog, /Create draft/);
  assert.doesNotMatch(createDialog, /issueInvoice/, "creation never issues");
  assert.match(createDialog, /alsoSetJobAmount/);
  assert.match(invoiceSection, /if \(!invoice\) \{/);
  assert.match(invoiceSection, /View invoice/);
  for (const label of ["Total", "Paid", "Balance due", "Due", "Created", "Issued"]) {
    assert.match(invoiceSection, new RegExp(`>${label}<`));
  }
  assert.match(invoiceSection, /Overdue · /);
  assert.match(invoiceSection, /differs from the job/);
});

test("Money's invoice figures keep the terminology line: only Collected is money received", () => {
  assert.match(summaryCards, /label="Collected"/);
  assert.match(summaryCards, /the only figure that is money in hand/);
  assert.match(moneyPage, /Collected is money actually received/);
  assert.doesNotMatch(summaryCards, /revenue/i, "no invoice figure is ever called revenue");
  assert.match(moneyPage, /browse === "invoices"/);
  assert.match(moneyPage, /getCustomerPaymentsResult/);
});

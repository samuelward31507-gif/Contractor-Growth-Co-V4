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
const todayPage = read("app/(app)/today/page.tsx");
const dashboardSql = read("lib/dashboard/sql.ts");
const insightsPage = read("app/(app)/insights/page.tsx");
const insightsSections = read("app/(app)/insights/_components/business-metrics-sections.tsx");
const personPage = read("app/(app)/people/[id]/page.tsx");
const peoplePage = read("app/(app)/people/page.tsx");
const conversationPage = read("app/(app)/conversations/[id]/page.tsx");
const conversationContext = read("app/(app)/conversations/[id]/_components/conversation-context.tsx");
const appointmentPage = read("app/(app)/appointments/[id]/page.tsx");

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
  // Phase 1C cleanup: the row action (reversals, reversed originals and
  // card_online never offer Reverse) comes from paymentRowAction - see
  // lib/invoices/payment-history-view.test.ts.
  assert.match(paymentHistory, /paymentRowAction\(\{ method: payment\.method, isReversal, isReversed, invoiceStatus \}\)/);
  assert.match(paymentHistory, /action === "reverse" \?/);
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

// ---------------------------------------------------------------------------
// Phase 1B-4: Financial Visibility
// ---------------------------------------------------------------------------

test("Today's money-owed figure uses summarizeInvoiceMoney's definitions (Phase 2D: summed in SQL), judged against the organization's calendar date", () => {
  // Phase 2D: dashboard_summary sums the complete invoice/payment ledger;
  // dashboardInvoiceSummary maps it back to summarizeInvoiceMoney's shape,
  // with overdue still decided by isOverdue against the org-timezone date.
  // Parity at cent precision: supabase/pending/scratch/validate-dashboard-sql.mjs.
  assert.match(todayPage, /getDashboardSummary\(supabase, membership\.organizationId, briefingNow, dayBounds\)/);
  assert.match(todayPage, /dashboardInvoiceSummary\(summary\.data, today\)/);
  assert.match(todayPage, /calendarDateInTimeZone\(new Date\(\), timeZone \?\? "UTC"\)/);
  // Phase 2: Today shows only the current-state money owed (Unpaid, with
  // anything past due as its detail) and what is ready to invoice - the
  // same invoiceSummary figures and formatter. Period Collected/Invoiced
  // live on Analytics.
  assert.match(todayPage, /outstanding: formatMoney\(invoiceSummary\.outstanding\)/);
  assert.match(todayPage, /readyToInvoice: formatMoney\(invoiceSummary\.notYetInvoicedKnownValue\)/);
  assert.match(todayPage, /\{ count: invoiceSummary\.overdueCount, value: formatMoney\(invoiceSummary\.overdue\) \}/);
  assert.doesNotMatch(todayPage, /invoiceSummary\.collected|invoiceSummary\.invoiced\b/, "no all-time Collected/Invoiced on Today");
  assert.match(todayPage, /const moneyDataFailed = summary\.failed;/, "a failed ledger read is disclosed, never rendered as a clean $0");
  assert.match(dashboardSql, /isOverdue\(\{ status: "sent", dueDate: bucket\.due_date \}, today\)/);
  assert.match(summaryCards, /variant === "dashboard" \? null : \(/, "the dashboard variant drops only Not yet invoiced");
  assert.match(summaryCards, /INVOICING_LIVE_AT/, "the legacy cutoff is documented where Not yet invoiced is rendered");
});

test("Insights reads billing from the BI snapshot only, shows the sanctioned definition, and no longer claims that no payment ledger exists", () => {
  assert.match(insightsSections, /snapshot\.billingMetrics|const \{ billingMetrics, comparisons, dataQuality \} = snapshot/);
  assert.match(insightsSections, /SANCTIONED_COLLECTED_REVENUE_DEFINITION/);
  assert.match(insightsSections, /label: "Collected"/);
  assert.match(insightsSections, /as of today/, "Outstanding/Overdue are labeled as balances as of today, not period totals");
  assert.match(insightsSections, /Based on \$\{count\(billingMetrics\.invoicesPaid/, "days to payment is never shown without its population");
  assert.match(insightsSections, /already subtracted from Collected/, "reversals stay visible separately");
  assert.doesNotMatch(insightsSections, /supabase|\.from\(/, "the section calculates nothing and queries nothing itself");
  for (const source of [insightsPage, insightsSections]) {
    assert.doesNotMatch(source, /no payment ledger exists|no payment infrastructure/i);
  }
  assert.match(insightsPage, /<RevenuePaymentsPanel snapshot=\{snapshot\} \/>/);
});

test("People and Inbox show invoice number, status, balance due and overdue to members - never notes, ids or tokens", () => {
  assert.match(peoplePage, /getInvoices\(supabase, membership\.organizationId\)/);
  assert.match(peoplePage, /invoices: invoicesByContactId\.get\(contact\.id\) \?\? \[\]/);
  assert.match(personPage, /getContactInvoices\(supabase, membership\.organizationId, id\)/);
  // Final Batch 3: the next step is the canonical-lifecycle resolver, still fed this person's invoices and timezone.
  // Batch 3: the same rows (invoices included) feed one derived lifecycle and the resolver, with the timezone.
  assert.match(personPage, /const personRows = \{ contactId: contact\.id, leads, appointments, estimates, jobs, invoices,/);
  assert.match(personPage, /findPersonNextStep\(\{\n\s+\.\.\.personRows,[\s\S]*?\n\s+timeZone,\n/);
  assert.match(personPage, /formatInvoiceNumber\(invoice\.number\)/);
  assert.match(personPage, /INVOICE_STATUS_LABELS\[invoice\.status\]/);
  assert.match(personPage, /formatMoney\(invoice\.balance_due\)/);
  assert.match(personPage, /<Badge tone="danger">Overdue<\/Badge>/);
  assert.match(conversationPage, /getContactInvoices\(supabase, membership\.organizationId, conversation\.contact_id\)/);
  assert.match(conversationPage, /invoices: contactInvoices,/);
  assert.match(conversationPage, /findPersonNextStep\(\{ \.\.\.person, conversations: \[conversation\], waitingConversationIds: waiting\.ids, timeZone,/);
  assert.match(conversationContext, /title="Invoice"/);
  assert.match(conversationContext, /formatInvoiceNumber\(relevantInvoice\.number\)/);
  assert.match(conversationContext, /formatMoney\(relevantInvoice\.balance_due\)/);
  assert.match(appointmentPage, /invoices: contactInvoices,\n\s+policy: lifecyclePolicy,\n\s+timeZone,/);
  for (const source of [personPage, conversationContext, conversationPage]) {
    assert.doesNotMatch(source, /invoice\.notes|relevantInvoice\.notes|approval_token|>\{invoice\.id\}<|>\{relevantInvoice\.id\}</);
  }
});

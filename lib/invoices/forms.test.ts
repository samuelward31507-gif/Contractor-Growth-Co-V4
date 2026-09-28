/**
 * Unit tests for lib/invoices/forms.ts - the client-side half of the invoice
 * dialogs. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/invoices/forms.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCreateInvoiceInput, buildRecordPaymentInput, dateTimeLocalToIso, defaultCreateInvoiceForm, defaultRecordPaymentForm, describeReversal, toDateTimeLocalValue } from "./forms";
import { isValidClientKey } from "./domain";

const jobWithAmount = { id: "job-1", title: "Roof replacement", amount: 1300.25, status: "completed" };
const jobWithoutAmount = { id: "job-2", title: "Gutters", amount: null, status: "scheduled" };

test("create form: a job with an amount prefills the total and leaves the write-back checkbox off", () => {
  const form = defaultCreateInvoiceForm(jobWithAmount);
  assert.equal(form.amountRaw, "1300.25");
  assert.equal(form.title, "Roof replacement");
  assert.equal(form.alsoSetJobAmount, false);
});

test("create form: a job without an amount leaves the total empty and defaults the write-back checkbox ON", () => {
  const form = defaultCreateInvoiceForm(jobWithoutAmount);
  assert.equal(form.amountRaw, "");
  assert.equal(form.alsoSetJobAmount, true);
});

test("create form: builds the server input, requiring a total when the job has none", () => {
  const empty = buildCreateInvoiceInput({ ...defaultCreateInvoiceForm(jobWithoutAmount) }, jobWithoutAmount);
  assert.equal(empty.error, "This job has no contracted amount yet. Enter the invoice total.");
  const built = buildCreateInvoiceInput({ ...defaultCreateInvoiceForm(jobWithoutAmount), amountRaw: "850", notes: " deposit first ", dueDate: "2026-11-01" }, jobWithoutAmount);
  assert.deepEqual(built.input, { jobId: "job-2", amount: 850, title: "Gutters", dueDate: "2026-11-01", notes: "deposit first", alsoSetJobAmount: true });
});

test("create form: the write-back flag is never sent for a job that already has an amount, and invalid values are caught", () => {
  const built = buildCreateInvoiceInput({ ...defaultCreateInvoiceForm(jobWithAmount), alsoSetJobAmount: true }, jobWithAmount);
  assert.equal(built.input?.alsoSetJobAmount, false);
  assert.equal(buildCreateInvoiceInput({ ...defaultCreateInvoiceForm(jobWithAmount), amountRaw: "12.345" }, jobWithAmount).error, "Enter the amount in dollars and cents (no more than two decimal places).");
  assert.equal(buildCreateInvoiceInput({ ...defaultCreateInvoiceForm(jobWithAmount), amountRaw: "0" }, jobWithAmount).error, "Amount must be more than zero.");
  assert.equal(buildCreateInvoiceInput({ ...defaultCreateInvoiceForm(jobWithAmount), dueDate: "31/10/2026" }, jobWithAmount).error, "Enter a valid due date.");
  assert.equal(buildCreateInvoiceInput(defaultCreateInvoiceForm(jobWithAmount), { ...jobWithAmount, status: "cancelled" }).error, "A cancelled job cannot receive a new invoice.");
});

test("payment form: defaults to the balance due and the current local time", () => {
  const now = new Date(2026, 9, 2, 14, 30);
  const form = defaultRecordPaymentForm({ total: 1300.25, amountPaid: 300.25 }, now);
  assert.equal(form.amountRaw, "1000");
  assert.equal(form.receivedAtLocal, "2026-10-02T14:30");
  assert.equal(form.method, "");
});

test("payment form: builds the server input and blocks obvious overpayment, bad methods and future dates before submission", () => {
  const invoice = { id: "inv-1", status: "sent" as const, total: 100, amountPaid: 0, dueDate: null };
  const now = new Date(2026, 9, 10, 9, 0);
  const clientKey = "form-test-key-0001";
  const good = buildRecordPaymentInput({ amountRaw: "40", method: "check", reference: " #22 ", receivedAtLocal: "2026-10-09T15:00", notes: "", clientKey }, invoice, now);
  assert.equal(good.error, undefined);
  assert.equal(good.input?.amount, 40);
  assert.equal(good.input?.method, "check");
  assert.equal(good.input?.reference, "#22");
  assert.equal(good.input?.receivedAt, new Date("2026-10-09T15:00").toISOString());
  assert.equal(good.input?.clientKey, clientKey);

  assert.equal(buildRecordPaymentInput({ amountRaw: "40", method: "", reference: "", receivedAtLocal: "", notes: "", clientKey }, invoice, now).error, "Choose how this payment was received.");
  assert.equal(buildRecordPaymentInput({ amountRaw: "100.01", method: "cash", reference: "", receivedAtLocal: "", notes: "", clientKey }, invoice, now).error, "That is more than the balance due of $100.");
  assert.equal(buildRecordPaymentInput({ amountRaw: "10", method: "cash", reference: "", receivedAtLocal: "2026-10-11T09:00", notes: "", clientKey }, invoice, now).error, "The received date can't be in the future.");
  assert.equal(buildRecordPaymentInput({ amountRaw: "10", method: "cash", reference: "", receivedAtLocal: "not a date", notes: "", clientKey }, invoice, now).error, "Enter a valid received date.");
  const draft = buildRecordPaymentInput({ amountRaw: "10", method: "cash", reference: "", receivedAtLocal: "", notes: "", clientKey }, { ...invoice, status: "draft" }, now);
  assert.match(draft.error ?? "", /issued, unpaid invoice/);
});

test("datetime-local helpers round-trip", () => {
  const local = toDateTimeLocalValue(new Date(2026, 0, 5, 7, 8));
  assert.equal(local, "2026-01-05T07:08");
  assert.equal(dateTimeLocalToIso(local), new Date(2026, 0, 5, 7, 8).toISOString());
  assert.equal(dateTimeLocalToIso(""), null);
});

test("describeReversal states the exact offsetting amount and a readable method", () => {
  assert.deepEqual(describeReversal({ amount: 300.25, method: "card_elsewhere", received_at: "2026-10-02T00:00:00.000Z" }), { reversalAmount: -300.25, methodLabel: "Card (processed elsewhere)" });
});

test("payment form (Phase 1B-5): every new form mints a valid, distinct client key, and the built input carries it unchanged", () => {
  const invoice = { id: "inv-1", status: "sent" as const, total: 500, amountPaid: 0, dueDate: null };
  const a = defaultRecordPaymentForm(invoice);
  const b = defaultRecordPaymentForm(invoice);
  assert.equal(isValidClientKey(a.clientKey), true, a.clientKey);
  assert.notEqual(a.clientKey, b.clientKey, "two dialogs never share a key");

  const explicit = defaultRecordPaymentForm(invoice, new Date("2026-10-02T14:30:00"), "fixed-key-000001");
  assert.equal(explicit.clientKey, "fixed-key-000001");
  const built = buildRecordPaymentInput({ ...explicit, method: "cash" }, invoice, new Date("2026-10-02T15:00:00"));
  assert.equal(built.input?.clientKey, "fixed-key-000001", "a retry of the same form values sends the same key");
});

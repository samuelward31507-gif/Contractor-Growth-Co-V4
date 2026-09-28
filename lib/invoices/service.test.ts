/**
 * Unit tests for lib/invoices/service.ts - the application layer over the
 * Phase 1B invoice schema. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/invoices/service.test.ts
 *
 * What these tests prove: organization scoping of every read and write,
 * that organization_id always comes from the session argument (never from
 * input), the pre-checks and error mapping, the exact rows the service
 * writes, and that no update/delete/automation/outbound call is ever made.
 *
 * What they deliberately do NOT re-prove: the database's own rules
 * (numbering, forced draft shape, frozen totals, overpayment, append-only,
 * reversal uniqueness, RLS and the payment gate). Those are enforced by
 * triggers, constraints and policies in
 * supabase/migrations/20260928162500_invoice_foundation.sql and proven by
 * supabase/pending/scratch/validate.mjs (79 checks against a real Postgres).
 * The fake client below applies only simple filters; where a test needs the
 * database to reject something, it injects the database's real error so the
 * mapping is what is under test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const {
  createInvoiceFromJobForOrganization,
  describeDatabaseError,
  issueInvoiceForOrganization,
  recordCustomerPaymentForOrganization,
  reverseCustomerPaymentForOrganization,
  voidInvoiceForOrganization,
}: typeof import("./service") = require("./service.ts");

// ---------------------------------------------------------------------------
// Fake Supabase client: in-memory tables, simple filters, call recording,
// injectable database errors. Enough to observe what the service asks for.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Filter = [op: "eq" | "neq" | "in" | "is", column: string, value: unknown];
type Call = { table: string; op: "select" | "insert" | "update" | "delete"; payload?: unknown; filters: Filter[] };
type DbError = { code: string; message: string };

type FakeOptions = {
  /** Emulates DB-assigned columns (number, status, amount_paid) on insert. */
  onInsert?: (table: string, row: Row) => Row;
  insertError?: (table: string, row: Row) => DbError | null;
  updateError?: (table: string, patch: Row, filters: Filter[]) => DbError | null;
  rpcError?: DbError | null;
};

function makeFakeSupabase(tables: Record<string, Row[]>, options: FakeOptions = {}) {
  const calls: Call[] = [];
  const rpcCalls: { fn: string; args: Row }[] = [];

  function builder(table: string) {
    const filters: Filter[] = [];
    let op: Call["op"] = "select";
    let payload: unknown;
    let single = false;
    let maybe = false;
    let limitN: number | undefined;

    function matches(row: Row): boolean {
      return filters.every(([kind, column, value]) => {
        if (kind === "eq") return row[column] === value;
        if (kind === "neq") return row[column] !== value;
        if (kind === "in") return (value as unknown[]).includes(row[column]);
        return row[column] === value;
      });
    }

    function execute() {
      const rows = (tables[table] ??= []);
      calls.push({ table, op, payload, filters: [...filters] });
      let result: Row[] = [];
      if (op === "select") {
        result = rows.filter(matches);
      } else if (op === "insert") {
        const incoming = (Array.isArray(payload) ? payload : [payload]) as Row[];
        for (const row of incoming) {
          const err = options.insertError?.(table, row);
          if (err) return { data: null, error: err };
        }
        const inserted = incoming.map((row, i) => {
          const base: Row = { id: `${table}-${rows.length + i + 1}`, created_at: "2026-10-01T00:00:00.000Z", ...row };
          return options.onInsert ? options.onInsert(table, base) : base;
        });
        rows.push(...inserted);
        result = inserted;
      } else if (op === "update") {
        const err = options.updateError?.(table, payload as Row, filters);
        if (err) return { data: null, error: err };
        result = rows.filter(matches);
        for (const row of result) Object.assign(row, payload as Row);
      } else {
        // The service must never delete; recording the call is enough for
        // the assertion that it never happens.
        result = [];
      }
      if (limitN !== undefined) result = result.slice(0, limitN);
      if (single) return result.length === 1 ? { data: result[0], error: null } : { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
      if (maybe) return { data: result[0] ?? null, error: null };
      return { data: result, error: null };
    }

    const b: Record<string, unknown> = {
      select: () => b,
      insert: (rows: unknown) => ((op = "insert"), (payload = rows), b),
      update: (patch: unknown) => ((op = "update"), (payload = patch), b),
      delete: () => ((op = "delete"), b),
      eq: (column: string, value: unknown) => (filters.push(["eq", column, value]), b),
      neq: (column: string, value: unknown) => (filters.push(["neq", column, value]), b),
      in: (column: string, value: unknown) => (filters.push(["in", column, value]), b),
      is: (column: string, value: unknown) => (filters.push(["is", column, value]), b),
      order: () => b,
      limit: (n: number) => ((limitN = n), b),
      maybeSingle: () => ((maybe = true), b),
      single: () => ((single = true), b),
      then: (resolve: (value: unknown) => void) => resolve(execute()),
    };
    return b;
  }

  const client = {
    from: builder,
    rpc: async (fn: string, args: Row) => {
      rpcCalls.push({ fn, args });
      return options.rpcError ? { data: null, error: options.rpcError } : { data: {}, error: null };
    },
  } as unknown as SupabaseClient;

  return { client, calls, rpcCalls, tables };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_A = "org-a";
const ORG_B = "org-b";
const USER_A = "user-a";

function job(overrides: Partial<Row> = {}): Row {
  return {
    id: "job-1",
    organization_id: ORG_A,
    contact_id: "contact-1",
    lead_id: null,
    estimate_id: "estimate-1",
    title: "Roof replacement",
    amount: 1300.25,
    status: "completed",
    started_at: null,
    completed_at: "2026-09-20T00:00:00.000Z",
    notes: null,
    created_at: "2026-09-10T00:00:00.000Z",
    updated_at: "2026-09-20T00:00:00.000Z",
    contact: { id: "contact-1", first_name: "Ann", last_name: "Lee", company_name: null, phone: null, email: null },
    lead: null,
    estimate: { id: "estimate-1", title: "Roof replacement", status: "accepted", amount: 1300.25 },
    ...overrides,
  };
}

function invoice(overrides: Partial<Row> = {}): Row {
  return {
    id: "inv-1",
    organization_id: ORG_A,
    job_id: "job-1",
    contact_id: "contact-1",
    estimate_id: "estimate-1",
    number: 7,
    status: "sent",
    title: "Roof replacement",
    subtotal: 1300.25,
    tax_amount: 0,
    total: 1300.25,
    amount_paid: 0,
    balance_due: 1300.25,
    issued_at: "2026-10-01T15:00:00.000Z",
    sent_at: "2026-10-01T15:00:00.000Z",
    due_date: "2026-10-15",
    paid_at: null,
    voided_at: null,
    void_reason: null,
    notes: null,
    created_by: USER_A,
    created_at: "2026-10-01T14:00:00.000Z",
    updated_at: "2026-10-01T15:00:00.000Z",
    job: { id: "job-1", title: "Roof replacement", status: "completed", amount: 1300.25 },
    contact: { id: "contact-1", first_name: "Ann", last_name: "Lee", company_name: null, phone: null, email: null },
    estimate: null,
    ...overrides,
  };
}

function payment(overrides: Partial<Row> = {}): Row {
  return {
    id: "pay-1",
    organization_id: ORG_A,
    invoice_id: "inv-1",
    job_id: "job-1",
    contact_id: "contact-1",
    amount: 300.25,
    method: "check",
    reference: "#1001",
    received_at: "2026-10-02T00:00:00.000Z",
    reverses_payment_id: null,
    recorded_by: USER_A,
    notes: null,
    created_at: "2026-10-02T00:00:00.000Z",
    ...overrides,
  };
}

/** Emulates what invoices_guard_insert does to a fresh row so the service sees a realistic draft back. */
const dbAssignsDraftShape: FakeOptions["onInsert"] = (table, row) =>
  table === "invoices" ? { ...row, number: 1, status: "draft", amount_paid: 0, balance_due: row.total } : row;

function writes(calls: Call[], table: string) {
  return calls.filter((call) => call.table === table && call.op !== "select");
}

// ---------------------------------------------------------------------------
// describeDatabaseError
// ---------------------------------------------------------------------------

test("describeDatabaseError maps unique violations, RLS and trigger raises into plain language", () => {
  assert.equal(describeDatabaseError({ code: "23505", message: 'duplicate key value violates unique constraint "invoices_one_live_per_job"' }, "x"), "This job already has a live invoice. Void it first to issue a new one.");
  assert.equal(describeDatabaseError({ code: "23505", message: '... "customer_payments_reversal_unique"' }, "x"), "This payment has already been reversed.");
  assert.equal(describeDatabaseError({ code: "42501", message: "new row violates row-level security policy" }, "x"), "You don't have access to that record.");
  assert.equal(describeDatabaseError({ code: "P0001", message: "A cancelled job cannot receive a new invoice" }, "x"), "A cancelled job cannot receive a new invoice");
  assert.equal(describeDatabaseError({ code: "XX000", message: "internal" }, "fallback"), "fallback");
  assert.equal(describeDatabaseError(null, "fallback"), "fallback");
});

// ---------------------------------------------------------------------------
// Create draft from job
// ---------------------------------------------------------------------------

test("create: a valid job produces a draft with the job's contracted amount, relationships left to the database, organization from the session", async () => {
  const fake = makeFakeSupabase({ jobs: [job()], invoices: [] }, { onInsert: dbAssignsDraftShape });
  const result = await createInvoiceFromJobForOrganization(fake.client, ORG_A, USER_A, { jobId: "job-1" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.total, 1300.25);
  assert.equal(result.data.label, "INV-000001");
  assert.equal(result.data.jobAmountUpdated, false);

  const [insert] = writes(fake.calls, "invoices");
  assert.equal(insert.op, "insert");
  const row = insert.payload as Row;
  assert.equal(row.organization_id, ORG_A, "organization_id comes from the session argument");
  assert.equal(row.job_id, "job-1");
  assert.equal(row.subtotal, 1300.25);
  assert.equal(row.tax_amount, 0);
  assert.equal(row.total, 1300.25);
  assert.equal(row.title, "Roof replacement");
  assert.equal(row.created_by, USER_A);
  assert.equal("status" in row, false, "status is never sent - the trigger forces draft");
  assert.equal("number" in row, false, "number is never sent - the trigger assigns it");
  assert.equal("amount_paid" in row, false);
  assert.equal("contact_id" in row, false, "contact/estimate are copied from the job by the trigger");
  assert.equal(writes(fake.calls, "jobs").length, 0, "the job is not touched unless alsoSetJobAmount is requested");
  assert.deepEqual(fake.rpcCalls.map((c) => c.fn), ["create_invoice_audit_event"]);
  assert.equal(fake.rpcCalls[0].args.p_action, "invoice_created");
});

test("create: the job lookup is organization-scoped, so a job from another organization is not found", async () => {
  const fake = makeFakeSupabase({ jobs: [job({ organization_id: ORG_B })], invoices: [] });
  const result = await createInvoiceFromJobForOrganization(fake.client, ORG_A, USER_A, { jobId: "job-1" });
  assert.deepEqual(result, { ok: false, error: "This job could not be found." });
  const lookup = fake.calls.find((c) => c.table === "jobs");
  assert.ok(lookup?.filters.some(([op, col, val]) => op === "eq" && col === "organization_id" && val === ORG_A));
  assert.equal(writes(fake.calls, "invoices").length, 0);
});

test("create: a client-supplied organization_id in the input is ignored", async () => {
  const fake = makeFakeSupabase({ jobs: [job()], invoices: [] }, { onInsert: dbAssignsDraftShape });
  const smuggled = { jobId: "job-1", organization_id: ORG_B, organizationId: ORG_B } as unknown as Parameters<typeof createInvoiceFromJobForOrganization>[3];
  const result = await createInvoiceFromJobForOrganization(fake.client, ORG_A, USER_A, smuggled);
  assert.equal(result.ok, true);
  const [insert] = writes(fake.calls, "invoices");
  assert.equal((insert.payload as Row).organization_id, ORG_A);
});

test("create: a cancelled job is rejected before any write", async () => {
  const fake = makeFakeSupabase({ jobs: [job({ status: "cancelled" })], invoices: [] });
  const result = await createInvoiceFromJobForOrganization(fake.client, ORG_A, USER_A, { jobId: "job-1" });
  assert.deepEqual(result, { ok: false, error: "A cancelled job cannot receive a new invoice." });
  assert.equal(writes(fake.calls, "invoices").length, 0);
});

test("create: a job with no amount requires an explicit amount", async () => {
  const fake = makeFakeSupabase({ jobs: [job({ amount: null })], invoices: [] });
  const result = await createInvoiceFromJobForOrganization(fake.client, ORG_A, USER_A, { jobId: "job-1" });
  assert.deepEqual(result, { ok: false, error: "This job has no contracted amount yet. Enter the invoice total." });
  assert.equal(writes(fake.calls, "invoices").length, 0);
});

test("create: an explicit amount is validated and overrides the prefill; the job amount is untouched by default", async () => {
  const fake = makeFakeSupabase({ jobs: [job()], invoices: [] }, { onInsert: dbAssignsDraftShape });
  assert.equal((await createInvoiceFromJobForOrganization(fake.client, ORG_A, USER_A, { jobId: "job-1", amount: "12.345" })).error, "Enter the amount in dollars and cents (no more than two decimal places).");
  assert.equal((await createInvoiceFromJobForOrganization(fake.client, ORG_A, USER_A, { jobId: "job-1", amount: "0" })).error, "Amount must be more than zero.");
  const result = await createInvoiceFromJobForOrganization(fake.client, ORG_A, USER_A, { jobId: "job-1", amount: "1500" });
  assert.equal(result.ok, true);
  assert.equal(result.data?.total, 1500);
  assert.equal(fake.tables.jobs[0].amount, 1300.25, "job amount is never resynced from the invoice");
});

test("create: alsoSetJobAmount writes the amount back only when the job had none, and only if it is still null", async () => {
  const fake = makeFakeSupabase({ jobs: [job({ amount: null })], invoices: [] }, { onInsert: dbAssignsDraftShape });
  const result = await createInvoiceFromJobForOrganization(fake.client, ORG_A, USER_A, { jobId: "job-1", amount: 800, alsoSetJobAmount: true });
  assert.equal(result.ok, true);
  assert.equal(result.data?.jobAmountUpdated, true);
  const [update] = writes(fake.calls, "jobs");
  assert.deepEqual(update.payload, { amount: 800 });
  assert.ok(update.filters.some(([, col, val]) => col === "organization_id" && val === ORG_A));
  assert.ok(update.filters.some(([op, col, val]) => op === "is" && col === "amount" && val === null), "guarded so a real amount is never overwritten");

  const fake2 = makeFakeSupabase({ jobs: [job()], invoices: [] }, { onInsert: dbAssignsDraftShape });
  const result2 = await createInvoiceFromJobForOrganization(fake2.client, ORG_A, USER_A, { jobId: "job-1", amount: 999, alsoSetJobAmount: true });
  assert.equal(result2.ok, true);
  assert.equal(result2.data?.jobAmountUpdated, false);
  assert.equal(writes(fake2.calls, "jobs").length, 0, "a job that already has an amount is never overwritten");
});

test("create: a live invoice already on the job is rejected before the write, and the database's unique violation is mapped if it races", async () => {
  const fake = makeFakeSupabase({ jobs: [job()], invoices: [invoice({ status: "sent" })] });
  const result = await createInvoiceFromJobForOrganization(fake.client, ORG_A, USER_A, { jobId: "job-1" });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /already has invoice INV-000007 \(Sent\)/);
  assert.equal(writes(fake.calls, "invoices").length, 0);

  // A void invoice does not block re-issue.
  const fake2 = makeFakeSupabase({ jobs: [job()], invoices: [invoice({ status: "void" })] }, { onInsert: dbAssignsDraftShape });
  assert.equal((await createInvoiceFromJobForOrganization(fake2.client, ORG_A, USER_A, { jobId: "job-1" })).ok, true);

  // Race: the pre-check passed but the partial unique index fired.
  const fake3 = makeFakeSupabase({ jobs: [job()], invoices: [] }, { insertError: () => ({ code: "23505", message: 'duplicate key value violates unique constraint "invoices_one_live_per_job"' }) });
  assert.deepEqual(await createInvoiceFromJobForOrganization(fake3.client, ORG_A, USER_A, { jobId: "job-1" }), { ok: false, error: "This job already has a live invoice. Void it first to issue a new one." });
});

test("create: a trigger rejection from the database is surfaced verbatim, not swallowed", async () => {
  const fake = makeFakeSupabase({ jobs: [job()], invoices: [] }, { insertError: () => ({ code: "P0001", message: "job_id must belong to the same organization_id" }) });
  const result = await createInvoiceFromJobForOrganization(fake.client, ORG_A, USER_A, { jobId: "job-1" });
  assert.deepEqual(result, { ok: false, error: "job_id must belong to the same organization_id" });
});

test("create: an invalid due date is rejected; a valid one is passed through as a calendar date", async () => {
  const fake = makeFakeSupabase({ jobs: [job()], invoices: [] }, { onInsert: dbAssignsDraftShape });
  assert.equal((await createInvoiceFromJobForOrganization(fake.client, ORG_A, USER_A, { jobId: "job-1", dueDate: "10/31/2026" })).error, "Enter a valid due date.");
  const result = await createInvoiceFromJobForOrganization(fake.client, ORG_A, USER_A, { jobId: "job-1", dueDate: "2026-10-31", notes: "  net 30 agreed  " });
  assert.equal(result.ok, true);
  const [insert] = writes(fake.calls, "invoices");
  assert.equal((insert.payload as Row).due_date, "2026-10-31");
  assert.equal((insert.payload as Row).notes, "net 30 agreed");
});

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

test("issue: draft -> sent is a compare-and-swap on status, the database supplies the dates, and nothing else is triggered", async () => {
  const draft = invoice({ status: "draft", issued_at: null, sent_at: null, due_date: null });
  const fake = makeFakeSupabase({ invoices: [draft] });
  const result = await issueInvoiceForOrganization(fake.client, ORG_A, "inv-1");
  assert.equal(result.ok, true);
  const [update] = writes(fake.calls, "invoices");
  assert.deepEqual(update.payload, { status: "sent" }, "only the status is sent; issued_at/sent_at/due_date are the trigger's");
  assert.ok(update.filters.some(([, col, val]) => col === "organization_id" && val === ORG_A));
  assert.ok(update.filters.some(([, col, val]) => col === "status" && val === "draft"), "compare-and-swap on draft");
  assert.deepEqual(fake.rpcCalls.map((c) => c.fn), ["create_invoice_audit_event"], "no automation event, no outbound, only the audit row");
  assert.equal(fake.rpcCalls[0].args.p_action, "invoice_issued");
});

test("issue: an explicit due date is validated and passed; the default is left to the database", async () => {
  const fake = makeFakeSupabase({ invoices: [invoice({ status: "draft", issued_at: null, sent_at: null, due_date: null })] });
  assert.equal((await issueInvoiceForOrganization(fake.client, ORG_A, "inv-1", { dueDate: "next week" })).error, "Enter a valid due date.");
  const result = await issueInvoiceForOrganization(fake.client, ORG_A, "inv-1", { dueDate: "2026-11-01" });
  assert.equal(result.ok, true);
  const [update] = writes(fake.calls, "invoices");
  assert.deepEqual(update.payload, { status: "sent", due_date: "2026-11-01" });
});

test("issue: invalid transitions are rejected before any write", async () => {
  for (const status of ["sent", "partially_paid", "paid", "void"]) {
    const fake = makeFakeSupabase({ invoices: [invoice({ status })] });
    const result = await issueInvoiceForOrganization(fake.client, ORG_A, "inv-1");
    assert.equal(result.ok, false, status);
    assert.match(result.error ?? "", /Only a draft can be issued/);
    assert.equal(writes(fake.calls, "invoices").length, 0);
  }
});

test("issue: a zero-total draft cannot be issued; an invoice from another organization is not found", async () => {
  const zero = makeFakeSupabase({ invoices: [invoice({ status: "draft", total: 0, subtotal: 0, balance_due: 0 })] });
  assert.equal((await issueInvoiceForOrganization(zero.client, ORG_A, "inv-1")).error, "Set a total greater than zero before issuing this invoice.");
  const other = makeFakeSupabase({ invoices: [invoice({ status: "draft", organization_id: ORG_B })] });
  assert.deepEqual(await issueInvoiceForOrganization(other.client, ORG_A, "inv-1"), { ok: false, error: "This invoice could not be found." });
});

test("issue: a lost compare-and-swap (someone else issued or voided first) is reported, and a trigger raise passes through", async () => {
  const fake = makeFakeSupabase({ invoices: [invoice({ status: "draft" })] }, {
    updateError: () => ({ code: "P0001", message: "invalid invoice status transition draft -> sent" }),
  });
  assert.deepEqual(await issueInvoiceForOrganization(fake.client, ORG_A, "inv-1"), { ok: false, error: "invalid invoice status transition draft -> sent" });
});

// ---------------------------------------------------------------------------
// Void
// ---------------------------------------------------------------------------

test("void: a sent invoice with nothing collected is voided via update, never delete, with the reason recorded", async () => {
  const fake = makeFakeSupabase({ invoices: [invoice({ status: "sent" })] });
  const result = await voidInvoiceForOrganization(fake.client, ORG_A, "inv-1", "  wrong amount ");
  assert.deepEqual(result, { ok: true, data: { id: "inv-1", status: "void" } });
  const [update] = writes(fake.calls, "invoices");
  assert.equal(update.op, "update");
  assert.deepEqual(update.payload, { status: "void", void_reason: "wrong amount" });
  assert.ok(update.filters.some(([op, col]) => op === "in" && col === "status"));
  assert.equal(fake.calls.some((c) => c.op === "delete"), false);
  assert.equal(fake.rpcCalls[0].args.p_action, "invoice_voided");
});

test("void: drafts can be voided; paid, partially paid and already-void invoices cannot; money on the invoice blocks it", async () => {
  assert.equal((await voidInvoiceForOrganization(makeFakeSupabase({ invoices: [invoice({ status: "draft" })] }).client, ORG_A, "inv-1")).ok, true);
  for (const status of ["partially_paid", "paid"]) {
    const fake = makeFakeSupabase({ invoices: [invoice({ status, amount_paid: 100 })] });
    const result = await voidInvoiceForOrganization(fake.client, ORG_A, "inv-1");
    assert.equal(result.error, "An invoice with recorded payments cannot be voided. Reverse the payments first.");
    assert.equal(writes(fake.calls, "invoices").length, 0);
  }
  assert.equal((await voidInvoiceForOrganization(makeFakeSupabase({ invoices: [invoice({ status: "void" })] }).client, ORG_A, "inv-1")).error, "This invoice is already void.");
  // Defense in depth: the trigger's own refusal is surfaced verbatim.
  const guarded = makeFakeSupabase({ invoices: [invoice({ status: "sent" })] }, { updateError: () => ({ code: "P0001", message: "An invoice with recorded payments cannot be voided; reverse the payments first" }) });
  assert.equal((await voidInvoiceForOrganization(guarded.client, ORG_A, "inv-1")).error, "An invoice with recorded payments cannot be voided; reverse the payments first");
});

test("void: organization isolation", async () => {
  const fake = makeFakeSupabase({ invoices: [invoice({ organization_id: ORG_B })] });
  assert.deepEqual(await voidInvoiceForOrganization(fake.client, ORG_A, "inv-1"), { ok: false, error: "This invoice could not be found." });
  assert.equal(writes(fake.calls, "invoices").length, 0);
});

// ---------------------------------------------------------------------------
// Record payment
// ---------------------------------------------------------------------------

/** Emulates customer_payments_apply so the re-read after insert reflects the ledger. */
function withLedgerApply(tables: Record<string, Row[]>): FakeOptions["onInsert"] {
  return (table, row) => {
    if (table !== "customer_payments") return row;
    const inv = tables.invoices.find((i) => i.id === row.invoice_id)!;
    const paid = tables.customer_payments.reduce((sum, p) => sum + Number(p.amount), 0) + Number(row.amount);
    inv.amount_paid = paid;
    inv.balance_due = Number(inv.total) - paid;
    inv.status = paid >= Number(inv.total) ? "paid" : paid > 0 ? "partially_paid" : "sent";
    inv.paid_at = paid >= Number(inv.total) ? "2026-10-05T00:00:00.000Z" : null;
    return row;
  };
}

for (const method of ["cash", "check", "card_elsewhere", "bank_transfer", "other"] as const) {
  test(`record: a ${method} partial payment inserts exactly one append-only row and returns the database's new state`, async () => {
    const tables = { invoices: [invoice({ status: "sent" })], customer_payments: [] as Row[] };
    const fake = makeFakeSupabase(tables, { onInsert: withLedgerApply(tables) });
    const result = await recordCustomerPaymentForOrganization(fake.client, ORG_A, USER_A, { invoiceId: "inv-1", amount: "300.25", method, reference: " #1001 ", receivedAt: "2026-10-02T00:00:00.000Z" });
    assert.equal(result.ok, true, result.error);
    if (!result.ok) return;
    assert.equal(result.data.invoice.status, "partially_paid");
    assert.equal(result.data.invoice.amount_paid, 300.25);
    assert.equal(result.data.invoice.balance_due, 1000);
    const ledgerWrites = writes(fake.calls, "customer_payments");
    assert.equal(ledgerWrites.length, 1);
    assert.equal(ledgerWrites[0].op, "insert");
    const row = ledgerWrites[0].payload as Row;
    assert.equal(row.organization_id, ORG_A);
    assert.equal(row.invoice_id, "inv-1");
    assert.equal(row.amount, 300.25);
    assert.equal(row.method, method);
    assert.equal(row.reference, "#1001");
    assert.equal(row.received_at, "2026-10-02T00:00:00.000Z");
    assert.equal(row.recorded_by, USER_A);
    assert.equal(row.reverses_payment_id, undefined);
    assert.equal(writes(fake.calls, "invoices").length, 0, "the service never writes amount_paid/status itself");
    assert.equal(fake.rpcCalls[0].args.p_action, "payment_recorded");
  });
}

test("record: an exact final payment moves the invoice to paid with a zero balance", async () => {
  const tables = { invoices: [invoice({ status: "partially_paid", amount_paid: 300.25, balance_due: 1000 })], customer_payments: [payment()] };
  const fake = makeFakeSupabase(tables, { onInsert: withLedgerApply(tables) });
  const result = await recordCustomerPaymentForOrganization(fake.client, ORG_A, USER_A, { invoiceId: "inv-1", amount: 1000, method: "bank_transfer" });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.data?.invoice.status, "paid");
  assert.equal(result.data?.invoice.balance_due, 0);
  assert.equal(result.data?.invoice.paid_at, "2026-10-05T00:00:00.000Z");
});

test("record: overpayment is rejected before any write, by a cent or by a lot", async () => {
  const fake = makeFakeSupabase({ invoices: [invoice({ status: "partially_paid", amount_paid: 300.25, balance_due: 1000 })], customer_payments: [] });
  assert.equal((await recordCustomerPaymentForOrganization(fake.client, ORG_A, USER_A, { invoiceId: "inv-1", amount: 1000.01, method: "cash" })).error, "That is more than the balance due of $1,000.");
  assert.equal((await recordCustomerPaymentForOrganization(fake.client, ORG_A, USER_A, { invoiceId: "inv-1", amount: 99999, method: "cash" })).ok, false);
  assert.equal(writes(fake.calls, "customer_payments").length, 0);
});

test("record: payments against draft, paid and void invoices are rejected before any write", async () => {
  for (const status of ["draft", "paid", "void"]) {
    const fake = makeFakeSupabase({ invoices: [invoice({ status, amount_paid: status === "paid" ? 1300.25 : 0 })], customer_payments: [] });
    const result = await recordCustomerPaymentForOrganization(fake.client, ORG_A, USER_A, { invoiceId: "inv-1", amount: 10, method: "cash" });
    assert.equal(result.ok, false, status);
    assert.match(result.error ?? "", /issued, unpaid invoice/);
    assert.equal(writes(fake.calls, "customer_payments").length, 0);
  }
});

test("record: input validation - method, amount precision, positive amount, received date", async () => {
  const fake = makeFakeSupabase({ invoices: [invoice({ status: "sent" })], customer_payments: [] });
  assert.equal((await recordCustomerPaymentForOrganization(fake.client, ORG_A, USER_A, { invoiceId: "inv-1", amount: 10, method: "crypto" })).error, "Choose how this payment was received.");
  assert.equal((await recordCustomerPaymentForOrganization(fake.client, ORG_A, USER_A, { invoiceId: "inv-1", amount: "10.005", method: "cash" })).error, "Enter the amount in dollars and cents (no more than two decimal places).");
  assert.equal((await recordCustomerPaymentForOrganization(fake.client, ORG_A, USER_A, { invoiceId: "inv-1", amount: "-5", method: "cash" })).error, "Amount cannot be negative.");
  assert.equal((await recordCustomerPaymentForOrganization(fake.client, ORG_A, USER_A, { invoiceId: "inv-1", amount: "0", method: "cash" })).error, "Amount must be more than zero.");
  assert.equal((await recordCustomerPaymentForOrganization(fake.client, ORG_A, USER_A, { invoiceId: "inv-1", amount: 10, method: "cash", receivedAt: "yesterday" })).error, "Enter a valid received date.");
  assert.equal(writes(fake.calls, "customer_payments").length, 0);
});

test("record: a replayed partial payment WITHOUT a client key is recorded again (no key, no replay protection); a replayed final payment is rejected as overpayment", async () => {
  const tables = { invoices: [invoice({ status: "sent" })], customer_payments: [] as Row[] };
  const fake = makeFakeSupabase(tables, { onInsert: withLedgerApply(tables) });
  const first = await recordCustomerPaymentForOrganization(fake.client, ORG_A, USER_A, { invoiceId: "inv-1", amount: 100, method: "cash" });
  const second = await recordCustomerPaymentForOrganization(fake.client, ORG_A, USER_A, { invoiceId: "inv-1", amount: 100, method: "cash" });
  assert.equal(first.ok && second.ok, true);
  assert.equal(tables.customer_payments.length, 2, "documented: an identical partial payment submitted twice is two payments");
  const final = await recordCustomerPaymentForOrganization(fake.client, ORG_A, USER_A, { invoiceId: "inv-1", amount: 1100.25, method: "cash" });
  assert.equal(final.ok, true);
  const replayFinal = await recordCustomerPaymentForOrganization(fake.client, ORG_A, USER_A, { invoiceId: "inv-1", amount: 1100.25, method: "cash" });
  assert.equal(replayFinal.ok, false);
  assert.equal(tables.customer_payments.length, 3);
});

test("record: organization isolation - organization A cannot pay organization B's invoice, and the write carries A's id", async () => {
  const fake = makeFakeSupabase({ invoices: [invoice({ organization_id: ORG_B })], customer_payments: [] });
  const result = await recordCustomerPaymentForOrganization(fake.client, ORG_A, USER_A, { invoiceId: "inv-1", amount: 10, method: "cash" });
  assert.deepEqual(result, { ok: false, error: "This invoice could not be found." });
  assert.equal(writes(fake.calls, "customer_payments").length, 0);
});

test("record: the database's own rejections (overpayment race, RLS) are surfaced", async () => {
  const raced = makeFakeSupabase({ invoices: [invoice({ status: "sent" })], customer_payments: [] }, { insertError: () => ({ code: "P0001", message: "Payment of 500.00 would exceed the balance due of 200.00" }) });
  assert.equal((await recordCustomerPaymentForOrganization(raced.client, ORG_A, USER_A, { invoiceId: "inv-1", amount: 500, method: "cash" })).error, "Payment of 500.00 would exceed the balance due of 200.00");
  const rls = makeFakeSupabase({ invoices: [invoice({ status: "sent" })], customer_payments: [] }, { insertError: () => ({ code: "42501", message: "new row violates row-level security policy for table \"customer_payments\"" }) });
  assert.equal((await recordCustomerPaymentForOrganization(rls.client, ORG_A, USER_A, { invoiceId: "inv-1", amount: 5, method: "cash" })).error, "You don't have access to that record.");
});

// ---------------------------------------------------------------------------
// Reverse payment
// ---------------------------------------------------------------------------

test("reverse: a valid reversal inserts a negative row pointing at the original, leaves the original untouched, and returns the database's state", async () => {
  const tables = { invoices: [invoice({ status: "paid", amount_paid: 1300.25, balance_due: 0, paid_at: "2026-10-05T00:00:00.000Z" })], customer_payments: [payment({ id: "pay-1", amount: 300.25 }), payment({ id: "pay-2", amount: 1000, method: "bank_transfer", reference: null })] };
  const fake = makeFakeSupabase(tables, { onInsert: withLedgerApply(tables) });
  const result = await reverseCustomerPaymentForOrganization(fake.client, ORG_A, USER_A, { paymentId: "pay-2", notes: "bounced" });
  assert.equal(result.ok, true, result.error);
  if (!result.ok) return;
  assert.deepEqual(result.data.original, { id: "pay-2", amount: 1000, method: "bank_transfer" });
  assert.equal(result.data.invoice.status, "partially_paid");
  assert.equal(result.data.invoice.amount_paid, 300.25);
  assert.equal(result.data.invoice.paid_at, null);

  const ledgerWrites = writes(fake.calls, "customer_payments");
  assert.equal(ledgerWrites.length, 1);
  assert.equal(ledgerWrites[0].op, "insert");
  const row = ledgerWrites[0].payload as Row;
  assert.equal(row.amount, -1000);
  assert.equal(row.reverses_payment_id, "pay-2");
  assert.equal(row.method, "bank_transfer");
  assert.equal(row.organization_id, ORG_A);
  assert.equal(row.notes, "bounced");
  const original = tables.customer_payments.find((p) => p.id === "pay-2")!;
  assert.equal(original.amount, 1000);
  assert.equal(original.reverses_payment_id, null);
  assert.equal(fake.calls.some((c) => c.table === "customer_payments" && (c.op === "update" || c.op === "delete")), false, "append-only: no update or delete ever issued");
  assert.equal(fake.rpcCalls[0].args.p_action, "payment_reversed");
});

test("reverse: double reversal and reversal of a reversal are rejected before any write", async () => {
  const ledger = [payment({ id: "pay-1", amount: 300.25 }), payment({ id: "rev-1", amount: -300.25, reverses_payment_id: "pay-1" })];
  const fake = makeFakeSupabase({ invoices: [invoice({ status: "sent" })], customer_payments: ledger });
  assert.equal((await reverseCustomerPaymentForOrganization(fake.client, ORG_A, USER_A, { paymentId: "pay-1" })).error, "This payment has already been reversed.");
  assert.equal((await reverseCustomerPaymentForOrganization(fake.client, ORG_A, USER_A, { paymentId: "rev-1" })).error, "A reversal cannot itself be reversed.");
  assert.equal(writes(fake.calls, "customer_payments").length, 0);
  // Race: the unique constraint fired anyway.
  const raced = makeFakeSupabase({ invoices: [invoice({ status: "partially_paid", amount_paid: 300.25 })], customer_payments: [payment({ id: "pay-1", amount: 300.25 })] }, { insertError: () => ({ code: "23505", message: 'duplicate key value violates unique constraint "customer_payments_reversal_unique"' }) });
  assert.equal((await reverseCustomerPaymentForOrganization(raced.client, ORG_A, USER_A, { paymentId: "pay-1" })).error, "This payment has already been reversed.");
});

test("reverse: organization isolation - a payment from another organization is not found", async () => {
  const fake = makeFakeSupabase({ invoices: [invoice({ organization_id: ORG_B })], customer_payments: [payment({ organization_id: ORG_B })] });
  assert.deepEqual(await reverseCustomerPaymentForOrganization(fake.client, ORG_A, USER_A, { paymentId: "pay-1" }), { ok: false, error: "This payment could not be found." });
  assert.equal(writes(fake.calls, "customer_payments").length, 0);
});

test("reverse: a void invoice's payments cannot be reversed", async () => {
  const fake = makeFakeSupabase({ invoices: [invoice({ status: "void", voided_at: "2026-10-06T00:00:00.000Z" })], customer_payments: [payment()] });
  assert.equal((await reverseCustomerPaymentForOrganization(fake.client, ORG_A, USER_A, { paymentId: "pay-1" })).error, "Payments on a Void invoice cannot be reversed.");
});

// ---------------------------------------------------------------------------
// Audit failures never block money
// ---------------------------------------------------------------------------

test("an audit RPC failure is logged and never turns a committed change into an error", async () => {
  const tables = { invoices: [invoice({ status: "sent" })], customer_payments: [] as Row[] };
  const fake = makeFakeSupabase(tables, { onInsert: withLedgerApply(tables), rpcError: { code: "P0001", message: "Not authorized" } });
  const originalError = console.error;
  const logged: unknown[] = [];
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    const result = await recordCustomerPaymentForOrganization(fake.client, ORG_A, USER_A, { invoiceId: "inv-1", amount: 50, method: "cash" });
    assert.equal(result.ok, true);
  } finally {
    console.error = originalError;
  }
  assert.equal(logged.length, 1);
});

// ---------------------------------------------------------------------------
// Phase 1B-5: client-key idempotency
// ---------------------------------------------------------------------------

const KEY = "3f0b6c1e-2b7a-4c1d-9c0e-1a2b3c4d5e6f";

/** Emulates customer_payments_apply for the one invoice these tests pay. */
function applyLedger(tables: Record<string, Row[]>, invoiceId: string) {
  const inv = tables.invoices.find((row) => row.id === invoiceId)!;
  const paid = (tables.customer_payments ?? []).filter((row) => row.invoice_id === invoiceId).reduce((sum, row) => sum + (row.amount as number), 0);
  inv.amount_paid = paid;
  inv.balance_due = (inv.total as number) - paid;
  inv.status = paid >= (inv.total as number) ? "paid" : paid > 0 ? "partially_paid" : "sent";
  inv.paid_at = paid >= (inv.total as number) ? "2026-10-02T00:00:00.000Z" : null;
}

test("record: the first submission with a client key stores the key and inserts once; the second with the same key inserts nothing, audits nothing, and returns the same payment with replayed: true", async () => {
  const { client, calls, rpcCalls, tables } = makeFakeSupabase({ invoices: [invoice()], customer_payments: [] }, { onInsert: (table, row) => row });
  const input = { invoiceId: "inv-1", amount: 300.25, method: "check", clientKey: KEY };

  const first = await recordCustomerPaymentForOrganization(client, ORG_A, USER_A, input);
  assert.equal(first.ok, true);
  assert.equal(first.data?.replayed, false);
  applyLedger(tables, "inv-1");
  const inserted = writes(calls, "customer_payments");
  assert.equal(inserted.length, 1);
  assert.equal((inserted[0].payload as Row).client_key, KEY, "the key is written with the row");
  assert.equal(rpcCalls.length, 1, "one audit entry");

  const second = await recordCustomerPaymentForOrganization(client, ORG_A, USER_A, input);
  assert.equal(second.ok, true);
  assert.equal(second.data?.replayed, true);
  assert.equal(second.data?.paymentId, first.data?.paymentId, "the same payment, not a new one");
  assert.equal(second.data?.invoice.amount_paid, 300.25, "the invoice state is the database's own, read back");
  assert.equal(writes(calls, "customer_payments").length, 1, "no second insert");
  assert.equal(rpcCalls.length, 1, "no second audit entry");
  assert.equal(tables.customer_payments.length, 1);
});

test("record: a replayed FINAL payment with the same key resolves idempotently instead of failing the overpayment pre-check (the invoice is already paid)", async () => {
  const { client, calls, tables } = makeFakeSupabase({ invoices: [invoice()], customer_payments: [] });
  const input = { invoiceId: "inv-1", amount: 1300.25, method: "cash", clientKey: KEY };
  const first = await recordCustomerPaymentForOrganization(client, ORG_A, USER_A, input);
  assert.equal(first.ok, true);
  applyLedger(tables, "inv-1");
  assert.equal(tables.invoices[0].status, "paid");

  const replay = await recordCustomerPaymentForOrganization(client, ORG_A, USER_A, input);
  assert.equal(replay.ok, true, replay.ok ? "" : replay.error);
  assert.equal(replay.data?.replayed, true);
  assert.equal(replay.data?.invoice.status, "paid");
  assert.equal(writes(calls, "customer_payments").length, 1);
});

test("record: a race that loses to the unique index (23505 on customer_payments_org_client_key_unique) resolves to the winning row, never to a second insert or an audit entry", async () => {
  let planted: Row[] | null = null;
  const { client, calls, rpcCalls, tables } = makeFakeSupabase(
    { invoices: [invoice({ status: "partially_paid", amount_paid: 300.25, balance_due: 1000 })], customer_payments: [] },
    {
      insertError: (table, row) => {
        if (table !== "customer_payments" || row.client_key !== KEY) return null;
        // The concurrent request committed between this call's lookup and
        // its insert: the row appears, and the index rejects ours.
        planted!.push(payment({ id: "pay-winner", client_key: KEY }));
        return { code: "23505", message: 'duplicate key value violates unique constraint "customer_payments_org_client_key_unique"' };
      },
    },
  );
  planted = tables.customer_payments;

  const result = await recordCustomerPaymentForOrganization(client, ORG_A, USER_A, { invoiceId: "inv-1", amount: 300.25, method: "check", clientKey: KEY });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  assert.equal(result.data?.replayed, true);
  assert.equal(result.data?.paymentId, "pay-winner");
  assert.equal(tables.customer_payments.length, 1, "exactly one row exists");
  assert.equal(rpcCalls.length, 0, "the loser never audits - the winner already did");
  assert.equal(writes(calls, "customer_payments").length, 1, "one attempted insert, no retry loop");
});

test("record: organization isolation - the same client key used by another organization never resolves here, and the lookup carries this organization's id", async () => {
  const { client, calls, tables } = makeFakeSupabase({
    invoices: [invoice(), invoice({ id: "inv-b", organization_id: ORG_B, job_id: "job-b" })],
    customer_payments: [payment({ id: "pay-b", organization_id: ORG_B, invoice_id: "inv-b", client_key: KEY })],
  });
  const result = await recordCustomerPaymentForOrganization(client, ORG_A, USER_A, { invoiceId: "inv-1", amount: 100, method: "cash", clientKey: KEY });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  assert.equal(result.data?.replayed, false, "organization B's key is not organization A's replay");
  const lookup = calls.find((call) => call.table === "customer_payments" && call.op === "select" && call.filters.some(([, column]) => column === "client_key"));
  assert.ok(lookup, "a key lookup was made");
  assert.deepEqual(lookup!.filters.find(([, column]) => column === "organization_id"), ["eq", "organization_id", ORG_A]);
  assert.equal(tables.customer_payments.filter((row) => row.organization_id === ORG_A).length, 1);
});

test("record: a key already used for a DIFFERENT invoice is refused, never answered with the other invoice's payment", async () => {
  const { client, calls } = makeFakeSupabase({
    invoices: [invoice(), invoice({ id: "inv-2", job_id: "job-2", number: 8 })],
    customer_payments: [payment({ id: "pay-other", invoice_id: "inv-2", client_key: KEY })],
  });
  const result = await recordCustomerPaymentForOrganization(client, ORG_A, USER_A, { invoiceId: "inv-1", amount: 100, method: "cash", clientKey: KEY });
  assert.equal(result.ok, false);
  assert.equal(result.error, "This payment form was already used for a different invoice. Close it and try again.");
  assert.equal(writes(calls, "customer_payments").length, 0);
});

test("record: a malformed client key is rejected before any read or write; an absent key records normally without one", async () => {
  const { client, calls } = makeFakeSupabase({ invoices: [invoice()], customer_payments: [] });
  for (const bad of ["short", "has spaces here", "k".repeat(129), "bad/slash-key"]) {
    const result = await recordCustomerPaymentForOrganization(client, ORG_A, USER_A, { invoiceId: "inv-1", amount: 100, method: "cash", clientKey: bad });
    assert.equal(result.ok, false, `should reject: ${bad}`);
    assert.equal(result.error, "This payment form is out of date. Close it and try again.");
  }
  assert.equal(calls.length, 0, "rejected before touching the database");

  const withoutKey = await recordCustomerPaymentForOrganization(client, ORG_A, USER_A, { invoiceId: "inv-1", amount: 100, method: "cash" });
  assert.equal(withoutKey.ok, true);
  assert.equal(withoutKey.data?.replayed, false);
  const insert = writes(calls, "customer_payments")[0];
  assert.equal("client_key" in (insert.payload as Row), false, "no key column is sent when the client supplied none");
});

test("describeDatabaseError maps the client-key unique violation to the sanctioned wording", () => {
  assert.equal(describeDatabaseError({ code: "23505", message: 'duplicate key value violates unique constraint "customer_payments_org_client_key_unique"' }, "x"), "This payment was already recorded. Refresh to see it.");
});

/**
 * Phase 1B-5: unit tests for the two invoice opportunity detectors
 * (detectCompletedJobsNotInvoiced, detectOverdueInvoices) and for
 * syncOpportunities' creation / deduplication / resolution of them, against
 * a filter-aware in-memory fake client - no database. The database-level
 * guarantees (opportunities_type_check, the open-row dedup index, RLS, the
 * payment gate) are proven by supabase/pending/scratch/
 * validate-payment-idempotency.mjs. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/opportunities/detect.invoices.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { detectCompletedJobsNotInvoiced, detectOverdueInvoices, syncOpportunities }: typeof import("./detect") = require("./detect.ts");

type Row = Record<string, unknown>;
type Filter = { kind: "eq" | "neq" | "in" | "not" | "lte" | "gte" | "lt" | "is"; column: string; value: unknown };
type Call = { table: string; op: string; payload?: unknown; filters: Filter[] };

/** In-memory tables with the filter operators every detector in lib/opportunities/detect.ts uses. Unknown tables are empty - a genuinely quiet organization. */
function makeFakeSupabase(tables: Record<string, Row[]>) {
  const calls: Call[] = [];
  function builder(table: string) {
    const filters: Filter[] = [];
    let op = "select";
    let payload: unknown;
    let maybe = false;
    const matches = (row: Row) =>
      filters.every(({ kind, column, value }) => {
        const actual = row[column];
        if (kind === "eq") return actual === value;
        if (kind === "neq") return actual !== value;
        if (kind === "in") return (value as unknown[]).includes(actual);
        if (kind === "is") return actual === value;
        if (kind === "not") return actual != null; // only ever `.not(col, "is", null)`
        if (kind === "lte") return String(actual) <= String(value);
        if (kind === "gte") return String(actual) >= String(value);
        return String(actual) < String(value);
      });
    function execute() {
      const rows = (tables[table] ??= []);
      calls.push({ table, op, payload, filters: [...filters] });
      let result: Row[] = [];
      if (op === "select") result = rows.filter(matches);
      else if (op === "insert") {
        const incoming = (Array.isArray(payload) ? payload : [payload]) as Row[];
        const inserted = incoming.map((row, i) => ({ id: `${table}-${rows.length + i + 1}`, status: "open", created_at: "2026-10-05T00:00:00.000Z", ...row }));
        rows.push(...inserted);
        result = inserted;
      } else if (op === "update") {
        result = rows.filter(matches);
        for (const row of result) Object.assign(row, payload as Row);
      }
      if (maybe) return { data: result[0] ?? null, error: null };
      return { data: result, error: null };
    }
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (rows: unknown) => ((op = "insert"), (payload = rows), b),
      update: (patch: unknown) => ((op = "update"), (payload = patch), b),
      eq: (column: string, value: unknown) => (filters.push({ kind: "eq", column, value }), b),
      neq: (column: string, value: unknown) => (filters.push({ kind: "neq", column, value }), b),
      in: (column: string, value: unknown) => (filters.push({ kind: "in", column, value }), b),
      is: (column: string, value: unknown) => (filters.push({ kind: "is", column, value }), b),
      not: (column: string) => (filters.push({ kind: "not", column, value: null }), b),
      lte: (column: string, value: unknown) => (filters.push({ kind: "lte", column, value }), b),
      gte: (column: string, value: unknown) => (filters.push({ kind: "gte", column, value }), b),
      lt: (column: string, value: unknown) => (filters.push({ kind: "lt", column, value }), b),
      order: () => b,
      limit: () => b,
      maybeSingle: () => ((maybe = true), b),
      then: (resolve: (value: unknown) => void) => resolve(execute()),
    };
    return b;
  }
  return { client: { from: builder } as unknown as SupabaseClient, calls, tables };
}

const ORG = "org-a";
const NOW = new Date("2026-10-20T15:00:00.000Z"); // 09:00 in America/Denver
const AFTER_LIVE = "2026-10-01T12:00:00.000Z";
const BEFORE_LIVE = "2026-09-28T16:02:03.000Z";
const contact = { id: "contact-1", first_name: "Ann", last_name: "Lee", company_name: null };

const jobs = [
  { id: "job-new", organization_id: ORG, contact_id: "contact-1", title: "Roof", amount: 1300.25, status: "completed", completed_at: AFTER_LIVE, created_at: AFTER_LIVE, contacts: contact },
  { id: "job-no-amount", organization_id: ORG, contact_id: "contact-1", title: "Gutters", amount: null, status: "completed", completed_at: AFTER_LIVE, created_at: AFTER_LIVE, contacts: contact },
  { id: "job-invoiced", organization_id: ORG, contact_id: "contact-1", title: "Deck", amount: 900, status: "completed", completed_at: AFTER_LIVE, created_at: AFTER_LIVE, contacts: contact },
  { id: "job-void-only", organization_id: ORG, contact_id: "contact-1", title: "Fence", amount: 400, status: "completed", completed_at: AFTER_LIVE, created_at: AFTER_LIVE, contacts: contact },
  { id: "job-legacy", organization_id: ORG, contact_id: "contact-1", title: "Old roof", amount: 5000, status: "completed", completed_at: BEFORE_LIVE, created_at: "2026-09-01T00:00:00.000Z", contacts: contact },
  { id: "job-legacy-null", organization_id: ORG, contact_id: "contact-1", title: "Older roof", amount: 7000, status: "completed", completed_at: null, created_at: BEFORE_LIVE, contacts: contact },
  { id: "job-in-progress", organization_id: ORG, contact_id: "contact-1", title: "Siding", amount: 250, status: "in_progress", completed_at: null, created_at: AFTER_LIVE, contacts: contact },
  { id: "job-other-org", organization_id: "org-b", contact_id: "contact-b", title: "B roof", amount: 100, status: "completed", completed_at: AFTER_LIVE, created_at: AFTER_LIVE, contacts: null },
];

const invoices = [
  { id: "inv-live", organization_id: ORG, job_id: "job-invoiced", contact_id: "contact-1", number: 3, title: "Deck", status: "sent", balance_due: 900, due_date: "2026-10-19", contacts: contact },
  { id: "inv-void", organization_id: ORG, job_id: "job-void-only", contact_id: "contact-1", number: 4, title: "Fence", status: "void", balance_due: 400, due_date: "2026-09-01", contacts: contact },
  { id: "inv-due-today", organization_id: ORG, job_id: "job-x", contact_id: "contact-1", number: 5, title: "Due today", status: "partially_paid", balance_due: 50, due_date: "2026-10-20", contacts: contact },
  { id: "inv-paid", organization_id: ORG, job_id: "job-y", contact_id: "contact-1", number: 6, title: "Paid", status: "paid", balance_due: 0, due_date: "2026-01-01", contacts: contact },
  { id: "inv-no-due", organization_id: ORG, job_id: "job-z", contact_id: "contact-1", number: 7, title: "No due", status: "sent", balance_due: 10, due_date: null, contacts: contact },
  { id: "inv-other-org", organization_id: "org-b", job_id: "job-other-org", contact_id: "contact-b", number: 1, title: "B", status: "sent", balance_due: 100, due_date: "2026-01-01", contacts: null },
];

test("completed_job_not_invoiced: completed since go-live with no live invoice - a void-only history counts, legacy jobs (by completed_at or created_at) and non-completed jobs never do", async () => {
  const { client, calls } = makeFakeSupabase({ jobs: [...jobs], invoices: [...invoices] });
  const candidates = await detectCompletedJobsNotInvoiced(client, ORG);
  assert.deepEqual(candidates.map((c) => c.sourceEntityId).sort(), ["job-new", "job-no-amount", "job-void-only"]);
  const roof = candidates.find((c) => c.sourceEntityId === "job-new")!;
  assert.equal(roof.type, "completed_job_not_invoiced");
  assert.equal(roof.sourceEntityType, "job");
  assert.equal(roof.title, "Ann Lee");
  assert.equal(roof.estimatedValue, 1300.25);
  assert.equal(roof.valueBasis, "jobs.amount");
  assert.equal(candidates.find((c) => c.sourceEntityId === "job-no-amount")!.estimatedValue, null, "no amount stays unknown, never $0");
  for (const call of calls) {
    assert.ok(call.filters.some((f) => f.column === "organization_id" && f.value === ORG), `${call.table} read is organization-scoped`);
  }
});

test("invoice_overdue: sent/partially paid invoices whose due_date is before today in the organization's timezone; due today, paid, void and no-due-date are never overdue", async () => {
  const { client, calls, tables } = makeFakeSupabase({ invoices: [...invoices], organizations: [{ id: ORG, timezone: "America/Denver" }] });
  const candidates = await detectOverdueInvoices(client, ORG, NOW);
  assert.deepEqual(candidates.map((c) => c.metadata.invoice_id), ["inv-live"]);
  const overdue = candidates[0];
  assert.equal(overdue.type, "invoice_overdue");
  assert.equal(overdue.sourceEntityType, "job");
  assert.equal(overdue.sourceEntityId, "job-invoiced", "sourced from the job - the stable dedup key");
  assert.equal(overdue.estimatedValue, 900);
  assert.equal(overdue.valueBasis, "invoices.balance_due");
  assert.equal(overdue.description, "INV-000003 was due 2026-10-19 - $900 still outstanding.");
  assert.equal(overdue.metadata.judged_against, "2026-10-20");
  assert.ok(calls.filter((c) => c.table === "invoices").every((c) => c.filters.some((f) => f.column === "organization_id" && f.value === ORG)));

  // Timezone matters: at 2026-10-20T03:00Z it is still Oct 19 in Denver, so an Oct-19 due date is not yet overdue there - but it is in UTC.
  tables.organizations[0].timezone = "America/Denver";
  const stillDenver = await detectOverdueInvoices(client, ORG, new Date("2026-10-20T03:00:00.000Z"));
  assert.deepEqual(stillDenver.map((c) => c.metadata.invoice_id), []);
  tables.organizations[0].timezone = "UTC";
  const utc = await detectOverdueInvoices(client, ORG, new Date("2026-10-20T03:00:00.000Z"));
  assert.deepEqual(utc.map((c) => c.metadata.invoice_id), ["inv-live"]);
});

test("sync: creates each invoice opportunity once, keeps it (no second insert) while the condition holds, and resolves it with condition_no_longer_true once the invoice is paid", async () => {
  const fake = makeFakeSupabase({
    jobs: [jobs[2]], // job-invoiced only
    invoices: [{ ...invoices[0] }], // inv-live, overdue
    organizations: [{ id: ORG, timezone: "America/Denver", review_url: null, automation_mode: "assisted", payment_status: "active", automation_paused: false }],
    opportunities: [],
  });
  const first = await syncOpportunities(fake.client, ORG, NOW);
  const invoiceOpps = () => fake.tables.opportunities.filter((row) => row.type === "invoice_overdue" || row.type === "completed_job_not_invoiced");
  assert.equal(first.created >= 1, true);
  assert.equal(invoiceOpps().length, 1, "one invoice_overdue row");
  const row = invoiceOpps()[0];
  assert.equal(row.type, "invoice_overdue");
  assert.equal(row.organization_id, ORG, "the write carries the caller's organization, never a client value");
  assert.equal(row.source_entity_id, "job-invoiced");
  assert.equal((row.metadata as Row).invoice_id, "inv-live");

  const second = await syncOpportunities(fake.client, ORG, NOW);
  assert.equal(invoiceOpps().length, 1, "dedup: no second row for the same (organization, type, source)");
  assert.equal(second.created, 0);
  assert.ok(second.unchanged >= 1);

  // The customer pays: the invoice leaves the open set, the opportunity resolves.
  fake.tables.invoices[0].status = "paid";
  fake.tables.invoices[0].balance_due = 0;
  const third = await syncOpportunities(fake.client, ORG, NOW);
  assert.equal(third.resolved >= 1, true);
  assert.equal(row.status, "resolved");
  assert.equal(row.resolution_reason, "condition_no_longer_true");
  assert.equal(invoiceOpps().filter((r) => r.status === "open").length, 0);
});

test("sync: a completed job with no invoice becomes completed_job_not_invoiced; issuing an invoice resolves it, and the same job never carries both invoice types at once", async () => {
  const fake = makeFakeSupabase({
    jobs: [jobs[0]], // job-new, completed after go-live, no invoice
    invoices: [],
    organizations: [{ id: ORG, timezone: "America/Denver", review_url: null, automation_mode: "assisted", payment_status: "active", automation_paused: false }],
    opportunities: [],
  });
  await syncOpportunities(fake.client, ORG, NOW);
  const byType = (type: string) => fake.tables.opportunities.filter((row) => row.type === type);
  assert.equal(byType("completed_job_not_invoiced").length, 1);
  assert.equal(byType("invoice_overdue").length, 0);

  // A live, already-overdue invoice appears for that job.
  fake.tables.invoices.push({ id: "inv-new", organization_id: ORG, job_id: "job-new", contact_id: "contact-1", number: 9, title: "Roof", status: "sent", balance_due: 1300.25, due_date: "2026-10-01", contacts: contact });
  await syncOpportunities(fake.client, ORG, NOW);
  assert.equal(byType("completed_job_not_invoiced")[0].status, "resolved", "invoiced now - the not-invoiced opportunity resolves");
  assert.equal(byType("invoice_overdue").filter((r) => r.status === "open").length, 1, "and the overdue one opens - never both open for one job");
});

/**
 * Unit tests for findPersonNextStep - pure, no I/O. Mirrors the priority
 * chain app/(app)/leads/[id]/page.tsx's own "What happens next" already
 * uses, generalized across a whole person's records. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test "lib/people/next-step.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { Lead } from "@/lib/leads/queries";
import type { Appointment } from "@/lib/appointments/queries";
import type { Estimate } from "@/lib/estimates/queries";
import type { Job } from "@/lib/jobs/queries";
import type { Conversation } from "@/lib/conversations/queries";
import type { Invoice } from "@/lib/invoices/queries";

const require = createRequire(import.meta.url);
const { findPersonNextStep }: typeof import("./next-step") = require("./next-step.ts");

const NOW = new Date("2026-01-15T12:00:00.000Z").getTime();

const emptyParams = { leads: [] as Lead[], appointments: [] as Appointment[], estimates: [] as Estimate[], jobs: [] as Job[], conversations: [] as Conversation[], now: NOW };

test("a conversation waiting for a human reply outranks everything else", () => {
  const result = findPersonNextStep({
    ...emptyParams,
    conversations: [{ id: "c1", status: "open", ai_enabled: false }] as unknown as Conversation[],
    appointments: [{ id: "a1", status: "scheduled", start_at: "2026-02-01T00:00:00.000Z" }] as unknown as Appointment[],
  });
  assert.equal(result?.href, "/conversations/c1");
  assert.equal(result?.attention, true);
});

test("an AI-handled open conversation does not count as waiting for a human", () => {
  const result = findPersonNextStep({
    ...emptyParams,
    conversations: [{ id: "c1", status: "open", ai_enabled: true }] as unknown as Conversation[],
  });
  assert.equal(result, null);
});

test("a future scheduled appointment outranks a pending estimate", () => {
  const result = findPersonNextStep({
    ...emptyParams,
    appointments: [{ id: "a1", status: "confirmed", start_at: "2026-02-01T00:00:00.000Z", end_at: "2026-02-01T01:00:00.000Z", title: "Site visit" }] as unknown as Appointment[],
    estimates: [{ id: "e1", status: "sent", title: "Roof estimate" }] as unknown as Estimate[],
  });
  assert.equal(result?.href, "/appointments/a1");
  assert.equal(result?.label, "Appointment scheduled");
});

test("a past appointment is not treated as the next step", () => {
  const result = findPersonNextStep({
    ...emptyParams,
    appointments: [{ id: "a1", status: "confirmed", start_at: "2025-01-01T00:00:00.000Z" }] as unknown as Appointment[],
  });
  assert.equal(result, null);
});

test("a pending estimate outranks a plain follow-up nudge", () => {
  const result = findPersonNextStep({
    ...emptyParams,
    estimates: [{ id: "e1", status: "sent", title: "Roof estimate" }] as unknown as Estimate[],
    leads: [{ id: "l1", status: "qualified", created_at: "2026-01-01T00:00:00.000Z" }] as unknown as Lead[],
  });
  assert.equal(result?.href, "/estimates/e1");
  assert.equal(result?.label, "Estimate awaiting response");
});

test("the most recently created lead decides the won branch - a job in progress is surfaced", () => {
  const result = findPersonNextStep({
    ...emptyParams,
    leads: [
      { id: "l-old", status: "lost", created_at: "2025-01-01T00:00:00.000Z" },
      { id: "l-new", status: "won", created_at: "2026-01-10T00:00:00.000Z" },
    ] as unknown as Lead[],
    jobs: [{ id: "j1", lead_id: "l-new", title: "Kitchen remodel", status: "in_progress" }] as unknown as Job[],
  });
  assert.equal(result?.href, "/jobs/j1");
  assert.equal(result?.label, "Job in progress");
});

// Phase 1B-4: completed jobs read their live invoice instead of "Job in progress".
const WON_LEAD = [{ id: "l1", status: "won", created_at: "2026-01-10T00:00:00.000Z" }] as unknown as Lead[];
const AFTER_LIVE = "2026-10-01T12:00:00.000Z";
const completedJob = (overrides: Partial<Job> = {}) =>
  [{ id: "j1", lead_id: "l1", title: "Kitchen remodel", status: "completed", completed_at: AFTER_LIVE, created_at: AFTER_LIVE, ...overrides }] as unknown as Job[];
type NextStepInvoice = Pick<Invoice, "id" | "job_id" | "number" | "status" | "balance_due" | "due_date">;
const invoice = (overrides: Partial<NextStepInvoice>): NextStepInvoice => ({ id: "inv-1", job_id: "j1", number: 12, status: "sent", balance_due: 450.5, due_date: "2026-10-20", ...overrides });
const OCT_10 = new Date("2026-10-10T12:00:00.000Z").getTime();

test("a completed job with an open invoice balance yields Collect payment, linking to the invoice with the database's own balance", () => {
  const result = findPersonNextStep({ ...emptyParams, leads: WON_LEAD, jobs: completedJob(), invoices: [invoice({})], now: OCT_10 });
  assert.equal(result?.label, "Collect payment");
  assert.equal(result?.href, "/invoices/inv-1");
  assert.equal(result?.detail, "INV-000012 · $450.50 due");
  assert.equal(result?.attention, false, "not yet due, so no attention flag");
});

test("an overdue open balance flags attention and says so; partially paid counts as open", () => {
  const result = findPersonNextStep({ ...emptyParams, leads: WON_LEAD, jobs: completedJob(), invoices: [invoice({ status: "partially_paid", due_date: "2026-10-09" })], now: OCT_10 });
  assert.equal(result?.label, "Collect payment");
  assert.equal(result?.detail, "INV-000012 · $450.50 due · overdue");
  assert.equal(result?.attention, true);
});

test("a completed job whose invoice is fully paid yields no payment-related next step, never Job in progress", () => {
  const result = findPersonNextStep({ ...emptyParams, leads: WON_LEAD, jobs: completedJob(), invoices: [invoice({ status: "paid", balance_due: 0 })], now: OCT_10 });
  assert.equal(result, null);
});

test("a completed job with only a draft invoice yields Issue invoice", () => {
  const result = findPersonNextStep({ ...emptyParams, leads: WON_LEAD, jobs: completedJob(), invoices: [invoice({ status: "draft" })], now: OCT_10 });
  assert.equal(result?.label, "Issue invoice");
  assert.equal(result?.href, "/invoices/inv-1");
});

test("a void invoice is not live - a completed job after go-live with no live invoice yields Create invoice, linking to the job", () => {
  const result = findPersonNextStep({ ...emptyParams, leads: WON_LEAD, jobs: completedJob(), invoices: [invoice({ status: "void" })], now: OCT_10 });
  assert.equal(result?.label, "Create invoice");
  assert.equal(result?.href, "/jobs/j1");
  assert.equal(findPersonNextStep({ ...emptyParams, leads: WON_LEAD, jobs: completedJob(), now: OCT_10 })?.label, "Create invoice", "no invoices passed at all behaves the same");
});

test("a legacy completed job (before INVOICING_LIVE_AT, by completed_at or by created_at when null) with no invoice yields no next step", () => {
  const beforeLive = "2026-09-28T16:02:03.000Z";
  assert.equal(findPersonNextStep({ ...emptyParams, leads: WON_LEAD, jobs: completedJob({ completed_at: beforeLive, created_at: "2026-09-01T00:00:00.000Z" }), now: OCT_10 }), null);
  assert.equal(findPersonNextStep({ ...emptyParams, leads: WON_LEAD, jobs: completedJob({ completed_at: null, created_at: beforeLive }), now: OCT_10 }), null);
  const legacyWithOpenInvoice = findPersonNextStep({ ...emptyParams, leads: WON_LEAD, jobs: completedJob({ completed_at: beforeLive, created_at: "2026-09-01T00:00:00.000Z" }), invoices: [invoice({})], now: OCT_10 });
  assert.equal(legacyWithOpenInvoice?.label, "Collect payment", "a legacy job that WAS invoiced manually still surfaces its open balance");
});

test("a cancelled job yields no next step", () => {
  assert.equal(findPersonNextStep({ ...emptyParams, leads: WON_LEAD, jobs: completedJob({ status: "cancelled" }), now: OCT_10 }), null);
});

test("a waiting conversation still outranks a completed job's open balance", () => {
  const result = findPersonNextStep({
    ...emptyParams,
    leads: WON_LEAD,
    jobs: completedJob(),
    invoices: [invoice({})],
    conversations: [{ id: "c1", status: "open", ai_enabled: false }] as unknown as Conversation[],
    now: OCT_10,
  });
  assert.equal(result?.href, "/conversations/c1");
});

test("the most recent lead won with no matching job yields no next step, not a fabricated one", () => {
  const result = findPersonNextStep({
    ...emptyParams,
    leads: [{ id: "l1", status: "won", created_at: "2026-01-10T00:00:00.000Z" }] as unknown as Lead[],
    jobs: [{ id: "j1", lead_id: "some-other-lead" }] as unknown as Job[],
  });
  assert.equal(result, null);
});

test("the most recent lead lost yields no next step", () => {
  const result = findPersonNextStep({
    ...emptyParams,
    leads: [{ id: "l1", status: "lost", created_at: "2026-01-10T00:00:00.000Z" }] as unknown as Lead[],
  });
  assert.equal(result, null);
});

test("an open, un-won, un-lost lead with nothing else in motion yields a follow-up nudge, flagged for attention", () => {
  const result = findPersonNextStep({
    ...emptyParams,
    leads: [{ id: "l1", status: "contacted", created_at: "2026-01-10T00:00:00.000Z" }] as unknown as Lead[],
  });
  assert.equal(result?.label, "Follow up with customer");
  assert.equal(result?.attention, true);
});

test("no leads at all yields no next step", () => {
  const result = findPersonNextStep(emptyParams);
  assert.equal(result, null);
});

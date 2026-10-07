/**
 * Final Batch 3: the person next action comes from the CANONICAL lifecycle
 * (lib/lifecycle) - every case below is asserted twice: the canonical stage
 * the rows produce, and the action shown for it. A stale leads.status never
 * decides the action when newer records exist.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/people/next-step.lifecycle.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { derivePersonLifecycle, findPersonNextStep, lifecyclePolicyFrom, type PersonNextStepInput } from "./next-step";
import { contactLifecycleFromCanonical } from "@/lib/customers/lifecycle-stage";

type Row = Record<string, unknown>;
const NOW = Date.parse("2026-10-10T15:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
const daysAhead = (days: number) => new Date(NOW + days * 86_400_000).toISOString();

const lead = (id: string, status: string, createdDaysAgo = 5, extra: Row = {}) => ({ id, status, created_at: daysAgo(createdDaysAgo), ...extra });
const appointment = (id: string, status: string, startDays: number, extra: Row = {}) => ({
  id,
  lead_id: "L1",
  status,
  start_at: startDays >= 0 ? daysAhead(startDays) : daysAgo(-startDays),
  end_at: new Date((startDays >= 0 ? NOW + startDays * 86_400_000 : NOW + startDays * 86_400_000) + 3_600_000).toISOString(),
  created_at: daysAgo(4),
  ...extra,
});
const estimate = (id: string, status: string, extra: Row = {}) => ({ id, lead_id: "L1", status, title: "Roof replacement", sent_at: status === "draft" ? null : daysAgo(1), expires_at: null, created_at: daysAgo(2), ...extra });
const job = (id: string, status: string, extra: Row = {}) => ({ id, lead_id: "L1", estimate_id: null, status, title: "Roof job", created_at: daysAgo(3), completed_at: status === "completed" ? daysAgo(2) : null, ...extra });
const invoice = (id: string, jobId: string, status: string, extra: Row = {}) => ({ id, job_id: jobId, number: 7, status, balance_due: status === "paid" ? 0 : 1200, due_date: "2026-11-01", ...extra });
const inbound = (days: number) => ({ direction: "inbound", status: "received", created_at: daysAgo(days) });
const outbound = (days: number) => ({ direction: "outbound", status: "sent", created_at: daysAgo(days) });

function person(rows: Partial<Record<"leads" | "appointments" | "estimates" | "jobs" | "invoices" | "messages", Row[]>>): PersonNextStepInput {
  return {
    contactId: "C1",
    leads: (rows.leads ?? []) as never,
    appointments: (rows.appointments ?? []) as never,
    estimates: (rows.estimates ?? []) as never,
    jobs: (rows.jobs ?? []) as never,
    invoices: (rows.invoices ?? []) as never,
    ...(rows.messages ? { messages: rows.messages as never } : {}),
    conversations: [],
    waitingConversationIds: new Set(),
    policy: lifecyclePolicyFrom(),
    timeZone: "UTC",
    jobsEnabled: true,
    now: NOW,
  };
}
const check = (input: PersonNextStepInput) => ({ stage: derivePersonLifecycle(input).stage, step: findPersonNextStep(input) });

test("new lead -> Respond to new lead (attention)", () => {
  const { stage, step } = check(person({ leads: [lead("L1", "new", 0.1)], messages: [] }));
  assert.equal(stage, "new_lead");
  assert.deepEqual({ label: step?.label, href: step?.href, attention: step?.attention }, { label: "Respond to new lead", href: "/people/C1", attention: true });
});

test("responding lead (business replied, customer has not) -> Follow up with customer", () => {
  const { stage, step } = check(person({ leads: [lead("L1", "new", 2)], messages: [outbound(1)] }));
  assert.equal(stage, "responding");
  assert.equal(step?.label, "Follow up with customer");
});

test("conversing lead (customer replied after the response) -> Continue the conversation", () => {
  const { stage, step } = check(person({ leads: [lead("L1", "contacted", 3)], messages: [outbound(2), inbound(1)] }));
  assert.equal(stage, "conversing");
  assert.equal(step?.label, "Continue the conversation");
});

test("without messages, the lead phase never guesses - one generic follow-up", () => {
  const { stage, step } = check(person({ leads: [lead("L1", "new", 2)] }));
  assert.equal(stage, "new_lead");
  assert.equal(step?.label, "Follow up with customer");
});

test("qualified lead -> Book an appointment", () => {
  const { stage, step } = check(person({ leads: [lead("L1", "qualified")] }));
  assert.equal(stage, "qualified");
  assert.deepEqual({ label: step?.label, href: step?.href }, { label: "Book an appointment", href: "/schedule" });
});

test("booked appointment -> Appointment scheduled (with its own date and time)", () => {
  const { stage, step } = check(person({ leads: [lead("L1", "contacted")], appointments: [appointment("A1", "scheduled", 2)] }));
  assert.equal(stage, "booked");
  assert.equal(step?.label, "Appointment scheduled");
  assert.equal(step?.href, "/appointments/A1");
  assert.equal(step?.detail, "Monday, October 12, 2026 · 3:00 PM – 4:00 PM");
});

test("estimate sent (inside the follow-up window) -> Estimate awaiting response; past the window -> Follow up on estimate", () => {
  const fresh = check(person({ leads: [lead("L1", "contacted")], estimates: [estimate("E1", "sent", { sent_at: new Date(NOW - 3_600_000).toISOString() })] }));
  assert.equal(fresh.stage, "estimate_sent");
  assert.deepEqual({ label: fresh.step?.label, href: fresh.step?.href }, { label: "Estimate awaiting response", href: "/estimates/E1" });
  const late = check(person({ leads: [lead("L1", "contacted")], estimates: [estimate("E1", "sent", { sent_at: daysAgo(3) })] }));
  assert.equal(late.stage, "estimate_follow_up");
  assert.equal(late.step?.label, "Follow up on estimate");
});

test("estimate exists -> never 'qualify/contact the lead', even when the lead still says contacted", () => {
  const { step } = check(person({ leads: [lead("L1", "contacted")], estimates: [estimate("E1", "draft")] }));
  assert.equal(step?.label, "Send the estimate");
  assert.equal(step?.href, "/estimates/E1");
});

test("ACCEPTED ESTIMATE WITH NO JOB -> Create the job, on the accepted estimate (never follow up / qualify / send estimate)", () => {
  for (const leadStatus of ["estimate", "contacted", "won", "qualified"]) {
    const { stage, step } = check(person({ leads: [lead("L1", leadStatus)], estimates: [estimate("E1", "accepted")] }));
    assert.equal(stage, "won", leadStatus);
    assert.deepEqual({ label: step?.label, href: step?.href, attention: step?.attention }, { label: "Create the job", href: "/estimates/E1", attention: true }, leadStatus);
    assert.equal(step?.detail, "Estimate accepted · Roof replacement");
    assert.doesNotMatch(step?.label ?? "", /follow up|qualify|send estimate|contact/i);
  }
});

test("accepted estimate WITH its job -> the job drives (no Create the job)", () => {
  const { stage, step } = check(person({ leads: [lead("L1", "won")], estimates: [estimate("E1", "accepted")], jobs: [job("J1", "scheduled", { estimate_id: "E1" })] }));
  assert.equal(stage, "job_active");
  assert.equal(step?.label, "Job in progress");
});

test("a lead marked won with no job: Create the job where jobs exist, nothing where they do not (gym membership)", () => {
  assert.equal(check(person({ leads: [lead("L1", "won")] })).step?.label, "Create the job");
  assert.equal(findPersonNextStep({ ...person({ leads: [lead("L1", "won")] }), jobsEnabled: false }), null);
});

test("active job -> Job in progress, never lead qualification even with an open qualified lead", () => {
  const { stage, step } = check(person({ leads: [lead("L1", "qualified")], jobs: [job("J1", "in_progress")] }));
  assert.equal(stage, "job_active");
  assert.deepEqual({ label: step?.label, href: step?.href }, { label: "Job in progress", href: "/jobs/J1" });
});

test("invoicing -> Create / Issue invoice / Collect payment from the job's live invoice", () => {
  const completed = job("J1", "completed");
  assert.equal(check(person({ leads: [lead("L1", "won")], jobs: [completed] })).step?.label, "Create invoice");
  assert.equal(check(person({ leads: [lead("L1", "won")], jobs: [completed], invoices: [invoice("I1", "J1", "draft")] })).step?.label, "Issue invoice");
  const collect = check(person({ leads: [lead("L1", "won")], jobs: [completed], invoices: [invoice("I1", "J1", "sent")] }));
  assert.equal(collect.stage, "invoicing");
  assert.deepEqual({ label: collect.step?.label, href: collect.step?.href }, { label: "Collect payment", href: "/invoices/I1" });
});

test("paid -> no next step", () => {
  const { stage, step } = check(person({ leads: [lead("L1", "won")], jobs: [job("J1", "completed")], invoices: [invoice("I1", "J1", "paid")] }));
  assert.equal(stage, "paid");
  assert.equal(step, null);
});

test("completed customer (job before invoicing went live) -> no next step", () => {
  const { stage, step } = check(person({ leads: [lead("L1", "won", 60)], jobs: [job("J1", "completed", { created_at: "2026-08-01T00:00:00.000Z", completed_at: "2026-08-15T00:00:00.000Z" })] }));
  assert.equal(stage, "customer");
  assert.equal(step, null);
});

test("completed customer + NEW pursuit -> the new pursuit drives the action", () => {
  const { stage, step } = check(person({
    leads: [lead("L0", "won", 30), lead("L2", "new", 1)],
    jobs: [job("J0", "completed", { lead_id: "L0", created_at: daysAgo(25), completed_at: daysAgo(20) })],
    invoices: [invoice("I0", "J0", "paid")],
    appointments: [appointment("A2", "scheduled", 3, { lead_id: "L2" })],
  }));
  assert.equal(stage, "booked");
  assert.equal(step?.label, "Appointment scheduled");
  assert.equal(derivePersonLifecycle(person({ leads: [lead("L0", "won", 30), lead("L2", "new", 1)], jobs: [job("J0", "completed", { lead_id: "L0", created_at: daysAgo(25), completed_at: daysAgo(20) })] })).origin, "repeat_service");
});

test("lost lead + new active opportunity -> the active opportunity drives", () => {
  const { stage, step } = check(person({ leads: [lead("L0", "lost", 40), lead("L1", "qualified", 2)] }));
  assert.equal(stage, "qualified");
  assert.equal(step?.label, "Book an appointment");
  assert.equal(check(person({ leads: [lead("L0", "lost", 40)] })).step, null, "a lost lead alone has no action");
});

test("cancelled appointment is never represented as booked", () => {
  const { stage, step } = check(person({ leads: [lead("L1", "contacted")], appointments: [appointment("A1", "cancelled", 2)] }));
  assert.equal(stage, "responding");
  assert.notEqual(step?.label, "Appointment scheduled");
  assert.equal(step?.label, "Follow up with customer");
});

test("no-show appointment is never represented as booked or visited", () => {
  const { stage, step } = check(person({ leads: [lead("L1", "contacted")], appointments: [appointment("A1", "no_show", -1)] }));
  assert.equal(stage, "responding");
  assert.equal(step?.label, "Follow up with customer");
});

test("past appointment not closed out -> Close out the appointment (canonical 'visited' + appointment_unclosed), even when the lead still says appointment", () => {
  const input = person({ leads: [lead("L1", "appointment")], appointments: [appointment("A1", "scheduled", -2)] });
  const lifecycle = derivePersonLifecycle(input);
  assert.equal(lifecycle.stage, "visited");
  assert.ok(lifecycle.signals.includes("appointment_unclosed"));
  const step = findPersonNextStep(input);
  assert.deepEqual({ label: step?.label, href: step?.href, attention: step?.attention }, { label: "Close out the appointment", href: "/appointments/A1", attention: true });
});

test("completed visit with nothing quoted -> Send an estimate (pre-filled for this person)", () => {
  const { stage, step } = check(person({ leads: [lead("L1", "appointment")], appointments: [appointment("A1", "completed", -2)] }));
  assert.equal(stage, "visited");
  assert.deepEqual({ label: step?.label, href: step?.href }, { label: "Send an estimate", href: "/estimates?new=estimate&contactId=C1" });
});

test("stale open lead after a completed job -> no follow-up nudge (the lead was overtaken)", () => {
  const input = person({ leads: [lead("L1", "contacted", 30)], jobs: [job("J1", "completed", { lead_id: null, created_at: daysAgo(10), completed_at: daysAgo(5) })], invoices: [invoice("I1", "J1", "paid")] });
  const lifecycle = derivePersonLifecycle(input);
  assert.equal(lifecycle.stage, "paid");
  assert.ok(lifecycle.signals.includes("stale_open_lead"));
  assert.equal(findPersonNextStep(input), null);
});

test("lead marked estimate / appointment with no rows -> create the missing record, never 'follow up'", () => {
  assert.deepEqual(
    { label: check(person({ leads: [lead("L1", "estimate")] })).step?.label, href: check(person({ leads: [lead("L1", "estimate")] })).step?.href },
    { label: "Create the estimate", href: "/estimates?new=estimate&contactId=C1" },
  );
  assert.equal(check(person({ leads: [lead("L1", "appointment")] })).step?.label, "Schedule the appointment");
});

test("an outstanding balance on a legacy hand-invoiced job is still surfaced when the stage is settled", () => {
  const legacy = job("J1", "completed", { created_at: "2026-08-01T00:00:00.000Z", completed_at: "2026-08-15T00:00:00.000Z" });
  const { stage, step } = check(person({ leads: [lead("L1", "won", 60)], jobs: [legacy], invoices: [invoice("I1", "J1", "partially_paid")] }));
  assert.equal(stage, "customer");
  assert.equal(step?.label, "Collect payment");
});

test("a waiting conversation outranks the canonical stage (a reply is owed now)", () => {
  const input = { ...person({ leads: [lead("L1", "won")], estimates: [estimate("E1", "accepted")] }), conversations: [{ id: "CV1", status: "open" as const }], waitingConversationIds: new Set(["CV1"]) };
  assert.equal(findPersonNextStep(input)?.href, "/conversations/CV1");
});

test("the badge and the next step come from the same canonical result - they never disagree", () => {
  const cases: [Parameters<typeof person>[0], string][] = [
    [{ leads: [lead("L1", "contacted")], estimates: [estimate("E1", "accepted")] }, "won"],
    [{ leads: [lead("L1", "qualified")], jobs: [job("J1", "in_progress")] }, "active_job"],
    [{ leads: [lead("L1", "contacted")], appointments: [appointment("A1", "cancelled", 2)] }, "needs_follow_up"],
    [{ leads: [lead("L1", "won")], jobs: [job("J1", "completed")], invoices: [invoice("I1", "J1", "sent")] }, "invoicing"],
    [{ leads: [lead("L1", "contacted")], estimates: [estimate("E1", "draft")] }, "estimating"],
    [{ leads: [lead("L1", "new", 0.1)] }, "new"],
    [{ leads: [lead("L1", "lost")] }, "lost"],
  ];
  for (const [rows, badge] of cases) assert.equal(contactLifecycleFromCanonical(derivePersonLifecycle(person(rows))), badge);
});

test("the lifecycle is derived from the rows, not their order", () => {
  const rows = { leads: [lead("L0", "lost", 40), lead("L1", "qualified", 2)], estimates: [estimate("E1", "accepted"), estimate("E2", "declined", { created_at: daysAgo(30) })] };
  const forward = findPersonNextStep(person(rows));
  const reversed = findPersonNextStep(person({ leads: [...rows.leads].reverse(), estimates: [...rows.estimates].reverse() }));
  assert.deepEqual(forward, reversed);
});

test("the organization's own lifecycle policy is honored (estimate follow-up window from its config)", () => {
  const input = person({ leads: [lead("L1", "contacted")], estimates: [estimate("E1", "sent", { sent_at: new Date(NOW - 3 * 3_600_000).toISOString() })] });
  assert.equal(findPersonNextStep(input)?.label, "Estimate awaiting response", "default window is 24h");
  const tight = { ...input, policy: lifecyclePolicyFrom({ estimateFollowup: { followup_1_hours: 2, followup_2_hours: 4 } }) };
  assert.equal(findPersonNextStep(tight)?.label, "Follow up on estimate", "a 2h organization window makes a 3h-old estimate due");
});

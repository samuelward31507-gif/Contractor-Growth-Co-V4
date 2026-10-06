/**
 * P0-B B1: the canonical lifecycle derivation (pure). Every case builds a
 * LifecycleSnapshot by hand - no database, no clock (asOf is fixed).
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/lifecycle/derive.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveLifecycleStage, type LifecycleResult } from "./derive";
import { LIFECYCLE_STAGES, LIFECYCLE_STAGE_DEFINITIONS, stagePrecedence } from "./stages";
import type { LifecycleSnapshot } from "./snapshot";

const AS_OF = "2027-03-10T15:00:00.000Z";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(new Date(AS_OF).getTime() - ms).toISOString();
const ahead = (ms: number) => new Date(new Date(AS_OF).getTime() + ms).toISOString();
const POLICY = { dormancyDays: 180, estimateFollowupHours: 24, invoicingLiveAt: "2026-09-28T16:25:00.000Z" };

function snap(over: Partial<LifecycleSnapshot> = {}): LifecycleSnapshot {
  return {
    contactId: "c-1",
    asOf: AS_OF,
    policy: POLICY,
    smsOptOut: false,
    leads: [],
    appointments: [],
    estimates: [],
    jobs: [],
    invoices: [],
    reviewRequests: [],
    referralRequests: [],
    messages: [],
    openOpportunityTypes: [],
    ...over,
  };
}
const lead = (id: string, status: string, createdAgo = 2 * DAY) => ({ id, status, createdAt: ago(createdAgo) });
const appt = (id: string, status: string, startAgo: number, leadId: string | null = "L1", durationMs = HOUR) => ({ id, leadId, status, startAt: ago(startAgo), endAt: ago(startAgo - durationMs), createdAt: ago(startAgo + DAY) });
const est = (id: string, status: string, createdAgo = 3 * DAY, leadId: string | null = "L1", extra: Record<string, unknown> = {}) => ({ id, leadId, status, sentAt: status === "draft" ? null : ago(createdAgo), expiresAt: null, createdAt: ago(createdAgo), ...extra });
const job = (id: string, status: string, createdAgo = 10 * DAY, completedAgo: number | null = null, leadId: string | null = "L1", estimateId: string | null = null) => ({ id, leadId, estimateId, status, createdAt: ago(createdAgo), completedAt: completedAgo === null ? null : ago(completedAgo) });
const inv = (id: string, jobId: string, status: string, dueDate: string | null = null) => ({ id, jobId, status, dueDate });
const msg = (direction: "inbound" | "outbound", agoMs: number, status: string | null = direction === "inbound" ? "received" : "delivered") => ({ direction, status, createdAt: ago(agoMs) });
const stage = (s: LifecycleSnapshot) => deriveLifecycleStage(s).stage;

// ===========================================================================
// The vocabulary
// ===========================================================================

test("vocabulary: stages are unique, every stage is defined, precedence is the declared order, active stages come before settled ones", () => {
  assert.equal(new Set(LIFECYCLE_STAGES).size, LIFECYCLE_STAGES.length);
  assert.deepEqual(Object.keys(LIFECYCLE_STAGE_DEFINITIONS).sort(), [...LIFECYCLE_STAGES].sort());
  for (const [i, s] of LIFECYCLE_STAGES.entries()) assert.equal(stagePrecedence(s), i);
  const firstSettled = LIFECYCLE_STAGES.findIndex((s) => !LIFECYCLE_STAGE_DEFINITIONS[s].active);
  assert.ok(LIFECYCLE_STAGES.slice(firstSettled).every((s) => !LIFECYCLE_STAGE_DEFINITIONS[s].active), "no active stage below a settled one");
  assert.deepEqual([...LIFECYCLE_STAGES], [
    "job_active", "won", "invoicing",
    "estimate_follow_up", "estimate_sent", "estimating", "visited", "booked", "qualified", "conversing", "responding", "new_lead",
    "review", "referral",
    "dormant", "paid", "customer", "lost", "no_activity",
  ], "the precedence policy is pinned - change it deliberately");
});

// ===========================================================================
// Basic stages
// ===========================================================================

test("new lead: an open new lead nobody has responded to", () => {
  const r = deriveLifecycleStage(snap({ leads: [lead("L1", "new")] }));
  assert.equal(r.stage, "new_lead");
  assert.equal(r.phase, "lead");
  assert.deepEqual(r.primary, { type: "lead", id: "L1" });
  assert.equal(r.origin, "first_purchase");
  assert.equal(r.newOpportunity, false);
});

test("responding lead: the business responded (delivered outbound after the lead), or a person marked it contacted", () => {
  assert.equal(stage(snap({ leads: [lead("L1", "new", 2 * DAY)], messages: [msg("outbound", DAY)] })), "responding");
  assert.equal(stage(snap({ leads: [lead("L1", "contacted")] })), "responding");
  assert.equal(stage(snap({ leads: [lead("L1", "new", 2 * DAY)], messages: [msg("outbound", DAY, "failed")] })), "new_lead", "a failed send is not a response");
  assert.equal(stage(snap({ leads: [lead("L1", "new", 2 * DAY)], messages: [msg("outbound", 3 * DAY)] })), "new_lead", "an outbound from before the lead does not respond to it");
});

test("active conversation: the customer replied AFTER the business responded", () => {
  assert.equal(stage(snap({ leads: [lead("L1", "new", 3 * DAY)], messages: [msg("inbound", 3 * DAY - 1000), msg("outbound", 2 * DAY), msg("inbound", DAY)] })), "conversing");
  // An SMS lead's own first text (at the lead's creation) is not a reply.
  assert.equal(stage(snap({ leads: [lead("L1", "new", 3 * DAY)], messages: [msg("inbound", 3 * DAY - 1000), msg("outbound", 2 * DAY)] })), "responding");
});

test("qualifying lead: an open lead marked qualified", () => {
  assert.equal(stage(snap({ leads: [lead("L1", "qualified")] })), "qualified");
});

test("booked appointment: scheduled/confirmed and not yet over (upcoming, or in progress = active appointment)", () => {
  assert.equal(stage(snap({ leads: [lead("L1", "qualified")], appointments: [{ ...appt("A1", "scheduled", 0), startAt: ahead(DAY), endAt: ahead(DAY + HOUR) }] })), "booked");
  const inProgress = deriveLifecycleStage(snap({ leads: [lead("L1", "qualified")], appointments: [{ ...appt("A1", "confirmed", 0), startAt: ago(10 * 60 * 1000), endAt: ahead(50 * 60 * 1000) }] }));
  assert.equal(inProgress.stage, "booked");
  assert.deepEqual(inProgress.primary, { type: "appointment", id: "A1" });
  assert.equal(stage(snap({ leads: [lead("L1", "appointment")] })), "booked", "a person marked the lead 'appointment' (no appointment row needed)");
});

test("visited: a completed visit for an open lead with nothing quoted after it", () => {
  assert.equal(stage(snap({ leads: [lead("L1", "qualified", 5 * DAY)], appointments: [appt("A1", "completed", DAY)] })), "visited");
});

test("estimate: a draft is estimating; a sent one inside the follow-up window is estimate_sent; past it is estimate_follow_up", () => {
  assert.equal(stage(snap({ leads: [lead("L1", "qualified", 9 * DAY)], estimates: [est("E1", "draft", DAY)] })), "estimating");
  assert.equal(stage(snap({ leads: [lead("L1", "estimate")] })), "estimating", "a person marked the lead 'estimate'");
  assert.equal(stage(snap({ leads: [lead("L1", "qualified", 9 * DAY)], estimates: [est("E1", "sent", 23 * HOUR)] })), "estimate_sent");
  assert.equal(stage(snap({ leads: [lead("L1", "qualified", 9 * DAY)], estimates: [est("E1", "sent", 24 * HOUR)] })), "estimate_follow_up", "exactly the window -> follow-up");
  assert.equal(stage(snap({ policy: { ...POLICY, estimateFollowupHours: 48 }, leads: [lead("L1", "qualified", 9 * DAY)], estimates: [est("E1", "sent", 30 * HOUR)] })), "estimate_sent", "the organization's window drives it");
});

test("won: an accepted estimate with no job yet, or a lead marked won with no job", () => {
  assert.equal(stage(snap({ leads: [lead("L1", "won")], estimates: [est("E1", "accepted")] })), "won");
  assert.equal(stage(snap({ leads: [lead("L1", "won")] })), "won");
});

test("active job: scheduled or in progress", () => {
  for (const s of ["scheduled", "in_progress"]) assert.equal(stage(snap({ leads: [lead("L1", "won")], jobs: [job("J1", s)] })), "job_active", s);
});

test("invoicing: a completed job (after invoicing went live) with no invoice, or a draft/sent/partially paid one", () => {
  assert.equal(stage(snap({ jobs: [job("J1", "completed", 10 * DAY, DAY)] })), "invoicing");
  for (const s of ["draft", "sent", "partially_paid"]) assert.equal(stage(snap({ jobs: [job("J1", "completed", 10 * DAY, DAY)], invoices: [inv("I1", "J1", s)] })), "invoicing", s);
  const overdue = deriveLifecycleStage(snap({ jobs: [job("J1", "completed", 10 * DAY, DAY)], invoices: [inv("I1", "J1", "sent", "2027-03-01")] }));
  assert.ok(overdue.signals.includes("invoice_overdue"));
  assert.equal(stage(snap({ jobs: [job("J1", "completed", 10 * DAY, DAY)], invoices: [inv("I0", "J1", "void"), inv("I1", "J1", "sent")] })), "invoicing", "a void invoice is ignored, the live one counts");
});

test("paid: the most recent completed job is fully paid and nothing is open", () => {
  const r = deriveLifecycleStage(snap({ jobs: [job("J1", "completed", 10 * DAY, DAY)], invoices: [inv("I1", "J1", "paid")] }));
  assert.equal(r.stage, "paid");
  assert.equal(r.active, false);
  assert.equal(r.primary, null);
  assert.equal(r.origin, null);
});

test("review / referral: an ask still open with the customer", () => {
  const paidJob = { jobs: [job("J1", "completed", 10 * DAY, 2 * DAY)], invoices: [inv("I1", "J1", "paid")] };
  for (const s of ["requested", "responded"]) {
    assert.equal(stage(snap({ ...paidJob, reviewRequests: [{ id: "R1", jobId: "J1", status: s, requestedAt: ago(DAY) }] })), "review");
    assert.equal(stage(snap({ ...paidJob, referralRequests: [{ id: "F1", jobId: "J1", status: s, requestedAt: ago(DAY) }] })), "referral");
  }
  for (const s of ["completed", "declined", "failed", "not_requested"]) assert.equal(stage(snap({ ...paidJob, reviewRequests: [{ id: "R1", jobId: "J1", status: s, requestedAt: ago(DAY) }] })), "paid", `resolved review (${s}) is settled`);
  const both = deriveLifecycleStage(snap({ ...paidJob, reviewRequests: [{ id: "R1", jobId: "J1", status: "requested", requestedAt: ago(DAY) }], referralRequests: [{ id: "F1", jobId: "J1", status: "requested", requestedAt: ago(DAY) }] }));
  assert.equal(both.stage, "review");
  assert.deepEqual(both.activeStages, ["review", "referral"]);
  assert.equal(both.origin, "first_purchase", "the ask belongs to the job it is about - not a new cycle");
});

test("repeat service: a recent past customer (not dormant) with a new open opportunity", () => {
  const r = deriveLifecycleStage(snap({ leads: [lead("L2", "new", DAY)], jobs: [job("J1", "completed", 60 * DAY, 30 * DAY, "L1")], invoices: [inv("I1", "J1", "paid")] }));
  assert.equal(r.stage, "new_lead");
  assert.equal(r.origin, "repeat_service");
  assert.equal(r.newOpportunity, true);
  // With nothing open, a recent past customer is "customer"/"paid" - repeat-service territory, NOT dormant.
  assert.equal(stage(snap({ jobs: [job("J1", "completed", 60 * DAY, 30 * DAY, "L1")], invoices: [inv("I1", "J1", "paid")] })), "paid");
});

test("reactivation: dormant (nothing open, last job past the threshold) is distinct from a customer who CAME BACK after going dormant", () => {
  const dormant = deriveLifecycleStage(snap({ jobs: [job("J1", "completed", 400 * DAY, 200 * DAY, "L1")], invoices: [inv("I1", "J1", "paid")] }));
  assert.equal(dormant.stage, "dormant");
  assert.equal(dormant.phase, "relationship");
  assert.equal(dormant.history.daysSinceLastCompletedJob, 200);
  const back = deriveLifecycleStage(snap({ leads: [lead("L2", "new", DAY)], jobs: [job("J1", "completed", 400 * DAY, 200 * DAY, "L1")] }));
  assert.equal(back.stage, "new_lead");
  assert.equal(back.origin, "reactivation");
  assert.equal(back.newOpportunity, true);
  assert.equal(stage(snap({ policy: { ...POLICY, dormancyDays: 365 }, jobs: [job("J1", "completed", 400 * DAY, 200 * DAY, "L1")], invoices: [inv("I1", "J1", "paid")] })), "paid", "the organization's threshold drives dormancy");
  assert.equal(stage(snap({ jobs: [job("J1", "completed", 400 * DAY, 180 * DAY, "L1")], invoices: [inv("I1", "J1", "paid")] })), "dormant", "exactly the threshold is dormant (same >= rule as customer reactivation)");
});

test("new opportunity: never served, an earlier opportunity was lost, now a new open one -> returning_lead", () => {
  const r = deriveLifecycleStage(snap({ leads: [lead("L1", "lost", 90 * DAY), lead("L2", "new", DAY)] }));
  assert.equal(r.stage, "new_lead");
  assert.deepEqual(r.primary, { type: "lead", id: "L2" });
  assert.equal(r.origin, "returning_lead");
  assert.equal(r.newOpportunity, true);
});

test("customer / lost / no_activity: settled states", () => {
  // Completed before invoicing went live (never "invoicing") and not dormant -> customer.
  assert.equal(stage(snap({ jobs: [{ ...job("J1", "completed"), createdAt: "2026-06-01T00:00:00.000Z", completedAt: "2026-06-02T00:00:00.000Z" }], policy: { ...POLICY, dormancyDays: 9999 } })), "customer");
  assert.equal(stage(snap({ leads: [lead("L1", "lost")] })), "lost");
  assert.equal(stage(snap({ estimates: [est("E1", "declined", 5 * DAY, null)] })), "lost");
  assert.equal(stage(snap()), "no_activity");
});

// ===========================================================================
// Conflict / precedence
// ===========================================================================

test("precedence: lead + appointment -> booked; lead + estimate -> estimate; lead + job -> job_active", () => {
  const L = [lead("L1", "qualified", 20 * DAY)];
  assert.equal(stage(snap({ leads: L, appointments: [{ ...appt("A1", "scheduled", 0), startAt: ahead(DAY), endAt: ahead(DAY + HOUR) }] })), "booked");
  assert.equal(stage(snap({ leads: L, estimates: [est("E1", "sent", HOUR)] })), "estimate_sent");
  const r = deriveLifecycleStage(snap({ leads: L, jobs: [job("J1", "scheduled", DAY)] }));
  assert.equal(r.stage, "job_active");
  assert.deepEqual(r.activeStages, ["job_active", "qualified"], "the open lead is still reported, not flattened away");
});

test("precedence: appointment + estimate -> estimate; estimate + job -> job_active; job + invoice -> job_active (current work beats an older unpaid invoice)", () => {
  const L = [lead("L1", "qualified", 20 * DAY)];
  assert.equal(stage(snap({ leads: L, appointments: [{ ...appt("A1", "scheduled", 0), startAt: ahead(DAY), endAt: ahead(DAY + HOUR) }], estimates: [est("E1", "sent", HOUR)] })), "estimate_sent");
  assert.equal(stage(snap({ leads: L, estimates: [est("E1", "sent", HOUR)], jobs: [job("J1", "in_progress", DAY)] })), "job_active");
  const r = deriveLifecycleStage(snap({ jobs: [job("J0", "completed", 30 * DAY, 20 * DAY, null), job("J1", "scheduled", DAY, null, null)] }));
  assert.equal(r.stage, "job_active");
  assert.deepEqual(r.activeStages, ["job_active", "invoicing"]);
});

test("precedence: invoice + payment - a paid invoice settles the job; an unpaid one keeps it in invoicing", () => {
  assert.equal(stage(snap({ jobs: [job("J1", "completed", 10 * DAY, DAY)], invoices: [inv("I1", "J1", "paid")] })), "paid");
  assert.equal(stage(snap({ jobs: [job("J1", "completed", 10 * DAY, DAY)], invoices: [inv("I1", "J1", "partially_paid")] })), "invoicing");
});

test("precedence: won beats invoicing (new committed work outranks an older unpaid job); invoicing beats every pursuit stage", () => {
  const unpaidOld = { jobs: [job("J0", "completed", 40 * DAY, 30 * DAY, "L0")] };
  assert.equal(stage(snap({ ...unpaidOld, leads: [lead("L1", "won", 5 * DAY)], estimates: [est("E1", "accepted", 2 * DAY)] })), "won");
  const r = deriveLifecycleStage(snap({ ...unpaidOld, leads: [lead("L1", "new", DAY)], estimates: [est("E1", "sent", 30 * HOUR, "L1")] }));
  assert.equal(r.stage, "invoicing");
  assert.deepEqual(r.activeStages, ["invoicing", "estimate_follow_up", "new_lead"]);
});

test("precedence: a new pursuit outranks a still-open review/referral ask on finished work", () => {
  const r = deriveLifecycleStage(snap({
    leads: [lead("L2", "new", DAY)],
    jobs: [job("J1", "completed", 60 * DAY, 30 * DAY, "L1")],
    invoices: [inv("I1", "J1", "paid")],
    reviewRequests: [{ id: "R1", jobId: "J1", status: "requested", requestedAt: ago(29 * DAY) }],
  }));
  assert.equal(r.stage, "new_lead");
  assert.deepEqual(r.activeStages, ["new_lead", "review"]);
});

test("precedence: completed customer + new lead -> the new lead's stage, origin repeat_service (or reactivation if they had gone dormant)", () => {
  assert.equal(deriveLifecycleStage(snap({ leads: [lead("L2", "qualified", DAY)], jobs: [job("J1", "completed", 40 * DAY, 20 * DAY, "L1")], invoices: [inv("I1", "J1", "paid")] })).origin, "repeat_service");
});

test("precedence: lost lead + new active opportunity -> the active one wins", () => {
  const r = deriveLifecycleStage(snap({ leads: [lead("L1", "lost", 50 * DAY), lead("L2", "qualified", 2 * DAY)], appointments: [{ ...appt("A1", "scheduled", 0, "L2"), startAt: ahead(DAY), endAt: ahead(DAY + HOUR) }] }));
  assert.equal(r.stage, "booked");
  assert.equal(r.origin, "returning_lead");
});

test("old open lead + newer completed work: the old lead was overtaken - stale, not active", () => {
  const r = deriveLifecycleStage(snap({ leads: [lead("L1", "new", 300 * DAY)], jobs: [job("J1", "completed", 60 * DAY, 30 * DAY, null)], invoices: [inv("I1", "J1", "paid")] }));
  assert.equal(r.stage, "paid");
  assert.ok(r.signals.includes("stale_open_lead"));
  const draft = deriveLifecycleStage(snap({ estimates: [est("E0", "draft", 300 * DAY, null)], jobs: [job("J1", "completed", 60 * DAY, 30 * DAY, null)], invoices: [inv("I1", "J1", "paid")] }));
  assert.equal(draft.stage, "paid");
  assert.ok(draft.signals.includes("stale_draft_estimate"));
});

test("multiple leads: the furthest-along open lead wins; within a stage the most recent is primary", () => {
  const r = deriveLifecycleStage(snap({ leads: [lead("L1", "new", 5 * DAY), lead("L2", "qualified", 4 * DAY), lead("L3", "new", 3 * DAY)] }));
  assert.equal(r.stage, "qualified");
  assert.deepEqual(r.primary, { type: "lead", id: "L2" });
  const same = deriveLifecycleStage(snap({ leads: [lead("L1", "new", 5 * DAY), lead("L3", "new", 3 * DAY)] }));
  assert.deepEqual(same.primary, { type: "lead", id: "L3" });
});

test("multiple appointments / estimates / jobs: upcoming beats past; most recent is primary; cancelled/no-show ignored", () => {
  const L = [lead("L1", "qualified", 30 * DAY)];
  const r = deriveLifecycleStage(snap({ leads: L, appointments: [appt("A0", "cancelled", 3 * DAY), appt("A1", "no_show", 2 * DAY), { ...appt("A2", "scheduled", 0), startAt: ahead(DAY), endAt: ahead(DAY + HOUR), createdAt: ago(HOUR) }, { ...appt("A3", "scheduled", 0), startAt: ahead(3 * DAY), endAt: ahead(3 * DAY + HOUR), createdAt: ago(2 * HOUR) }] }));
  assert.equal(r.stage, "booked");
  assert.deepEqual(r.primary, { type: "appointment", id: "A2" });
  const e = deriveLifecycleStage(snap({ leads: L, estimates: [est("E1", "sent", 30 * HOUR), est("E2", "sent", 2 * HOUR)] }));
  assert.equal(e.stage, "estimate_follow_up");
  assert.deepEqual(e.activeStages, ["estimate_follow_up", "estimate_sent", "qualified"]);
  const j = deriveLifecycleStage(snap({ jobs: [job("J1", "scheduled", 5 * DAY), job("J2", "in_progress", 2 * DAY), job("J3", "cancelled", DAY)] }));
  assert.deepEqual(j.primary, { type: "job", id: "J2" });
});

test("estimate + accepted with a job: the accepted estimate is not 'won' once its job exists", () => {
  assert.equal(stage(snap({ leads: [lead("L1", "won")], estimates: [est("E1", "accepted")], jobs: [job("J1", "scheduled", DAY, null, "L1", "E1")] })), "job_active");
  assert.deepEqual(deriveLifecycleStage(snap({ leads: [lead("L1", "won")], estimates: [est("E1", "accepted")], jobs: [job("J1", "scheduled", DAY, null, "L1", "E1")] })).activeStages, ["job_active"]);
});

test("visited is cleared by a quote: an estimate (any status) or job for the lead, or a leadless estimate after the visit", () => {
  const base = { leads: [lead("L1", "qualified", 10 * DAY)], appointments: [appt("A1", "completed", 5 * DAY)] };
  assert.equal(stage(snap({ ...base, estimates: [est("E1", "declined", 4 * DAY)] })), "qualified");
  assert.equal(stage(snap({ ...base, estimates: [est("E1", "draft", 4 * DAY, null)] })), "estimating");
  assert.equal(stage(snap({ ...base, appointments: [appt("A1", "completed", 5 * DAY, "L-closed")] })), "qualified", "a visit for a closed/unknown lead never counts");
});

// ===========================================================================
// Safety
// ===========================================================================

test("missing data: an incomplete snapshot (absent arrays) derives without throwing", () => {
  const partial = { contactId: "c-1", asOf: AS_OF, policy: POLICY, smsOptOut: false } as unknown as LifecycleSnapshot;
  const r = deriveLifecycleStage(partial);
  assert.equal(r.stage, "no_activity");
  assert.deepEqual(r.activeStages, []);
});

test("null values: missing end/sent/completed timestamps fall back safely", () => {
  assert.equal(stage(snap({ leads: [lead("L1", "qualified")], appointments: [{ id: "A1", leadId: "L1", status: "scheduled", startAt: ahead(DAY), endAt: null, createdAt: null }] })), "booked");
  assert.equal(stage(snap({ leads: [lead("L1", "qualified", 9 * DAY)], estimates: [{ id: "E1", leadId: "L1", status: "sent", sentAt: null, expiresAt: null, createdAt: ago(2 * DAY) }] })), "estimate_follow_up", "no sent_at -> created_at");
  assert.equal(stage(snap({ jobs: [{ id: "J1", leadId: null, estimateId: null, status: "completed", createdAt: ago(5 * DAY), completedAt: null }] })), "invoicing", "no completed_at -> created_at");
  assert.equal(deriveLifecycleStage(snap({ asOf: "not-a-date", leads: [lead("L1", "new")] })).stage, "new_lead", "an invalid asOf never throws");
});

test("cancelled entities never make a customer active", () => {
  const r = deriveLifecycleStage(snap({ appointments: [appt("A1", "cancelled", DAY, null)], estimates: [est("E1", "cancelled", DAY, null)], jobs: [job("J1", "cancelled", DAY)] }));
  assert.equal(r.stage, "no_activity");
  assert.equal(r.active, false);
});

test("stale entities: a past appointment never closed out is a visit (flagged), an estimate past expires_at before the cron ran is lapsed", () => {
  const r = deriveLifecycleStage(snap({ leads: [lead("L1", "qualified", 10 * DAY)], appointments: [appt("A1", "scheduled", 2 * DAY)] }));
  assert.equal(r.stage, "visited");
  assert.ok(r.signals.includes("appointment_unclosed"));
  const lapsed = deriveLifecycleStage(snap({ leads: [lead("L1", "qualified", 10 * DAY)], estimates: [est("E1", "sent", 5 * DAY, "L1", { expiresAt: ago(DAY) })] }));
  assert.equal(lapsed.stage, "qualified");
  assert.ok(lapsed.signals.includes("estimate_lapsed"));
});

test("unknown/unrecognized status: reported, never guessed", () => {
  const r = deriveLifecycleStage(snap({ leads: [lead("L1", "archived")], jobs: [job("J1", "paused")], invoices: [inv("I1", "J1", "refunded")] }));
  assert.equal(r.stage, "no_activity");
  assert.ok(r.signals.includes("unrecognized_status"));
  assert.deepEqual(r.unrecognized, [
    { entity: "invoice", id: "I1", status: "refunded" },
    { entity: "job", id: "J1", status: "paused" },
    { entity: "lead", id: "L1", status: "archived" },
  ]);
});

test("contradictory data resolves by the facts, not the labels: a 'lost' lead with an active job is job_active; a 'won' lead with only a declined estimate is won", () => {
  assert.equal(stage(snap({ leads: [lead("L1", "lost")], jobs: [job("J1", "in_progress", DAY)] })), "job_active");
  assert.equal(stage(snap({ leads: [lead("L1", "won")], estimates: [est("E1", "declined")] })), "won");
});

test("signals: opt-out and a customer waiting on a reply are reported without changing the stage", () => {
  const r = deriveLifecycleStage(snap({ smsOptOut: true, leads: [lead("L1", "new", 3 * DAY)], messages: [msg("outbound", 2 * DAY), msg("inbound", DAY)] }));
  assert.equal(r.stage, "conversing");
  assert.deepEqual(r.signals, ["customer_awaiting_reply", "sms_opted_out"]);
});

// ===========================================================================
// Determinism
// ===========================================================================

const REPRESENTATIVE: LifecycleSnapshot[] = [
  snap({ leads: [lead("L1", "new"), lead("L2", "qualified", DAY), lead("L3", "lost", 90 * DAY)], messages: [msg("outbound", HOUR), msg("inbound", 30 * 60 * 1000)] }),
  snap({ leads: [lead("L1", "qualified", 30 * DAY)], appointments: [appt("A1", "completed", 5 * DAY), { ...appt("A2", "scheduled", 0), startAt: ahead(DAY), endAt: ahead(DAY + HOUR) }], estimates: [est("E1", "sent", 30 * HOUR), est("E2", "draft", HOUR)] }),
  snap({ jobs: [job("J1", "completed", 60 * DAY, 30 * DAY), job("J2", "scheduled", DAY), job("J3", "in_progress", 2 * DAY)], invoices: [inv("I1", "J1", "sent", "2027-01-01")], reviewRequests: [{ id: "R1", jobId: "J1", status: "requested", requestedAt: ago(20 * DAY) }] }),
  snap({ leads: [lead("L9", "new", DAY)], jobs: [job("J1", "completed", 500 * DAY, 400 * DAY, "L1"), job("J2", "completed", 300 * DAY, 250 * DAY, "L2")], invoices: [inv("I2", "J2", "paid")] }),
  snap({ leads: [lead("L1", "won", 9 * DAY), lead("L2", "won", 8 * DAY)], estimates: [est("E1", "accepted", 7 * DAY, "L1"), est("E2", "accepted", 6 * DAY, "L2")] }),
];

const shuffle = <T>(items: T[], seed: number): T[] => {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

test("determinism: the same snapshot always yields the same result, whatever order its rows arrive in", () => {
  for (const [n, s] of REPRESENTATIVE.entries()) {
    const expected: LifecycleResult = deriveLifecycleStage(s);
    assert.deepEqual(deriveLifecycleStage(s), expected, `repeat ${n}`);
    for (let seed = 1; seed <= 12; seed += 1) {
      const permuted: LifecycleSnapshot = {
        ...s,
        leads: shuffle(s.leads, seed),
        appointments: shuffle(s.appointments, seed + 1),
        estimates: shuffle(s.estimates, seed + 2),
        jobs: shuffle(s.jobs, seed + 3),
        invoices: shuffle(s.invoices, seed + 4),
        reviewRequests: shuffle(s.reviewRequests, seed + 5),
        referralRequests: shuffle(s.referralRequests, seed + 6),
        messages: shuffle(s.messages, seed + 7),
      };
      assert.deepEqual(deriveLifecycleStage(permuted), expected, `snapshot ${n}, permutation ${seed}`);
    }
  }
});

test("determinism: deriving never mutates the snapshot", () => {
  for (const s of REPRESENTATIVE) {
    const before = JSON.stringify(s);
    deriveLifecycleStage(s);
    assert.equal(JSON.stringify(s), before);
  }
});

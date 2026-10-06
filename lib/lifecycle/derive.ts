import { LIFECYCLE_STAGE_DEFINITIONS, LIFECYCLE_STAGES, type LifecyclePhase, type LifecycleStage } from "./stages";
import type { LifecycleSnapshot, SnapshotJob } from "./snapshot";
import {
  ACTIVE_APPOINTMENT_STATUS_VALUES,
  ACTIVE_JOB_STATUS_VALUES,
  APPOINTMENT_STATUS_VALUES,
  CLOSED_ESTIMATE_STATUS_VALUES,
  ESTIMATE_STATUS_VALUES,
  INVOICE_STATUS_VALUES,
  JOB_STATUS_VALUES,
  LEAD_STATUS_VALUES,
  OPEN_LEAD_STATUS_VALUES,
  OPEN_REFERRAL_REQUEST_STATUS_VALUES,
  OPEN_REVIEW_REQUEST_STATUS_VALUES,
  REFERRAL_REQUEST_STATUS_VALUES,
  RESPONDED_OUTBOUND_MESSAGE_STATUS_VALUES,
  REVIEW_REQUEST_STATUS_VALUES,
  UNPAID_INVOICE_STATUS_VALUES,
  isKnown,
} from "./statuses";

/**
 * P0-B B1: the canonical lifecycle derivation. PURE: no database, no
 * network, no clock (time comes from snapshot.asOf), no side effects, and
 * independent of input order - the same snapshot always yields the same
 * result. See lib/lifecycle/README.md for the rules in prose.
 *
 * 1. Every entity is mapped to the stage it would put the customer in, if
 *    it is OPEN (a "candidate"). Unrecognized statuses are reported, never
 *    guessed.
 * 2. The STAGE is the candidate with the highest precedence (the order of
 *    LIFECYCLE_STAGES); its entity is `primary` (most recent wins, ties by
 *    id). Every open stage is still returned in `activeStages` - nothing is
 *    flattened away.
 * 3. With no candidate the customer is settled: dormant / paid / customer
 *    (served), lost (never served, only lost/declined), or no_activity.
 * 4. `origin` relates the CURRENT open cycle to the customer's history:
 *    first_purchase, repeat_service (came back while still a recent
 *    customer), reactivation (came back after going dormant) or
 *    returning_lead (never served, an earlier opportunity was lost);
 *    `newOpportunity` is true for every origin but first_purchase.
 */

export type LifecycleOrigin = "first_purchase" | "repeat_service" | "reactivation" | "returning_lead";
export type LifecycleEntityType = "lead" | "appointment" | "estimate" | "job" | "review_request" | "referral_request";
export type LifecycleEntityRef = { type: LifecycleEntityType; id: string };
export type LifecycleSignal =
  | "sms_opted_out"
  | "customer_awaiting_reply"
  | "appointment_unclosed"
  | "estimate_lapsed"
  | "invoice_overdue"
  | "stale_open_lead"
  | "stale_draft_estimate"
  | "unrecognized_status";

export type LifecycleResult = {
  stage: LifecycleStage;
  phase: LifecyclePhase;
  active: boolean;
  /** Every open stage present, in precedence order (the first is `stage` when active). */
  activeStages: LifecycleStage[];
  /** The entity that decided `stage` (null for settled stages). */
  primary: LifecycleEntityRef | null;
  origin: LifecycleOrigin | null;
  newOpportunity: boolean;
  history: { completedJobs: number; repeatCustomer: boolean; lastCompletedJobAt: string | null; daysSinceLastCompletedJob: number | null };
  signals: LifecycleSignal[];
  unrecognized: { entity: LifecycleEntityType | "invoice"; id: string; status: string }[];
};

type Candidate = { stage: LifecycleStage; ref: LifecycleEntityRef; at: number; cycleAt: number; jobId: string | null };

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const ms = (iso: string | null | undefined): number => (iso ? new Date(iso).getTime() : Number.NaN);
const finite = (value: number) => Number.isFinite(value);

export function deriveLifecycleStage(snapshot: LifecycleSnapshot): LifecycleResult {
  const asOf = ms(snapshot.asOf);
  const signals = new Set<LifecycleSignal>();
  const unrecognized: LifecycleResult["unrecognized"] = [];
  const candidates: Candidate[] = [];
  if (snapshot.smsOptOut) signals.add("sms_opted_out");

  const known = <T extends string>(values: readonly T[], entity: LifecycleResult["unrecognized"][number]["entity"], row: { id: string; status: string }) => {
    if (isKnown(values, row.status)) return true;
    unrecognized.push({ entity, id: row.id, status: String(row.status) });
    signals.add("unrecognized_status");
    return false;
  };

  const leads = (snapshot.leads ?? []).filter((row) => known(LEAD_STATUS_VALUES, "lead", row));
  const appointments = (snapshot.appointments ?? []).filter((row) => known(APPOINTMENT_STATUS_VALUES, "appointment", row));
  const estimates = (snapshot.estimates ?? []).filter((row) => known(ESTIMATE_STATUS_VALUES, "estimate", row));
  const jobs = (snapshot.jobs ?? []).filter((row) => known(JOB_STATUS_VALUES, "job", row));
  const invoices = (snapshot.invoices ?? []).filter((row) => known(INVOICE_STATUS_VALUES, "invoice", row));
  const reviews = (snapshot.reviewRequests ?? []).filter((row) => known(REVIEW_REQUEST_STATUS_VALUES, "review_request", row));
  const referrals = (snapshot.referralRequests ?? []).filter((row) => known(REFERRAL_REQUEST_STATUS_VALUES, "referral_request", row));
  const messages = (snapshot.messages ?? []).filter((message) => finite(ms(message.createdAt)));
  const jobById = new Map(jobs.map((job) => [job.id, job]));

  // History: completed jobs (the single "past customer" fact the codebase uses).
  const completedJobs = jobs.filter((job) => job.status === "completed");
  const completedAt = (job: SnapshotJob) => ms(job.completedAt ?? job.createdAt);
  const lastCompletedMs = completedJobs.reduce((max, job) => Math.max(max, finite(completedAt(job)) ? completedAt(job) : Number.NEGATIVE_INFINITY), Number.NEGATIVE_INFINITY);
  const hasLastCompleted = finite(lastCompletedMs);
  // An open lead / draft estimate older than the latest completed job was
  // overtaken by that work (the A3 "superseded" idea): stale, not active.
  const supersededByCompletedWork = (createdAt: string) => hasLastCompleted && ms(createdAt) < lastCompletedMs;

  // ---- leads -------------------------------------------------------------
  const openLeads = leads.filter((lead) => isKnown(OPEN_LEAD_STATUS_VALUES, lead.status));
  const responses = messages.filter((m) => m.direction === "outbound" && isKnown(RESPONDED_OUTBOUND_MESSAGE_STATUS_VALUES, m.status ?? ""));
  const inbound = messages.filter((m) => m.direction === "inbound");
  for (const lead of openLeads) {
    if (supersededByCompletedWork(lead.createdAt)) {
      signals.add("stale_open_lead");
      continue;
    }
    const leadMs = ms(lead.createdAt);
    let stage: LifecycleStage;
    if (lead.status === "appointment") stage = "booked";
    else if (lead.status === "estimate") stage = "estimating";
    else if (lead.status === "qualified") stage = "qualified";
    else {
      const firstResponse = responses.map((m) => ms(m.createdAt)).filter((t) => t >= leadMs).reduce((min, t) => Math.min(min, t), Number.POSITIVE_INFINITY);
      const responded = finite(firstResponse);
      const repliedAfterResponse = responded && inbound.some((m) => ms(m.createdAt) > firstResponse);
      stage = repliedAfterResponse ? "conversing" : responded || lead.status === "contacted" ? "responding" : "new_lead";
    }
    candidates.push({ stage, ref: { type: "lead", id: lead.id }, at: leadMs, cycleAt: leadMs, jobId: null });
  }
  for (const lead of leads.filter((row) => row.status === "won")) {
    const hasJob = jobs.some((job) => job.leadId === lead.id);
    const hasAcceptedEstimate = estimates.some((estimate) => estimate.leadId === lead.id && estimate.status === "accepted");
    if (!hasJob && !hasAcceptedEstimate) candidates.push({ stage: "won", ref: { type: "lead", id: lead.id }, at: ms(lead.createdAt), cycleAt: ms(lead.createdAt), jobId: null });
  }

  // ---- appointments --------------------------------------------------------
  const openLeadIds = new Set(openLeads.filter((lead) => !supersededByCompletedWork(lead.createdAt)).map((lead) => lead.id));
  const visitLead = (leadId: string | null, startMs: number): string | null => {
    if (leadId !== null) return openLeadIds.has(leadId) ? leadId : null;
    // A leadless visit belongs to the most recent open lead created at or before it (lib/opportunities/lifecycle.ts M2).
    const owner = openLeads
      .filter((lead) => openLeadIds.has(lead.id) && ms(lead.createdAt) <= startMs)
      .sort((a, b) => ms(b.createdAt) - ms(a.createdAt) || (a.id < b.id ? 1 : -1))[0];
    return owner?.id ?? null;
  };
  for (const appointment of appointments) {
    const startMs = ms(appointment.startAt);
    const endMs = ms(appointment.endAt ?? appointment.startAt);
    const at = ms(appointment.createdAt ?? appointment.startAt);
    if (isKnown(ACTIVE_APPOINTMENT_STATUS_VALUES, appointment.status) && endMs > asOf) {
      candidates.push({ stage: "booked", ref: { type: "appointment", id: appointment.id }, at, cycleAt: at, jobId: null });
      continue;
    }
    const pastUnclosed = isKnown(ACTIVE_APPOINTMENT_STATUS_VALUES, appointment.status) && endMs <= asOf;
    if (pastUnclosed) signals.add("appointment_unclosed");
    if (appointment.status !== "completed" && !pastUnclosed) continue; // cancelled / no_show never count as a visit
    const leadId = visitLead(appointment.leadId, startMs);
    if (!leadId) continue;
    // Nothing quoted after it (lib/opportunities/lifecycle.ts M4/M5/M8).
    const quoted =
      estimates.some((estimate) => estimate.leadId === leadId || (estimate.leadId === null && ms(estimate.createdAt) >= startMs)) ||
      jobs.some((job) => job.leadId === leadId);
    if (!quoted) candidates.push({ stage: "visited", ref: { type: "appointment", id: appointment.id }, at, cycleAt: at, jobId: null });
  }

  // ---- estimates -----------------------------------------------------------
  for (const estimate of estimates) {
    const at = ms(estimate.createdAt);
    if (estimate.status === "sent") {
      if (estimate.expiresAt && ms(estimate.expiresAt) <= asOf) {
        signals.add("estimate_lapsed"); // expired by time; the expiry cron has not run yet
        continue;
      }
      const sentMs = ms(estimate.sentAt ?? estimate.createdAt);
      const stage = asOf - sentMs >= snapshot.policy.estimateFollowupHours * HOUR_MS ? "estimate_follow_up" : "estimate_sent";
      candidates.push({ stage, ref: { type: "estimate", id: estimate.id }, at, cycleAt: at, jobId: null });
    } else if (estimate.status === "draft") {
      if (supersededByCompletedWork(estimate.createdAt)) {
        signals.add("stale_draft_estimate");
        continue;
      }
      candidates.push({ stage: "estimating", ref: { type: "estimate", id: estimate.id }, at, cycleAt: at, jobId: null });
    } else if (estimate.status === "accepted") {
      const hasJob = jobs.some((job) => job.estimateId === estimate.id || (estimate.leadId !== null && job.leadId === estimate.leadId));
      if (!hasJob) candidates.push({ stage: "won", ref: { type: "estimate", id: estimate.id }, at, cycleAt: at, jobId: null });
    }
  }

  // ---- jobs and invoices ---------------------------------------------------
  const asOfDay = Number.isFinite(asOf) ? new Date(asOf).toISOString().slice(0, 10) : "";
  for (const job of jobs) {
    const at = ms(job.createdAt);
    if (isKnown(ACTIVE_JOB_STATUS_VALUES, job.status)) {
      candidates.push({ stage: "job_active", ref: { type: "job", id: job.id }, at, cycleAt: at, jobId: job.id });
      continue;
    }
    if (job.status !== "completed") continue;
    // lib/invoices/summary.ts isLegacyCompletedJob: completed before invoicing went live -> never "invoicing".
    if (completedAt(job) < ms(snapshot.policy.invoicingLiveAt)) continue;
    const live = invoices.filter((invoice) => invoice.jobId === job.id && invoice.status !== "void").sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    if (live && live.status === "paid") continue;
    if (live && (live.status === "sent" || live.status === "partially_paid") && live.dueDate && live.dueDate < asOfDay) signals.add("invoice_overdue");
    if (!live || isKnown(UNPAID_INVOICE_STATUS_VALUES, live.status)) candidates.push({ stage: "invoicing", ref: { type: "job", id: job.id }, at: completedAt(job), cycleAt: at, jobId: job.id });
  }

  // ---- review / referral asks ----------------------------------------------
  for (const [rows, stage, open, type] of [
    [reviews, "review", OPEN_REVIEW_REQUEST_STATUS_VALUES, "review_request"],
    [referrals, "referral", OPEN_REFERRAL_REQUEST_STATUS_VALUES, "referral_request"],
  ] as const) {
    for (const request of rows) {
      if (!isKnown(open as readonly string[], request.status)) continue;
      const job = request.jobId ? jobById.get(request.jobId) : undefined;
      const at = ms(request.requestedAt);
      candidates.push({ stage, ref: { type, id: request.id }, at, cycleAt: job ? ms(job.createdAt) : at, jobId: request.jobId });
    }
  }

  // ---- awaiting reply --------------------------------------------------------
  const lastInbound = inbound.reduce((max, m) => Math.max(max, ms(m.createdAt)), Number.NEGATIVE_INFINITY);
  const lastResponse = responses.reduce((max, m) => Math.max(max, ms(m.createdAt)), Number.NEGATIVE_INFINITY);
  if (finite(lastInbound) && lastInbound > lastResponse) signals.add("customer_awaiting_reply");

  // ---- the stage -------------------------------------------------------------
  const activeStages = LIFECYCLE_STAGES.filter((stage) => candidates.some((candidate) => candidate.stage === stage));
  const history = {
    completedJobs: completedJobs.length,
    repeatCustomer: completedJobs.length >= 2,
    lastCompletedJobAt: hasLastCompleted ? new Date(lastCompletedMs).toISOString() : null,
    daysSinceLastCompletedJob: hasLastCompleted && finite(asOf) ? Math.floor((asOf - lastCompletedMs) / DAY_MS) : null,
  };
  const sortedSignals = [...signals].sort();
  const sortedUnrecognized = unrecognized.sort((a, b) => (a.entity + a.id < b.entity + b.id ? -1 : 1));

  if (activeStages.length > 0) {
    const stage = activeStages[0];
    // Primary: the most recent entity in the winning stage; ties by id - never input order.
    const primary = candidates
      .filter((candidate) => candidate.stage === stage)
      .sort((a, b) => (finite(b.at) ? b.at : -Infinity) - (finite(a.at) ? a.at : -Infinity) || (a.ref.id < b.ref.id ? -1 : 1))[0];
    const origin = deriveOrigin(candidates, completedJobs, leads, estimates, completedAt, snapshot.policy.dormancyDays);
    return {
      stage,
      phase: LIFECYCLE_STAGE_DEFINITIONS[stage].phase,
      active: true,
      activeStages,
      primary: primary.ref,
      origin,
      newOpportunity: origin !== "first_purchase",
      history,
      signals: sortedSignals,
      unrecognized: sortedUnrecognized,
    };
  }

  let stage: LifecycleStage;
  if (completedJobs.length > 0) {
    if (finite(asOf) && hasLastCompleted && asOf - lastCompletedMs >= snapshot.policy.dormancyDays * DAY_MS) stage = "dormant";
    else {
      const lastJob = [...completedJobs].sort((a, b) => completedAt(b) - completedAt(a) || (a.id < b.id ? -1 : 1))[0];
      const paid = invoices.some((invoice) => invoice.jobId === lastJob.id && invoice.status === "paid");
      stage = paid ? "paid" : "customer";
    }
  } else if (leads.some((lead) => lead.status === "lost") || estimates.some((estimate) => estimate.status === "declined" || estimate.status === "expired")) {
    stage = "lost";
  } else {
    stage = "no_activity";
  }
  return {
    stage,
    phase: LIFECYCLE_STAGE_DEFINITIONS[stage].phase,
    active: false,
    activeStages: [],
    primary: null,
    origin: null,
    newOpportunity: false,
    history,
    signals: sortedSignals,
    unrecognized: sortedUnrecognized,
  };
}

function deriveOrigin(
  candidates: Candidate[],
  completedJobs: SnapshotJob[],
  leads: LifecycleSnapshot["leads"],
  estimates: LifecycleSnapshot["estimates"],
  completedAt: (job: SnapshotJob) => number,
  dormancyDays: number,
): LifecycleOrigin {
  // The current cycle began with its earliest open item.
  const cycleStart = candidates.reduce((min, candidate) => (finite(candidate.cycleAt) ? Math.min(min, candidate.cycleAt) : min), Number.POSITIVE_INFINITY);
  if (!finite(cycleStart)) return "first_purchase";
  const cycleJobIds = new Set(candidates.map((candidate) => candidate.jobId).filter((id): id is string => id !== null));
  const priorCompleted = completedJobs.filter((job) => !cycleJobIds.has(job.id) && completedAt(job) < cycleStart);
  if (priorCompleted.length > 0) {
    const lastPrior = Math.max(...priorCompleted.map(completedAt));
    return cycleStart - lastPrior >= dormancyDays * DAY_MS ? "reactivation" : "repeat_service";
  }
  const lostBefore =
    leads.some((lead) => lead.status === "lost" && ms(lead.createdAt) < cycleStart) ||
    estimates.some((estimate) => isKnown(CLOSED_ESTIMATE_STATUS_VALUES, estimate.status) && estimate.status !== "cancelled" && ms(estimate.createdAt) < cycleStart);
  return lostBefore ? "returning_lead" : "first_purchase";
}

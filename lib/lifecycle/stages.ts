/**
 * P0-B B1: the canonical lifecycle stages - where a customer (contact) is in
 * the revenue lifecycle right now. Stable identifiers, independent of UI
 * labels and database wording. See lib/lifecycle/README.md.
 *
 * A stage is a POSITION, not an entity status and not an obligation: the
 * underlying lead/appointment/estimate/job/invoice statuses are untouched
 * and still authoritative for their own entities; what Trackpr owes next
 * (follow-ups, next actions) is a separate concern built on top of this.
 *
 * Roadmap mapping (Lead -> Identify -> Respond -> Qualify -> Converse ->
 * Book -> Appointment -> Estimate -> Follow-up -> Won -> Job -> Invoice ->
 * Payment -> Review -> Referral -> Repeat Service -> Reactivation -> New
 * Opportunity):
 *   - Lead / Identify            -> new_lead (the contact is identified by
 *                                   intake; there is no separate data signal
 *                                   for "identified but not a lead")
 *   - Respond                    -> responding
 *   - Converse                   -> conversing
 *   - Qualify                    -> qualified
 *   - Book / Appointment         -> booked, visited
 *   - Estimate / Follow-up       -> estimating, estimate_sent,
 *                                   estimate_follow_up
 *   - Won / Job                  -> won, job_active
 *   - Invoice / Payment          -> invoicing, paid
 *   - Review / Referral          -> review, referral
 *   - Repeat Service / Reactivation / New Opportunity are NOT single
 *     stages - they describe how a customer's CURRENT cycle relates to their
 *     history, so they are carried on the derived result as `origin`
 *     (repeat_service / reactivation / returning_lead / first_purchase) and
 *     `newOpportunity`; a past customer with nothing open is `customer`
 *     (repeat-service territory) or, once inactive past the organization's
 *     dormancy threshold, `dormant` (reactivation territory).
 */

export const LIFECYCLE_STAGES = [
  // Tier 1 - committed work and money in flight.
  "job_active",
  "won",
  "invoicing",
  // Tier 2 - active pursuit (selling), furthest along first.
  "estimate_follow_up",
  "estimate_sent",
  "estimating",
  "visited",
  "booked",
  "qualified",
  "conversing",
  "responding",
  "new_lead",
  // Tier 3 - asks on finished work still open with the customer.
  "review",
  "referral",
  // Tier 4 - settled: nothing is open.
  "dormant",
  "paid",
  "customer",
  "lost",
  "no_activity",
] as const;

export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export type LifecyclePhase = "lead" | "appointment" | "estimate" | "won" | "job" | "money" | "post_service" | "relationship" | "none";

export type LifecycleStageDefinition = {
  stage: LifecycleStage;
  phase: LifecyclePhase;
  /** Something is open: Trackpr or a person has work in motion with this customer. */
  active: boolean;
  /** The roadmap step(s) this stage represents. */
  roadmap: string;
  /** What has to be true - in terms of existing entity statuses. */
  definition: string;
};

export const LIFECYCLE_STAGE_DEFINITIONS: Readonly<Record<LifecycleStage, LifecycleStageDefinition>> = {
  job_active: { stage: "job_active", phase: "job", active: true, roadmap: "Job", definition: "A job is scheduled or in progress." },
  won: { stage: "won", phase: "won", active: true, roadmap: "Won", definition: "An estimate was accepted (or a lead was marked won) and no job exists for it yet." },
  invoicing: { stage: "invoicing", phase: "money", active: true, roadmap: "Invoice", definition: "A job was completed (after invoicing went live) and its live invoice is missing, draft, sent or partially paid." },
  estimate_follow_up: { stage: "estimate_follow_up", phase: "estimate", active: true, roadmap: "Follow-up", definition: "An estimate is sent, unanswered and older than the organization's first estimate follow-up window." },
  estimate_sent: { stage: "estimate_sent", phase: "estimate", active: true, roadmap: "Estimate", definition: "An estimate is sent and awaiting the customer's decision, inside the follow-up window." },
  estimating: { stage: "estimating", phase: "estimate", active: true, roadmap: "Estimate", definition: "A draft estimate exists, or an open lead was marked 'estimate' by a person." },
  visited: { stage: "visited", phase: "appointment", active: true, roadmap: "Appointment", definition: "A visit for an open lead has happened (completed, or past its end and not closed out) and nothing was quoted after it." },
  booked: { stage: "booked", phase: "appointment", active: true, roadmap: "Book", definition: "An appointment is scheduled/confirmed and has not ended yet, or an open lead was marked 'appointment' by a person." },
  qualified: { stage: "qualified", phase: "lead", active: true, roadmap: "Qualify", definition: "An open lead was marked qualified." },
  conversing: { stage: "conversing", phase: "lead", active: true, roadmap: "Converse", definition: "An open new/contacted lead where the customer replied after the business responded." },
  responding: { stage: "responding", phase: "lead", active: true, roadmap: "Respond", definition: "An open lead the business has responded to (or marked contacted), with no customer reply since." },
  new_lead: { stage: "new_lead", phase: "lead", active: true, roadmap: "Lead / Identify", definition: "An open new lead nobody has responded to yet." },
  review: { stage: "review", phase: "post_service", active: true, roadmap: "Review", definition: "A review request is requested or responded and not resolved." },
  referral: { stage: "referral", phase: "post_service", active: true, roadmap: "Referral", definition: "A referral request is requested or responded and not resolved." },
  dormant: { stage: "dormant", phase: "relationship", active: false, roadmap: "Reactivation", definition: "A past customer with nothing open whose last completed job is at least the organization's inactivity threshold old." },
  paid: { stage: "paid", phase: "relationship", active: false, roadmap: "Payment", definition: "A past customer with nothing open whose most recent completed job is fully paid." },
  customer: { stage: "customer", phase: "relationship", active: false, roadmap: "Repeat Service", definition: "A past customer with nothing open (most recent job not invoiced through Trackpr, e.g. before invoicing went live)." },
  lost: { stage: "lost", phase: "none", active: false, roadmap: "-", definition: "Never served; every opportunity was lost or declined." },
  no_activity: { stage: "no_activity", phase: "none", active: false, roadmap: "-", definition: "Nothing open and no history (or only cancelled/void records)." },
};

/** Precedence: lower index wins. The order of LIFECYCLE_STAGES IS the precedence policy. */
export function stagePrecedence(stage: LifecycleStage): number {
  return LIFECYCLE_STAGES.indexOf(stage);
}

export function isActiveStage(stage: LifecycleStage): boolean {
  return LIFECYCLE_STAGE_DEFINITIONS[stage].active;
}

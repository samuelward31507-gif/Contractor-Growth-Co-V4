import type { SupabaseClient } from "@supabase/supabase-js";
import { SUCCESSFUL_OUTBOUND_STATUS_SET } from "@/lib/conversations/waiting";
import { contactDisplayName } from "@/lib/contacts/format";
import {
  isReactivationDue,
  ACTIVE_APPOINTMENT_STATUSES,
  ACTIVE_ESTIMATE_STATUSES,
  ACTIVE_JOB_STATUSES,
} from "@/lib/automation/customer-reactivation";
import { readCustomerReactivationConfig } from "@/lib/automation/settings";
import { OPEN_LEAD_STATUSES } from "@/lib/leads/queries";
import { HIGH_VALUE_THRESHOLD } from "@/lib/dashboard/queries";
import { calendarDateInTimeZone, formatInvoiceNumber, formatMoney, isOverdue, type InvoiceStatus } from "@/lib/invoices/domain";
import { isLegacyCompletedJob } from "@/lib/invoices/summary";
import { readAllPages } from "@/lib/bi/revenue-attribution";
import { ONBOARDING_TEST_LEAD_SOURCE } from "@/lib/onboarding/readiness";
import { BOOKED_APPOINTMENT_STATUSES, findCompletedVisitsWithoutEstimate, findUnbookedQualifiedLeads } from "./lifecycle";
import { getOpportunityById, type OpportunityType, type OpportunityStatus, type OpportunityResolutionReason } from "./queries";

/**
 * Pass 3 (Revenue Intelligence Foundation) + Pass 4 P1-D: real-data
 * opportunity detection and lifecycle sync. Every detector here is a pure
 * read over already-existing tables/columns - no new source of truth, no
 * invented dollar figures, no AI. Six types are implemented, matching
 * exactly the candidates the accompanying audits judged safe (real trigger,
 * real data, safe dedup, honest value semantics):
 *
 *   qualified_lead_unbooked           - leads.status
 *   stale_estimate                    - estimates.status (reuses the
 *                                        existing, already-computed
 *                                        'expired' terminal state - no new
 *                                        staleness threshold invented)
 *   completed_appointment_no_estimate - Phase 2-8: one item per open
 *                                        lead, by the shared rule in
 *                                        lib/opportunities/lifecycle.ts that
 *                                        lib/bi/metrics.ts also uses for
 *                                        completedAppointmentsWithoutEstimate
 *   dormant_customer                  - reuses isReactivationDue() and the
 *                                        exact active-engagement exclusion
 *                                        logic from
 *                                        lib/automation/customer-reactivation.ts
 *                                        verbatim - never a second,
 *                                        possibly-drifting dormancy
 *                                        definition
 *   no_show                           - appointments.status
 *   completed_job_no_referral_request - Pass 4 P1-D. jobs.status='completed'
 *                                        cross-referenced against
 *                                        referral_requests.status - open
 *                                        only while no row exists or the
 *                                        existing row is 'failed' (the one
 *                                        genuinely retriable state per
 *                                        lib/reviews-referrals/tracking.ts's
 *                                        own upsertRequestOutcome), resolved
 *                                        once a row reaches 'requested' or
 *                                        beyond. Promoted from Pass 3's own
 *                                        deferred list after verifying
 *                                        referral_requests really is written
 *                                        unconditionally by the post-job-
 *                                        followup automation (never gated on
 *                                        an org-level review_url the way
 *                                        review_requests is), so a missing
 *                                        row is only ever an ordinary timing
 *                                        gap, not a structural ambiguity.
 *   completed_job_no_review_request   - Pass 5C Batch 1. The same shape as
 *                                        completed_job_no_referral_request,
 *                                        now promoted from Pass 3/4's own
 *                                        deferred list: that deferral was
 *                                        about review_requests' real
 *                                        structural ambiguity (a missing row
 *                                        could mean "not sent yet" OR "this
 *                                        org has no review_url configured"),
 *                                        not about the detection shape
 *                                        itself. Resolved here by an
 *                                        explicit organizations.review_url
 *                                        IS NOT NULL guard before any job is
 *                                        even considered - an org with no
 *                                        review functionality configured
 *                                        produces zero candidates, never a
 *                                        false opportunity.
 *   cancelled_appointment_no_rebooking - Pass 5C Batch 1. An explicit,
 *                                        documented absence-based heuristic:
 *                                        appointments.status='cancelled',
 *                                        past a conservative grace period,
 *                                        with no later scheduled/confirmed
 *                                        appointment for the SAME contact.
 *                                        This schema has no
 *                                        original_appointment_id/
 *                                        rebooked_from_id column - this is
 *                                        never a true rebooking
 *                                        relationship, only the best signal
 *                                        the existing data can safely
 *                                        support. See detectCancelled
 *                                        AppointmentsWithoutRebooking's own
 *                                        comment for the full reasoning.
 *   uncontacted_lead                  - Pass 5C Batch 2. A lead.status='new'
 *                                        lead, at least 24 hours old, with no
 *                                        durable Trackpr evidence of a
 *                                        successfully sent outbound message
 *                                        (no inbound reply, no outbound
 *                                        message with status 'sent' or
 *                                        'delivered') for its contact since
 *                                        the lead was created. Phase 2-5:
 *                                        independent of automation state and
 *                                        of SMS opt-out (see
 *                                        detectUncontactedLeads). Explicitly "no
 *                                        recorded outbound contact" per
 *                                        Trackpr's own evidence - never a
 *                                        claim that the customer was never
 *                                        reached by any means, that a human
 *                                        didn't call them, that the AI
 *                                        failed, or that a send was never
 *                                        attempted. See
 *                                        detectUncontactedLeads's own
 *                                        comment for the full evidence
 *                                        hierarchy and exclusion list. The
 *                                        read-only Pass 5C Batch 2 audit
 *                                        found and closed the one open
 *                                        question before this was built: a
 *                                        node-by-node trace of the live,
 *                                        active n8n lead_created_followup
 *                                        workflow confirmed should_send is
 *                                        genuinely conditional (not
 *                                        hardcoded false) for lead.created,
 *                                        so "no successful outbound
 *                                        evidence" is a real, actionable
 *                                        signal, not a universal, by-design
 *                                        constant every lead would trigger.
 *
 *   accepted_estimate_no_job          - Pass 5C Batch 7. An estimate whose
 *                                        status is 'accepted' (a real,
 *                                        unambiguous customer "yes" -
 *                                        estimates.responded_at, verified by
 *                                        direct code inspection to be set
 *                                        only on the accepted/declined
 *                                        transition, never for
 *                                        draft/sent/cancelled/expired) with
 *                                        no linked jobs row
 *                                        (jobs.estimate_id) after a
 *                                        conservative waiting window. Under
 *                                        normal operation job creation is
 *                                        synchronous with acceptance
 *                                        (lib/automation/jobs.ts's
 *                                        emitJobCreatedFromEstimate, called
 *                                        from both the manual staff Accept
 *                                        action and the automated SMS-accept
 *                                        path) - this type exists as the
 *                                        honest, deterministic surface for
 *                                        the rare case where that expected
 *                                        side effect never happened (a
 *                                        transient failure, an error
 *                                        swallowed by
 *                                        emitJobCreatedFromEstimate's own
 *                                        documented "never throws"
 *                                        contract, or a future acceptance
 *                                        path this file doesn't know
 *                                        about) - never a claim about why.
 *
 *   completed_job_not_invoiced        - Phase 1B-5 (Close the Money Loop). A
 *                                        jobs.status='completed' job with no
 *                                        live (non-void) invoices row, for
 *                                        jobs completed since Trackpr
 *                                        invoicing went live - legacy jobs
 *                                        are excluded by the exact same
 *                                        documented cutoff Money and the
 *                                        next-step logic already use
 *                                        (lib/invoices/summary.ts's
 *                                        INVOICING_LIVE_AT /
 *                                        isLegacyCompletedJob). No waiting
 *                                        window: Money's own "Not yet
 *                                        invoiced" figure surfaces the same
 *                                        job immediately, and a second,
 *                                        different definition here would
 *                                        recreate the "which number do I
 *                                        trust" problem.
 *   invoice_overdue                   - Phase 1B-5. An invoices row with
 *                                        status sent/partially_paid whose
 *                                        due_date is before today in the
 *                                        organization's own timezone - the
 *                                        identical read-time derivation
 *                                        (lib/invoices/domain.ts's isOverdue)
 *                                        the invoice page, Money and Insights
 *                                        use; never a stored status. Sourced
 *                                        from the JOB (invoices_one_live_per_
 *                                        job makes the job id the stable
 *                                        dedup key across void-and-reissue);
 *                                        the invoice id travels in
 *                                        metadata.invoice_id, the
 *                                        pending_estimate convention.
 *
 * Deliberately NOT implemented (each would need either new structured data
 * this schema doesn't have, or a data path too ambiguous to safely
 * dedupe/value - documented, not silently skipped):
 *
 *   missed_call                     - no stable, dedicated marker
 *                                      distinguishes a missed-call-
 *                                      originated lead from any other lead
 *                                      today (leads.source is free-text/
 *                                      unstandardized), and it would
 *                                      substantially overlap
 *                                      qualified_lead_unbooked once such a
 *                                      lead qualifies - implementing it now
 *                                      risks either double-counting the
 *                                      same underlying lead as two
 *                                      opportunities or an unreliable dedup
 *                                      key.
 *   repeat_service / maintenance    - no service-type or service-interval
 *                                      data exists anywhere in this schema;
 *                                      any "due for maintenance" claim would
 *                                      be fabricated, not derived.
 */

/** Phase 2H: opportunity ids per resolve update - well under the ~400-id point where a request URL fails. */
const RESOLVE_CHUNK = 200;

/**
 * Pass 1 (sync failure-safety): a read this sync depends on failed. Every
 * detector and sync read goes through checked() below, so a failed query can
 * no longer be mistaken for "zero rows" - the old `data ?? []` shape turned
 * any error (PostgREST or network: postgrest-js returns both as
 * { data: null, error }) into an empty result, which could resolve real open
 * opportunities, insert false ones, or re-open dismissed ones.
 * syncOpportunities catches this and aborts before its first write.
 * Module-private: callers only ever see OpportunitySyncResult.failed.
 */
class OpportunityReadError extends Error {
  readonly read: string;
  readonly detail: string;
  constructor(read: string, detail: string) {
    super(`opportunity sync read failed: ${read}`);
    this.name = "OpportunityReadError";
    this.read = read;
    this.detail = detail;
  }
}

/** Returns a Supabase read's data unchanged (zero rows and a null single row stay exactly as they were) - throws OpportunityReadError instead when the read failed. */
function checked<T>(read: string, result: { data: T; error: { message: string } | null }): T {
  if (result.error) throw new OpportunityReadError(read, result.error.message);
  return result.data;
}

/**
 * Phase 2H: checked() for a multi-row read - the complete result, paged
 * through readAllPages (Phase 2C: pages of 1000 under a stable order). The
 * API caps a single response at 1000 rows, so a one-shot read silently
 * dropped everything past it, and the sync then auto-resolved the dropped
 * opportunities as "no longer applies". A failed page, or reaching the row
 * limit, throws OpportunityReadError exactly like checked(), so an
 * incomplete read aborts the sync before its first write.
 */
async function checkedAll<T>(read: string, build: Parameters<typeof readAllPages>[0]): Promise<T[]> {
  // Each page passes through unchanged; only its error message is noted, so
  // the abort log names the real cause (as checked() does).
  let pageError: string | null = null;
  const observed = () => {
    const query = build();
    return {
      range: (from: number, to: number) =>
        Promise.resolve(query.range(from, to)).then((page) => {
          if (page.error) pageError = (page.error as { message?: string }).message ?? String(page.error);
          return page;
        }),
    };
  };
  const result = await readAllPages<T>(observed);
  if (result.failed) throw new OpportunityReadError(read, pageError ?? "the row limit was reached");
  return result.rows;
}

// Error-observing copies of two shared helpers (lib/automation/settings.ts,
// lib/settings/queries.ts). Same queries and the same results and defaults on
// success; the only difference is that a failed read throws instead of
// silently becoming the default. The shared helpers themselves are
// untouched: they have many other callers.

async function readAutomationConfigByOrganization(supabase: SupabaseClient, organizationId: string, automationId: string): Promise<Map<string, unknown>> {
  const map = new Map<string, unknown>();
  // Phase 2H: this organization's row only - the read used to return every
  // organization's row for the automation, silently capped at 1000.
  const data = checked(`automation_settings.config (${automationId})`, await supabase.from("automation_settings").select("organization_id, config").eq("automation_id", automationId).eq("organization_id", organizationId));
  for (const row of (data ?? []) as { organization_id: string; config: unknown }[]) {
    map.set(row.organization_id, row.config);
  }
  return map;
}

async function readOrganizationTimezone(supabase: SupabaseClient, organizationId: string): Promise<string | undefined> {
  const data = checked("organizations.timezone", await supabase.from("organizations").select("timezone").eq("id", organizationId).maybeSingle());
  return data?.timezone ?? undefined;
}

export type OpportunityCandidate = {
  type: OpportunityType;
  sourceEntityType: "lead" | "estimate" | "appointment" | "contact" | "job";
  sourceEntityId: string;
  contactId: string | null;
  title: string;
  description: string | null;
  estimatedValue: number | null;
  valueBasis: string | null;
  metadata: Record<string, unknown>;
  /**
   * Phase 2-8: other source ids of the same type whose dismissal also
   * suppresses this candidate (a lead's other completed visits, M5). Read
   * by syncOpportunities only - never persisted.
   */
  dismissalAliases?: string[];
};

type ContactRefRow = { id: string; first_name: string | null; last_name: string | null; company_name: string | null };
// PostgREST returns an embedded to-one relation as an array in this
// client's inferred type (it can't statically know the FK is many-to-one) -
// the same Embedded<T>/one() normalization lib/appointments/queries.ts
// already established for its own embedded contact select.
type ContactRef = ContactRefRow | ContactRefRow[] | null;

function one(contact: ContactRef): ContactRefRow | null {
  return Array.isArray(contact) ? (contact[0] ?? null) : contact;
}

function displayNameOrFallback(contact: ContactRef, fallback: string): string {
  const row = one(contact);
  if (!row) return fallback;
  const name = contactDisplayName(row);
  return name || fallback;
}

// ---------------------------------------------------------------------------
// A. qualified_lead_unbooked
// ---------------------------------------------------------------------------

/**
 * Trackpr 2.0, Phase 4C (P2 #6): "booked" means an appointment in one of the
 * three statuses that represent a real, still-relevant booking outcome -
 * matches lib/scheduling/availability.ts's own OCCUPYING_APPOINTMENT_STATUSES
 * exactly (a cancelled appointment never happened; a no-show means the slot
 * is free again and the lead was never actually seen). Previously this
 * checked for ANY appointment row regardless of status, so a lead whose only
 * appointment history was cancelled (or a no-show) was permanently treated
 * as "booked" and could never resurface here again, even though nothing is
 * actually on the calendar for them.
 */
// Phase 2-8: the booked statuses now live with the rest of the shared
// lifecycle rules (lib/opportunities/lifecycle.ts), so Insights uses the
// identical list.
const ACTIVE_BOOKING_STATUSES = BOOKED_APPOINTMENT_STATUSES;

/**
 * Phase 2-7 (A10, L5): an appointment books a qualified lead when it is
 * linked to that lead by lead_id, or - only when it has no lead_id at all -
 * when it is for the lead's own contact and starts at or after the lead was
 * created. An appointment linked to a different lead never books this one,
 * and a lead-less appointment from before the lead existed is old customer
 * history, not a booking for this lead. AI bookings carry a lead_id only
 * when the triggering event had one, so lead-less appointments are real.
 * The booked statuses are unchanged (completed still counts as booked).
 * Phase 2-8: the rule itself is findUnbookedQualifiedLeads in
 * lib/opportunities/lifecycle.ts, shared with Insights' "Qualified, no
 * appointment" - unchanged in behavior.
 */
async function detectQualifiedLeadsUnbooked(supabase: SupabaseClient, organizationId: string): Promise<OpportunityCandidate[]> {
  const leadRows = await checkedAll("qualified_lead_unbooked.leads", () =>
    supabase
      .from("leads")
      .select("id, contact_id, service, estimated_value, created_at, status, contacts(id, first_name, last_name, company_name)")
      .eq("organization_id", organizationId)
      .eq("status", "qualified")
      .order("id"),
  );

  const leads = (leadRows ?? []) as { id: string; contact_id: string | null; service: string | null; estimated_value: number | null; created_at: string; status: string; contacts: ContactRef }[];
  if (leads.length === 0) return [];

  // Phase 2-7: the same one paged read, now including lead-less appointments
  // (with their contact and start) for the A10 contact fallback.
  const appointmentRows = await checkedAll("qualified_lead_unbooked.appointments", () =>
    supabase.from("appointments").select("lead_id, contact_id, start_at, status").eq("organization_id", organizationId).in("status", ACTIVE_BOOKING_STATUSES).order("id"),
  );

  return findUnbookedQualifiedLeads(leads, (appointmentRows ?? []) as { lead_id: string | null; contact_id: string | null; start_at: string; status: string }[])
    .map((lead) => ({
      type: "qualified_lead_unbooked" as const,
      sourceEntityType: "lead" as const,
      sourceEntityId: lead.id,
      contactId: lead.contact_id,
      title: displayNameOrFallback(lead.contacts, lead.service || "Qualified lead"),
      description: lead.service ? `Qualified for ${lead.service} - no appointment booked yet.` : "Qualified - no appointment booked yet.",
      estimatedValue: lead.estimated_value,
      valueBasis: lead.estimated_value != null ? "leads.estimated_value" : null,
      metadata: {},
    }));
}

// ---------------------------------------------------------------------------
// B. stale_estimate (status = 'expired' - the existing automation's own
// already-computed terminal state, not a new age threshold)
// ---------------------------------------------------------------------------

async function detectStaleEstimates(supabase: SupabaseClient, organizationId: string): Promise<OpportunityCandidate[]> {
  const data = await checkedAll("stale_estimate.estimates", () =>
    supabase
      .from("estimates")
      .select("id, contact_id, title, amount, sent_at, expires_at, contacts(id, first_name, last_name, company_name)")
      .eq("organization_id", organizationId)
      .eq("status", "expired")
      .order("id"),
  );

  const rows = (data ?? []) as { id: string; contact_id: string | null; title: string; amount: number | null; sent_at: string | null; expires_at: string | null; contacts: ContactRef }[];

  return rows.map((row) => ({
    type: "stale_estimate" as const,
    sourceEntityType: "estimate" as const,
    sourceEntityId: row.id,
    contactId: row.contact_id,
    title: displayNameOrFallback(row.contacts, row.title),
    description: `Estimate "${row.title}" expired with no customer decision recorded.`,
    estimatedValue: row.amount,
    valueBasis: row.amount != null ? "estimates.amount" : null,
    metadata: { sent_at: row.sent_at, expires_at: row.expires_at },
  }));
}

// ---------------------------------------------------------------------------
// C. completed_appointment_no_estimate - Phase 2-8: the rule is
// findCompletedVisitsWithoutEstimate in lib/opportunities/lifecycle.ts,
// shared with Insights' "Visits, no estimate" (lib/bi/metrics.ts), so both
// count exactly the same items: one per open lead.
// ---------------------------------------------------------------------------

/**
 * Phase 2-8 (M1-M5, M8): one item per open lead with a completed visit and
 * no estimate and no job - see findCompletedVisitsWithoutEstimate for the
 * association, clearing and anchor rules. The source stays the APPOINTMENT
 * (the lead's latest completed visit), so existing rows keep their keys; an
 * older visit's open row resolves once as condition_no_longer_true when a
 * newer visit becomes the anchor. A dismissal of any of the lead's visits
 * suppresses the item (dismissalAliases, honored in syncOpportunities).
 *
 * Four bounded, org-scoped paged reads regardless of candidate count -
 * completed visits, estimates, open leads, jobs with a lead - matched in
 * memory. Never N+1, never an id list.
 */
async function detectCompletedAppointmentsWithoutEstimate(supabase: SupabaseClient, organizationId: string): Promise<OpportunityCandidate[]> {
  const appointmentRows = await checkedAll("completed_appointment_no_estimate.appointments", () =>
    supabase
      .from("appointments")
      .select("id, contact_id, lead_id, title, start_at, status, contacts(id, first_name, last_name, company_name)")
      .eq("organization_id", organizationId)
      .eq("status", "completed")
      .order("id"),
  );

  const appointments = (appointmentRows ?? []) as { id: string; contact_id: string | null; lead_id: string | null; title: string; start_at: string; status: string; contacts: ContactRef }[];
  if (appointments.length === 0) return [];

  // Phase 2H: every estimate and lead matched in memory - the old lead-id
  // list failed outright at roughly 400 leads. Phase 2-8: every estimate
  // (lead-less ones too, with contact and created_at), the open leads, and
  // every job linked to a lead.
  const [estimateRows, leadRows, jobRows] = await Promise.all([
    checkedAll<{ lead_id: string | null; contact_id: string | null; created_at: string }>("completed_appointment_no_estimate.estimates", () =>
      supabase.from("estimates").select("lead_id, contact_id, created_at").eq("organization_id", organizationId).order("id"),
    ),
    checkedAll<{ id: string; contact_id: string | null; created_at: string; status: string }>("completed_appointment_no_estimate.open_leads", () =>
      supabase.from("leads").select("id, contact_id, created_at, status").eq("organization_id", organizationId).in("status", [...OPEN_LEAD_STATUSES]).order("id"),
    ),
    checkedAll<{ lead_id: string | null }>("completed_appointment_no_estimate.jobs", () =>
      supabase.from("jobs").select("lead_id").eq("organization_id", organizationId).not("lead_id", "is", null).order("id"),
    ),
  ]);

  return findCompletedVisitsWithoutEstimate({ visits: appointments, leads: leadRows, estimates: estimateRows, jobs: jobRows }).map(({ leadId, anchor, visitIds }) => ({
    type: "completed_appointment_no_estimate" as const,
    sourceEntityType: "appointment" as const,
    sourceEntityId: anchor.id,
    contactId: anchor.contact_id,
    title: displayNameOrFallback(anchor.contacts, anchor.title),
    description: `Completed appointment "${anchor.title}" never turned into an estimate.`,
    // No reliable amount exists at this stage - no estimate has ever been
    // created for this lead, so there is nothing real to base a figure
    // on. Never guessed from an average or any other org.
    estimatedValue: null,
    valueBasis: null,
    metadata: { appointment_start_at: anchor.start_at, lead_id: leadId },
    dismissalAliases: visitIds.filter((id) => id !== anchor.id),
  }));
}

// ---------------------------------------------------------------------------
// D. dormant_customer - reuses isReactivationDue() and the exact
// active-engagement exclusion set verbatim from
// lib/automation/customer-reactivation.ts. Never sends anything itself;
// purely a read-side reflection of the same eligibility rule the real
// automation already enforces before it ever messages anyone.
// ---------------------------------------------------------------------------

async function detectDormantCustomers(supabase: SupabaseClient, organizationId: string, now: Date): Promise<OpportunityCandidate[]> {
  const configByOrg = await readAutomationConfigByOrganization(supabase, organizationId, "customer-reactivation");
  const config = readCustomerReactivationConfig(configByOrg.get(organizationId) ?? null);

  // Phase 2H: paged, newest completion first (id breaks ties), with the
  // contact's name joined in - the separate contacts read by id list is gone.
  const jobRows = await checkedAll("dormant_customer.jobs", () =>
    supabase
      .from("jobs")
      .select("id, contact_id, title, completed_at, contacts(id, first_name, last_name, company_name)")
      .eq("organization_id", organizationId)
      .eq("status", "completed")
      .not("contact_id", "is", null)
      .not("completed_at", "is", null)
      .order("completed_at", { ascending: false })
      .order("id"),
  );

  const jobs = jobRows as { id: string; contact_id: string; title: string; completed_at: string; contacts: ContactRef }[];
  if (jobs.length === 0) return [];

  // Reduce to the single most recently completed job per contact - jobs
  // were fetched newest-first, exactly matching
  // processCustomerReactivation's own reduction.
  const latestJobByContact = new Map<string, { id: string; contact_id: string; title: string; completed_at: string; contacts: ContactRef }>();
  for (const job of jobs) {
    if (!latestJobByContact.has(job.contact_id)) latestJobByContact.set(job.contact_id, job);
  }

  const dueContactIds = [...latestJobByContact.values()].filter((job) => isReactivationDue(job.completed_at, config, now)).map((job) => job.contact_id);
  if (dueContactIds.length === 0) return [];

  // Phase 2H: the organization's open leads and active appointments,
  // estimates and jobs - each already narrowed by status - read in full and
  // matched to the due contacts in memory. The old reads sent the due
  // contacts as an id list, which failed outright at roughly 400 contacts.
  const [leadRows, appointmentRows, estimateRows, activeJobRows] = await Promise.all([
    checkedAll<{ contact_id: string | null }>("dormant_customer.leads", () =>
      supabase.from("leads").select("contact_id").eq("organization_id", organizationId).in("status", [...OPEN_LEAD_STATUSES]).not("contact_id", "is", null).order("id"),
    ),
    checkedAll<{ contact_id: string | null }>("dormant_customer.appointments", () =>
      supabase.from("appointments").select("contact_id").eq("organization_id", organizationId).in("status", ACTIVE_APPOINTMENT_STATUSES).not("contact_id", "is", null).order("id"),
    ),
    checkedAll<{ contact_id: string | null }>("dormant_customer.estimates", () =>
      supabase.from("estimates").select("contact_id").eq("organization_id", organizationId).in("status", ACTIVE_ESTIMATE_STATUSES).not("contact_id", "is", null).order("id"),
    ),
    checkedAll<{ contact_id: string | null }>("dormant_customer.active_jobs", () =>
      supabase.from("jobs").select("contact_id").eq("organization_id", organizationId).in("status", ACTIVE_JOB_STATUSES).not("contact_id", "is", null).order("id"),
    ),
  ]);

  const contactsWithOpenLead = new Set(leadRows.map((row) => row.contact_id));
  const contactsWithActiveAppointment = new Set(appointmentRows.map((row) => row.contact_id));
  const contactsWithActiveEstimate = new Set(estimateRows.map((row) => row.contact_id));
  const contactsWithActiveJob = new Set(activeJobRows.map((row) => row.contact_id));

  const eligibleContactIds = dueContactIds.filter(
    (contactId) => !contactsWithOpenLead.has(contactId) && !contactsWithActiveAppointment.has(contactId) && !contactsWithActiveEstimate.has(contactId) && !contactsWithActiveJob.has(contactId),
  );

  return eligibleContactIds.map((contactId) => {
    const job = latestJobByContact.get(contactId)!;
    const contact = job.contacts;
    const daysSince = Math.floor((now.getTime() - new Date(job.completed_at).getTime()) / 86_400_000);
    return {
      type: "dormant_customer" as const,
      sourceEntityType: "contact" as const,
      sourceEntityId: contactId,
      contactId,
      title: displayNameOrFallback(contact, "Dormant customer"),
      description: `Last service ("${job.title}") was ${daysSince} days ago - no follow-up activity since.`,
      // Deliberately never a value: this pass's own rule is explicit -
      // never invent a future service value for a dormant/repeat customer
      // opportunity.
      estimatedValue: null,
      valueBasis: null,
      metadata: { last_completed_job_id: job.id, last_completed_at: job.completed_at, inactivity_days_threshold: config.inactivity_days, days_since_last_service: daysSince },
    };
  });
}

// ---------------------------------------------------------------------------
// E. no_show
// ---------------------------------------------------------------------------

async function detectNoShows(supabase: SupabaseClient, organizationId: string): Promise<OpportunityCandidate[]> {
  const data = await checkedAll("no_show.appointments", () =>
    supabase
      .from("appointments")
      .select("id, contact_id, title, start_at, contacts(id, first_name, last_name, company_name)")
      .eq("organization_id", organizationId)
      .eq("status", "no_show")
      .order("id"),
  );

  const rows = (data ?? []) as { id: string; contact_id: string | null; title: string; start_at: string; contacts: ContactRef }[];

  return rows.map((row) => ({
    type: "no_show" as const,
    sourceEntityType: "appointment" as const,
    sourceEntityId: row.id,
    contactId: row.contact_id,
    title: displayNameOrFallback(row.contacts, row.title),
    description: `Missed "${row.title}" without rescheduling.`,
    // No dollar amount exists on an appointment itself - never guessed.
    estimatedValue: null,
    valueBasis: null,
    metadata: { appointment_start_at: row.start_at },
  }));
}

// ---------------------------------------------------------------------------
// F. completed_job_no_referral_request (Pass 4 P1-D) - a completed job whose
// referral_requests row either doesn't exist yet, or exists but is still
// 'failed' (the one genuinely retriable state - see
// lib/reviews-referrals/tracking.ts's own upsertRequestOutcome). Any other
// status ('requested'/'responded'/'converted'/'declined') means the
// referral ask has already genuinely happened, so the job is excluded.
// ---------------------------------------------------------------------------

const REFERRAL_REQUEST_OPEN_STATUSES = new Set<string | undefined>([undefined, "failed"]);

async function detectCompletedJobsWithoutReferralRequest(supabase: SupabaseClient, organizationId: string): Promise<OpportunityCandidate[]> {
  const jobRows = await checkedAll("completed_job_no_referral_request.jobs", () =>
    supabase
      .from("jobs")
      .select("id, contact_id, title, completed_at, contacts(id, first_name, last_name, company_name)")
      .eq("organization_id", organizationId)
      .eq("status", "completed")
      .order("id"),
  );

  const jobs = (jobRows ?? []) as { id: string; contact_id: string | null; title: string; completed_at: string | null; contacts: ContactRef }[];
  if (jobs.length === 0) return [];

  // Phase 2H: the organization's referral requests in full (unique per job),
  // matched in memory - the old completed-job id list failed at ~400 jobs.
  const referralRows = await checkedAll("completed_job_no_referral_request.referral_requests", () =>
    supabase.from("referral_requests").select("job_id, status").eq("organization_id", organizationId).order("id"),
  );
  const referralStatusByJob = new Map(((referralRows ?? []) as { job_id: string; status: string }[]).map((row) => [row.job_id, row.status]));

  return jobs
    .filter((job) => REFERRAL_REQUEST_OPEN_STATUSES.has(referralStatusByJob.get(job.id)))
    .map((job) => ({
      type: "completed_job_no_referral_request" as const,
      sourceEntityType: "job" as const,
      sourceEntityId: job.id,
      contactId: job.contact_id,
      title: displayNameOrFallback(job.contacts, job.title),
      description: `Completed job "${job.title}" has no referral request yet.`,
      // Prefer no value basis: this pass's own rule is explicit - job.amount
      // is the contracted value of the completed work already done, not a
      // dollar figure for the REFERRAL opportunity itself, which has no
      // reliable value of its own.
      estimatedValue: null,
      valueBasis: null,
      metadata: { job_completed_at: job.completed_at },
    }));
}

// ---------------------------------------------------------------------------
// G. completed_job_no_review_request
// ---------------------------------------------------------------------------

/**
 * Mirrors REFERRAL_REQUEST_OPEN_STATUSES's own exact reasoning:
 * review_requests.status can only ever be moved to 'requested' or 'failed'
 * by the automation itself (see that table's own migration comment -
 * 'responded'/'completed'/'declined' are set later, by the inbound webhook
 * or an explicit contractor action, never by the automation's own send
 * attempt) - 'failed' is the one genuinely retriable state; no row at all
 * means the automation never successfully sent yet.
 */
const REVIEW_REQUEST_OPEN_STATUSES = new Set<string | undefined>([undefined, "failed"]);

async function detectCompletedJobsWithoutReviewRequest(supabase: SupabaseClient, organizationId: string): Promise<OpportunityCandidate[]> {
  // Pass 5C: the guard that resolves this type's Pass 3/4 deferral - see
  // this file's own header comment. review_requests is only ever created by
  // the post-job-followup automation when organizations.review_url is
  // actually configured (lib/reviews-referrals/tracking.ts), so without this
  // check a missing row would be ambiguous between "never configured" (not
  // an opportunity - there is nothing to ask with) and "a genuine gap".
  // Checked once per organization, before any job is even fetched - an org
  // with no review_url produces zero candidates, full stop.
  const organizationRow = checked("completed_job_no_review_request.organizations", await supabase.from("organizations").select("review_url").eq("id", organizationId).maybeSingle());
  if (!organizationRow?.review_url) return [];

  const jobRows = await checkedAll("completed_job_no_review_request.jobs", () =>
    supabase
      .from("jobs")
      .select("id, contact_id, title, amount, completed_at, contacts(id, first_name, last_name, company_name)")
      .eq("organization_id", organizationId)
      .eq("status", "completed")
      .order("id"),
  );

  const jobs = (jobRows ?? []) as { id: string; contact_id: string | null; title: string; amount: number | null; completed_at: string | null; contacts: ContactRef }[];
  if (jobs.length === 0) return [];

  // Phase 2H: the organization's review requests in full (unique per job),
  // matched in memory - the old completed-job id list failed at ~400 jobs.
  const reviewRows = await checkedAll("completed_job_no_review_request.review_requests", () =>
    supabase.from("review_requests").select("job_id, status").eq("organization_id", organizationId).order("id"),
  );
  const reviewStatusByJob = new Map(((reviewRows ?? []) as { job_id: string; status: string }[]).map((row) => [row.job_id, row.status]));

  return jobs
    .filter((job) => REVIEW_REQUEST_OPEN_STATUSES.has(reviewStatusByJob.get(job.id)))
    .map((job) => ({
      type: "completed_job_no_review_request" as const,
      sourceEntityType: "job" as const,
      sourceEntityId: job.id,
      contactId: job.contact_id,
      title: displayNameOrFallback(job.contacts, job.title),
      description: `Completed job "${job.title}" has no review request yet.`,
      // Phase 2-10 (B7): no value, like the referral opportunity above. A
      // review ask is growth work with no dollar figure of its own; the old
      // Pass 5C choice to surface the completed job's amount made it sort
      // and total as if it were money at stake. Existing open rows are
      // refreshed to null by the next sync (estimated_value is compared).
      estimatedValue: null,
      valueBasis: null,
      metadata: { job_completed_at: job.completed_at },
    }));
}

// ---------------------------------------------------------------------------
// H. cancelled_appointment_no_rebooking
// ---------------------------------------------------------------------------

/**
 * Pass 5C: no existing precedent in this codebase for "how long before a
 * cancellation without a follow-up booking is worth surfacing" - the
 * nearest real anchor is lib/automation/estimate-followups.ts's own
 * second-touch default (72 hours / 3 days), reused here rather than
 * inventing an unrelated number. Centralized so it can be tuned later
 * without touching the detector's own logic.
 */
const CANCELLED_APPOINTMENT_REBOOKING_GRACE_PERIOD_MS = 72 * 60 * 60 * 1000;

const REBOOKING_ELIGIBLE_STATUSES = ["scheduled", "confirmed"];

/**
 * Explicit, documented absence-based heuristic - NOT a true rebooking
 * relationship. This schema has no original_appointment_id/
 * rebooked_from_id column linking a cancelled appointment to whatever
 * replaced it (confirmed absent by direct inspection before writing this
 * detector). "No later scheduled/confirmed appointment exists for the same
 * contact" is the best signal the existing data can safely support -
 * source_entity_id anchors to the cancelled appointment's own id (stable,
 * unique), never an inferred pairing. A contact who rebooks through a
 * different, newly-created contact/lead record (e.g. treated as a fresh
 * inquiry) will not be recognized as "rebooked" by this heuristic - a real,
 * accepted false-negative risk, not silently glossed over.
 *
 * Two bounded, org-scoped queries regardless of candidate count (the same
 * "one fetch + in-memory aggregation" shape detectQualifiedLeadsUnbooked
 * above already uses) - never N+1 per cancelled appointment.
 */
async function detectCancelledAppointmentsWithoutRebooking(supabase: SupabaseClient, organizationId: string, now: Date): Promise<OpportunityCandidate[]> {
  const cancelledRows = await checkedAll("cancelled_appointment_no_rebooking.cancelled_appointments", () =>
    supabase
      .from("appointments")
      .select("id, contact_id, title, start_at, updated_at, contacts(id, first_name, last_name, company_name)")
      .eq("organization_id", organizationId)
      .eq("status", "cancelled")
      .not("contact_id", "is", null)
      .order("id"),
  );

  const cancelled = (cancelledRows ?? []) as { id: string; contact_id: string; title: string; start_at: string; updated_at: string; contacts: ContactRef }[];
  if (cancelled.length === 0) return [];

  const pastGracePeriod = cancelled.filter((appointment) => now.getTime() - new Date(appointment.updated_at).getTime() >= CANCELLED_APPOINTMENT_REBOOKING_GRACE_PERIOD_MS);
  if (pastGracePeriod.length === 0) return [];

  const activeRows = await checkedAll("cancelled_appointment_no_rebooking.active_appointments", () =>
    supabase.from("appointments").select("contact_id, start_at").eq("organization_id", organizationId).in("status", REBOOKING_ELIGIBLE_STATUSES).not("contact_id", "is", null).order("id"),
  );

  const activeStartsByContact = new Map<string, string[]>();
  for (const row of (activeRows ?? []) as { contact_id: string; start_at: string }[]) {
    const list = activeStartsByContact.get(row.contact_id) ?? [];
    list.push(row.start_at);
    activeStartsByContact.set(row.contact_id, list);
  }

  return pastGracePeriod
    .filter((appointment) => {
      const laterStarts = activeStartsByContact.get(appointment.contact_id) ?? [];
      // The cancelled appointment can never count as its own rebooking -
      // moot in practice (it is excluded by the 'cancelled' status filter
      // above, never present in activeStartsByContact at all), kept as an
      // explicit, defensive comparison rather than relying on that
      // exclusion alone.
      return !laterStarts.some((startAt) => startAt !== appointment.start_at && new Date(startAt).getTime() > new Date(appointment.updated_at).getTime());
    })
    .map((appointment) => ({
      type: "cancelled_appointment_no_rebooking" as const,
      sourceEntityType: "appointment" as const,
      sourceEntityId: appointment.id,
      contactId: appointment.contact_id,
      title: displayNameOrFallback(appointment.contacts, appointment.title),
      description: `Cancelled "${appointment.title}" with no later appointment booked since.`,
      // No dollar amount exists on an appointment itself - the same
      // reasoning the no_show detector above already applies.
      estimatedValue: null,
      valueBasis: null,
      metadata: { cancelled_at: appointment.updated_at, original_start_at: appointment.start_at },
    }));
}

// ---------------------------------------------------------------------------
// I. uncontacted_lead
// ---------------------------------------------------------------------------

/**
 * Final Batch 1 (new-lead owner alert): how long a genuinely new lead may go
 * without any recorded contact before it is the owner's - on Today's
 * attention list ("Never contacted", action "call"). The instant AI reply
 * normally lands within seconds to a minute and resolves the lead before
 * this, so the alert fires only when it did not happen (organization in
 * test mode or paused, the quiet-hours floor, AI or n8n down, a blocked
 * send) - the speed-to-lead safety net, at speed-to-lead time rather than a
 * day later (it was 24 hours). It is still this one detector: one
 * opportunity per lead (dedup and dismissal unchanged), status 'new' only,
 * never the onboarding test lead, and gone the moment the customer is
 * contacted or replies - no notification on any other lead change.
 */
export const UNCONTACTED_LEAD_AGE_THRESHOLD_MS = 15 * 60 * 1000;

/** messages.status values that actually prove the customer's carrier accepted or delivered the message - 'queued' (Twilio hasn't responded yet) and 'failed'/'undelivered' (attempted, never reached) are deliberately excluded, matching the Pass 5C Batch 2 audit's evidence hierarchy exactly: an attempt is not contact. */
const SUCCESSFUL_OUTBOUND_STATUSES = SUCCESSFUL_OUTBOUND_STATUS_SET;

type ContactEvidenceRow = {
  contact_id: string | null;
  status: string;
  messages: { created_at: string; direction: "inbound" | "outbound" }[] | null;
};

/**
 * Deliberately NOT "the lead was ignored" or "the customer was never
 * contacted" - only that Trackpr itself has no durable evidence of a
 * successfully sent outbound message. Manual/off-platform contact (a phone
 * call, an in-person visit) cannot be proven or disproven by any data this
 * system has - see the Pass 5C Batch 2 audit's own PROVABLE/NOT PROVABLE
 * split. This detector never claims more than what its own evidence
 * supports.
 *
 * Evidence hierarchy (matches the audit exactly):
 *   - workflow_executions/automation_events existing at all proves a
 *     dispatch was attempted, never that a message reached the customer -
 *     never consulted here.
 *   - ai_interactions/should_send:false proves the AI declined, never that
 *     contact happened - never consulted here.
 *   - messages.status IN ('queued','failed','undelivered') proves an
 *     attempt, never delivery - excluded from SUCCESSFUL_OUTBOUND_STATUSES.
 *   - messages.status IN ('sent','delivered') is the only outbound evidence
 *     that resolves this opportunity.
 *   - any inbound message resolves this opportunity too - the customer has
 *     demonstrably engaged, regardless of what Trackpr did or didn't send
 *     first.
 *
 * Phase 2-5 (Phase 2 definition, L1, L2):
 *   - Independent of automation. An uncontacted lead is human work whether
 *     the organization is live, in test mode, paused or unpaid, and whether
 *     instant-lead-followup is enabled - automation state only decides who
 *     acts (lib/decisions/actor.ts), never whether the item exists. The old
 *     live/paid/unpaused/enabled gate hid every lead exactly when only a
 *     human could contact it.
 *   - Opted-out contacts are kept: opt-out blocks texting, not calling, and
 *     this type's action is already "call".
 *   - L1: only evidence at or after the lead's own created_at counts - an
 *     earlier conversation with a returning customer says nothing about
 *     this lead. One exception, from B3: an open conversation whose newest
 *     evidence is the customer's inbound message is waiting for a reply,
 *     and waiting-for-reply wins over uncontacted whenever it happened.
 *   - L2: the onboarding test lead (source ONBOARDING_TEST_LEAD_SOURCE) is
 *     never a candidate - it is the owner's own test, not a customer.
 *
 * Two bounded, org-scoped reads (leads, then conversations with their
 * newest evidence message embedded) regardless of candidate count,
 * aggregated in memory. Never N+1 per lead.
 */
async function detectUncontactedLeads(supabase: SupabaseClient, organizationId: string, now: Date): Promise<OpportunityCandidate[]> {
  const thresholdIso = new Date(now.getTime() - UNCONTACTED_LEAD_AGE_THRESHOLD_MS).toISOString();

  const leadRows = await checkedAll("uncontacted_lead.leads", () =>
    supabase
      .from("leads")
      .select("id, contact_id, service, source, estimated_value, created_at, contacts(id, first_name, last_name, company_name)")
      .eq("organization_id", organizationId)
      .eq("status", "new")
      .not("contact_id", "is", null)
      .lte("created_at", thresholdIso)
      .order("id"),
  );

  const leads = ((leadRows ?? []) as { id: string; contact_id: string; service: string | null; source: string | null; estimated_value: number | null; created_at: string; contacts: ContactRef }[]).filter(
    (lead) => lead.source !== ONBOARDING_TEST_LEAD_SOURCE,
  );
  if (leads.length === 0) return [];

  // Phase 2H: the organization's conversations that hold at least one
  // inbound message or one successful outbound message - one paged read
  // with the message condition applied inside an inner join. It replaces the
  // contact-id and conversation-id lists, which failed at ~400 ids, and the
  // capped message read, which dropped messages past the first 1000.
  // Phase 2-5: the one embedded message is now each conversation's NEWEST
  // piece of evidence, so its time and direction can be compared with each
  // lead's created_at (L1, B3) - still one read.
  const evidenceRows = await checkedAll<ContactEvidenceRow>("uncontacted_lead.contacted_conversations", () =>
    supabase
      .from("conversations")
      .select("contact_id, status, messages!inner(created_at, direction)")
      .eq("organization_id", organizationId)
      .not("contact_id", "is", null)
      .eq("messages.organization_id", organizationId)
      .or(`direction.eq.inbound,and(direction.eq.outbound,status.in.(${[...SUCCESSFUL_OUTBOUND_STATUSES].join(",")}))`, { referencedTable: "messages" })
      .order("created_at", { referencedTable: "messages", ascending: false })
      .limit(1, { referencedTable: "messages" })
      .order("id"),
  );

  // Per contact: the newest evidence across all of its conversations, and
  // whether any open conversation is waiting on the customer's reply.
  const newestEvidenceMsByContact = new Map<string, number>();
  const waitingContactIds = new Set<string>();
  for (const row of evidenceRows) {
    const newest = row.messages?.[0];
    if (!row.contact_id || !newest) continue;
    const newestMs = new Date(newest.created_at).getTime();
    if (newestMs > (newestEvidenceMsByContact.get(row.contact_id) ?? Number.NEGATIVE_INFINITY)) newestEvidenceMsByContact.set(row.contact_id, newestMs);
    if (row.status === "open" && newest.direction === "inbound") waitingContactIds.add(row.contact_id);
  }

  const contactedSinceCreated = (lead: { contact_id: string; created_at: string }) =>
    waitingContactIds.has(lead.contact_id) || (newestEvidenceMsByContact.get(lead.contact_id) ?? Number.NEGATIVE_INFINITY) >= new Date(lead.created_at).getTime();

  return leads
    .filter((lead) => !contactedSinceCreated(lead))
    .map((lead) => ({
      type: "uncontacted_lead" as const,
      sourceEntityType: "lead" as const,
      sourceEntityId: lead.id,
      contactId: lead.contact_id,
      title: displayNameOrFallback(lead.contacts, lead.service || "Uncontacted lead"),
      description: "No recorded outbound contact for this lead yet.",
      estimatedValue: lead.estimated_value,
      valueBasis: lead.estimated_value != null ? "leads.estimated_value" : null,
      metadata: { lead_created_at: lead.created_at },
    }));
}

// ---------------------------------------------------------------------------
// J. accepted_estimate_no_job
// ---------------------------------------------------------------------------

/**
 * Pass 5C Batch 7: job creation is synchronous with estimate acceptance
 * under normal operation (see this file's own header comment), so this
 * threshold does not need to absorb a genuinely gradual business process
 * the way CANCELLED_APPOINTMENT_REBOOKING_GRACE_PERIOD_MS does (a
 * contractor deciding whether/when to rebook a cancelled customer is a
 * real, multi-day decision) - it only needs to absorb a transient
 * failure/retry window before treating a missing job as a genuine
 * candidate. Reuses UNCONTACTED_LEAD_AGE_THRESHOLD_MS's own exact reasoning
 * and value (24 hours) rather than inventing a new number: "long enough to
 * absorb any transient failure without ever flagging something merely
 * still in flight, short of the multi-day cadences this file uses for
 * genuinely gradual decisions."
 */
const ACCEPTED_ESTIMATE_NO_JOB_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * estimates.responded_at is the accepted-state timestamp - verified by
 * direct code inspection (lib/automation/estimate-reply.ts's
 * classifyAndProcessEstimateReply, app/(app)/estimates/actions.ts's
 * transitionEstimate) to be set ONLY on the transition to 'accepted' or
 * 'declined', nullable, and never populated for 'draft'/'sent'/'cancelled'/
 * 'expired'. Combined with this detector's own `status = 'accepted'`
 * filter, a non-null responded_at on a candidate row is unambiguously the
 * moment this specific estimate was accepted, not a generic "last touched"
 * timestamp.
 *
 * jobs.estimate_id is the authoritative conversion relationship - a real FK
 * with a partial unique index (jobs_estimate_id_unique, "one job per
 * estimate, ever"), never contact_id/time-window proximity, lead status, or
 * appointment existence. A job whose estimate_id is NULL (unrelated to any
 * estimate) or points at a DIFFERENT estimate can never resolve this
 * detector's candidates - only an exact estimate_id match does.
 *
 * Two bounded, org-scoped queries regardless of candidate count (estimates,
 * then jobs filtered to exactly those estimate ids), aggregated in-memory
 * via a Set - the same "one fetch + in-memory aggregation, never N+1"
 * shape every other detector in this file already uses.
 */
async function detectAcceptedEstimatesWithoutJob(supabase: SupabaseClient, organizationId: string, now: Date): Promise<OpportunityCandidate[]> {
  const thresholdIso = new Date(now.getTime() - ACCEPTED_ESTIMATE_NO_JOB_THRESHOLD_MS).toISOString();

  const estimateRows = await checkedAll("accepted_estimate_no_job.estimates", () =>
    supabase
      .from("estimates")
      .select("id, contact_id, title, amount, responded_at, contacts(id, first_name, last_name, company_name)")
      .eq("organization_id", organizationId)
      .eq("status", "accepted")
      .not("responded_at", "is", null)
      .lte("responded_at", thresholdIso)
      .order("id"),
  );

  const estimates = (estimateRows ?? []) as { id: string; contact_id: string | null; title: string; amount: number | null; responded_at: string; contacts: ContactRef }[];
  if (estimates.length === 0) return [];

  // Phase 2H: every job made from an estimate, matched in memory - the old
  // accepted-estimate id list failed at ~400 estimates.
  const jobRows = await checkedAll("accepted_estimate_no_job.jobs", () =>
    supabase.from("jobs").select("estimate_id").eq("organization_id", organizationId).not("estimate_id", "is", null).order("id"),
  );
  const estimateIdsWithJob = new Set(((jobRows ?? []) as { estimate_id: string | null }[]).map((row) => row.estimate_id).filter((id): id is string => id !== null));

  return estimates
    .filter((estimate) => !estimateIdsWithJob.has(estimate.id))
    .map((estimate) => ({
      type: "accepted_estimate_no_job" as const,
      sourceEntityType: "estimate" as const,
      sourceEntityId: estimate.id,
      contactId: estimate.contact_id,
      title: displayNameOrFallback(estimate.contacts, estimate.title),
      description: `Estimate "${estimate.title}" was accepted, but no job has been created yet.`,
      estimatedValue: estimate.amount,
      valueBasis: estimate.amount != null ? "estimates.amount" : null,
      metadata: { responded_at: estimate.responded_at },
    }));
}

// ---------------------------------------------------------------------------
// K. active_lead_signal (Canonical Opportunity Intelligence Layer)
// ---------------------------------------------------------------------------

/**
 * Reads the exact same two real fields (leads.temperature, leads.
 * estimated_value) and the exact same "high value" threshold the Attention
 * Engine's own hot_lead/high_value_lead conditions already used
 * (lib/dashboard/queries.ts's HIGH_VALUE_THRESHOLD, exported and reused here
 * rather than redeclared) - never a new signal, never a computed score.
 * temperature is a plain manual field (see lib/today/copy.ts's own comment) -
 * "marked hot" is surfaced honestly as a status someone set, never as
 * detected intelligence.
 *
 * Scoped to OPEN_LEAD_STATUSES, matching every other active-lead condition in
 * this codebase. Deliberately does NOT exclude leads already covered by a
 * more specific opportunity type here - that exclusion happens once, as a
 * shared post-filter in detectAllOpportunityCandidates below, since this
 * function has no dependency on those other detectors' own queries. Where a
 * more specific type already exists for a lead, that lead's temperature/
 * value becomes supporting context on the more specific opportunity (see
 * lib/opportunities/intelligence.ts), not a second, duplicate row - this is
 * the permanent, detector-level fix for the exact Ashley-Simmons/
 * Christopher-Foster duplication a prior pass patched at the Today page
 * level (two cards for the same lead, same dollar figure, no indication they
 * were the same thing).
 */
async function detectActiveLeadSignals(supabase: SupabaseClient, organizationId: string): Promise<OpportunityCandidate[]> {
  const data = await checkedAll("active_lead_signal.leads", () =>
    supabase
      .from("leads")
      .select("id, contact_id, service, temperature, estimated_value, contacts(id, first_name, last_name, company_name)")
      .eq("organization_id", organizationId)
      .in("status", [...OPEN_LEAD_STATUSES])
      .order("id"),
  );

  const rows = (data ?? []) as { id: string; contact_id: string | null; service: string | null; temperature: string; estimated_value: number | null; contacts: ContactRef }[];

  return rows
    .filter((row) => row.temperature === "hot" || (row.estimated_value != null && row.estimated_value >= HIGH_VALUE_THRESHOLD))
    .map((row) => ({
      type: "active_lead_signal" as const,
      sourceEntityType: "lead" as const,
      sourceEntityId: row.id,
      contactId: row.contact_id,
      title: displayNameOrFallback(row.contacts, row.service || "Active lead"),
      description: row.temperature === "hot" ? "Marked hot - worth pursuing." : "A high-value opportunity - worth pursuing.",
      estimatedValue: row.estimated_value,
      valueBasis: row.estimated_value != null ? "leads.estimated_value" : null,
      metadata: { temperature: row.temperature },
    }));
}

// ---------------------------------------------------------------------------
// L. pending_estimate (Canonical Opportunity Intelligence Layer)
// ---------------------------------------------------------------------------

/**
 * A lead with a real, currently-sent estimate (estimates.status = 'sent') -
 * the exact same real-world condition the Attention Engine's own
 * pending_estimate condition already read (lib/dashboard/queries.ts's
 * distinctLeadIdsWithPendingEstimate). Deliberately NOT itself an urgent
 * condition - "sent, within its own expiry window" is the normal, healthy
 * state an estimate is expected to sit in; it only becomes a real leak once
 * it actually goes stale, which is already the separate, existing
 * stale_estimate type (gated on the real terminal 'expired' status, not an
 * invented age threshold). This type exists purely so a sent estimate has an
 * honest, low-urgency presence in the intelligence layer, tiered accordingly
 * (see lib/opportunities/intelligence.ts), rather than no representation at
 * all until it either gets accepted or expires.
 *
 * Phase 2-6 (A1, A13, B1): keyed to the ESTIMATE - sourceEntityType
 * 'estimate', sourceEntityId = estimates.id - and no longer limited to
 * estimates linked to a lead. An estimate's own organization, id and status
 * are its identity and state; estimates are legitimately created with "No
 * lead", and the estimate follow-up automation already handles them. A
 * missing lead or contact never drops the estimate. Two sent estimates on
 * one lead are two opportunities (A13), never one arbitrary representative.
 * The lead travels in metadata.lead_id (nullable) so the same-lead
 * redundancy dedup in detectAllOpportunityCandidates (B8) and the B1
 * dismissal carry-forward in syncOpportunities still work; metadata.
 * estimate_id is kept for the estimate link and the decision layer.
 */
async function detectPendingEstimates(supabase: SupabaseClient, organizationId: string): Promise<OpportunityCandidate[]> {
  const data = await checkedAll("pending_estimate.estimates", () =>
    supabase
      .from("estimates")
      .select("id, lead_id, contact_id, title, amount, sent_at, contacts(id, first_name, last_name, company_name)")
      .eq("organization_id", organizationId)
      .eq("status", "sent")
      .order("id"),
  );

  const rows = (data ?? []) as { id: string; lead_id: string | null; contact_id: string | null; title: string; amount: number | null; sent_at: string | null; contacts: ContactRef }[];

  return rows.map((row) => ({
    type: "pending_estimate" as const,
    sourceEntityType: "estimate" as const,
    sourceEntityId: row.id,
    contactId: row.contact_id,
    title: displayNameOrFallback(row.contacts, row.title),
    description: `Estimate "${row.title}" sent - awaiting the customer's decision.`,
    estimatedValue: row.amount,
    valueBasis: row.amount != null ? "estimates.amount" : null,
    metadata: { estimate_id: row.id, sent_at: row.sent_at, lead_id: row.lead_id },
  }));
}

/** Phase 2-6: the lead a pending_estimate candidate belongs to (metadata.lead_id), or null for an estimate with no lead. */
function pendingEstimateLeadId(candidate: OpportunityCandidate): string | null {
  const leadId = candidate.metadata.lead_id;
  return typeof leadId === "string" ? leadId : null;
}

// ---------------------------------------------------------------------------
// M. completed_job_not_invoiced (Phase 1B-5)
// ---------------------------------------------------------------------------

/**
 * Two bounded, org-scoped reads (completed jobs, then this org's non-void
 * invoices) aggregated in memory - the same shape every other detector here
 * uses. The value shown is jobs.amount, the contracted figure for the work
 * already done and not yet billed - labeled by its basis, never called
 * collected or revenue. Null when the job has no amount; never coerced.
 */
export async function detectCompletedJobsNotInvoiced(supabase: SupabaseClient, organizationId: string): Promise<OpportunityCandidate[]> {
  const jobRows = await checkedAll("completed_job_not_invoiced.jobs", () =>
    supabase
      .from("jobs")
      .select("id, contact_id, title, amount, completed_at, created_at, contacts(id, first_name, last_name, company_name)")
      .eq("organization_id", organizationId)
      .eq("status", "completed")
      .order("id"),
  );

  const jobs = ((jobRows ?? []) as { id: string; contact_id: string | null; title: string; amount: number | null; completed_at: string | null; created_at: string; contacts: ContactRef }[]).filter(
    (job) => !isLegacyCompletedJob({ status: "completed", completed_at: job.completed_at, created_at: job.created_at }),
  );
  if (jobs.length === 0) return [];

  const invoiceRows = await checkedAll("completed_job_not_invoiced.invoices", () => supabase.from("invoices").select("job_id").eq("organization_id", organizationId).neq("status", "void").order("id"));
  const invoicedJobIds = new Set(((invoiceRows ?? []) as { job_id: string }[]).map((row) => row.job_id));

  return jobs
    .filter((job) => !invoicedJobIds.has(job.id))
    .map((job) => ({
      type: "completed_job_not_invoiced" as const,
      sourceEntityType: "job" as const,
      sourceEntityId: job.id,
      contactId: job.contact_id,
      title: displayNameOrFallback(job.contacts, job.title),
      description: `Completed job "${job.title}" has not been invoiced yet.`,
      estimatedValue: job.amount,
      valueBasis: job.amount != null ? "jobs.amount" : null,
      metadata: { job_completed_at: job.completed_at },
    }));
}

// ---------------------------------------------------------------------------
// N. invoice_overdue (Phase 1B-5)
// ---------------------------------------------------------------------------

/**
 * One bounded, org-scoped read of the open (sent/partially_paid) invoices,
 * judged against today's calendar date in the organization's timezone -
 * the same `today` getInvoiceWithContext computes for the invoice page. The
 * value is the invoice's own balance_due (a generated column the database
 * maintains) - money asked for and still owed, never collected.
 */
export async function detectOverdueInvoices(supabase: SupabaseClient, organizationId: string, now: Date): Promise<OpportunityCandidate[]> {
  const [timeZone, invoiceRows] = await Promise.all([
    readOrganizationTimezone(supabase, organizationId),
    checkedAll("invoice_overdue.invoices", () =>
      supabase
        .from("invoices")
        .select("id, job_id, contact_id, number, title, status, balance_due, due_date, contacts(id, first_name, last_name, company_name)")
        .eq("organization_id", organizationId)
        .in("status", ["sent", "partially_paid"])
        .not("due_date", "is", null)
        .order("id"),
    ),
  ]);
  const today = calendarDateInTimeZone(now, timeZone ?? "UTC");

  const rows = (invoiceRows ?? []) as { id: string; job_id: string; contact_id: string | null; number: number; title: string; status: InvoiceStatus; balance_due: number; due_date: string | null; contacts: ContactRef }[];

  return rows
    .filter((invoice) => isOverdue({ status: invoice.status, dueDate: invoice.due_date }, today))
    .map((invoice) => ({
      type: "invoice_overdue" as const,
      sourceEntityType: "job" as const,
      sourceEntityId: invoice.job_id,
      contactId: invoice.contact_id,
      title: displayNameOrFallback(invoice.contacts, invoice.title),
      description: `${formatInvoiceNumber(invoice.number)} was due ${invoice.due_date} - ${formatMoney(invoice.balance_due)} still outstanding.`,
      estimatedValue: invoice.balance_due,
      valueBasis: "invoices.balance_due",
      metadata: { invoice_id: invoice.id, invoice_number: invoice.number, due_date: invoice.due_date, balance_due: invoice.balance_due, judged_against: today },
    }));
}

export async function detectAllOpportunityCandidates(supabase: SupabaseClient, organizationId: string, now: Date = new Date()): Promise<OpportunityCandidate[]> {
  const [
    qualifiedLeads,
    staleEstimates,
    completedAppointmentsNoEstimate,
    dormantCustomers,
    noShows,
    completedJobsNoReferralRequest,
    completedJobsNoReviewRequest,
    cancelledAppointmentsNoRebooking,
    uncontactedLeads,
    acceptedEstimatesNoJob,
    activeLeadSignals,
    pendingEstimates,
    completedJobsNotInvoiced,
    overdueInvoices,
  ] = await Promise.all([
    detectQualifiedLeadsUnbooked(supabase, organizationId),
    detectStaleEstimates(supabase, organizationId),
    detectCompletedAppointmentsWithoutEstimate(supabase, organizationId),
    detectDormantCustomers(supabase, organizationId, now),
    detectNoShows(supabase, organizationId),
    detectCompletedJobsWithoutReferralRequest(supabase, organizationId),
    detectCompletedJobsWithoutReviewRequest(supabase, organizationId),
    detectCancelledAppointmentsWithoutRebooking(supabase, organizationId, now),
    detectUncontactedLeads(supabase, organizationId, now),
    detectAcceptedEstimatesWithoutJob(supabase, organizationId, now),
    detectActiveLeadSignals(supabase, organizationId),
    detectPendingEstimates(supabase, organizationId),
    detectCompletedJobsNotInvoiced(supabase, organizationId),
    detectOverdueInvoices(supabase, organizationId, now),
  ]);

  // Canonical Opportunity Intelligence Layer: active_lead_signal and
  // pending_estimate are the lowest-specificity lead-level signals this file
  // detects - a lead already producing a more specific opportunity type
  // (qualified_lead_unbooked, uncontacted_lead) doesn't need a second,
  // duplicate row for the same underlying lead. See detectActiveLeadSignals'
  // own comment above for the full reasoning.
  // Phase 2-6: pending estimates are keyed to the estimate, so the lead they
  // belong to comes from metadata.lead_id; an estimate with no lead is never
  // deduped against a lead-level type.
  const moreSpecificLeadIds = new Set([...qualifiedLeads, ...uncontactedLeads].map((candidate) => candidate.sourceEntityId));
  const dedupedPendingEstimates = pendingEstimates.filter((candidate) => {
    const leadId = pendingEstimateLeadId(candidate);
    return leadId === null || !moreSpecificLeadIds.has(leadId);
  });

  // Live browser verification caught the remaining real duplicate this
  // exclusion alone didn't cover: a lead that is BOTH hot/high-value AND has
  // a real pending estimate produced two separate active_pursuit cards for
  // the same person (e.g. "Marked hot" $4,800 and "Estimate sent" $6,500 for
  // the same lead) - the exact same class of confusion this whole layer
  // exists to prevent. pending_estimate is the more specific, more concrete
  // fact (a real sent estimate, not just a temperature/value flag), so it
  // wins; active_lead_signal is suppressed for any lead a pending estimate
  // already covers, same as it is for the other more-specific types above.
  const pendingEstimateLeadIds = new Set(dedupedPendingEstimates.map(pendingEstimateLeadId).filter((leadId): leadId is string => leadId !== null));
  const dedupedActiveLeadSignals = activeLeadSignals.filter(
    (candidate) => !moreSpecificLeadIds.has(candidate.sourceEntityId) && !pendingEstimateLeadIds.has(candidate.sourceEntityId),
  );

  return [
    ...qualifiedLeads,
    ...staleEstimates,
    ...completedAppointmentsNoEstimate,
    ...dormantCustomers,
    ...noShows,
    ...completedJobsNoReferralRequest,
    ...completedJobsNoReviewRequest,
    ...cancelledAppointmentsNoRebooking,
    ...uncontactedLeads,
    ...acceptedEstimatesNoJob,
    ...dedupedActiveLeadSignals,
    ...dedupedPendingEstimates,
    // Phase 1B-5: mutually exclusive by construction (one needs no live
    // invoice, the other an overdue live invoice), so no cross-dedup is
    // needed between them; each keys on the job id.
    ...completedJobsNotInvoiced,
    ...overdueInvoices,
  ];
}

// ---------------------------------------------------------------------------
// Sync: reconciles the freshly-detected candidate set against currently
// OPEN opportunity rows - inserts new ones, refreshes changed ones, and
// auto-resolves any open opportunity whose underlying condition no longer
// holds (the lead got booked, the estimate is no longer expired-and-idle,
// the contact is no longer dormant, etc.) - answering this pass's own
// "what happens if underlying data changes" requirement generically for
// every type, rather than a bespoke rule per type.
// ---------------------------------------------------------------------------

/** failed is set (and every count is 0) only when a read failed and the sync aborted before writing anything - see OpportunityReadError. */
export type OpportunitySyncResult = { created: number; refreshed: number; resolved: number; unchanged: number; suppressed: number; failed?: true };

/**
 * Pass 1: the one exit for a failed read. Every read (detection, the two
 * opportunities reads, and the lost-lead lookup) finishes before the first
 * write, so returning here means nothing was resolved, inserted, refreshed or
 * re-opened - existing opportunities stay exactly as they were until a sync
 * whose reads all succeed. Logged with this module's "[opportunities]"
 * console.error convention; never throws, so the after() task and the
 * Dashboard are unaffected.
 */
function abortOnReadError(organizationId: string, error: unknown): OpportunitySyncResult {
  if (!(error instanceof OpportunityReadError)) throw error;
  console.error("[opportunities] sync aborted: read failed", { organizationId, read: error.read, error: error.detail });
  return { created: 0, refreshed: 0, resolved: 0, unchanged: 0, suppressed: 0, failed: true };
}

type ExistingOpenRow = {
  id: string;
  type: OpportunityType;
  source_entity_type: "lead" | "estimate" | "appointment" | "contact" | "job";
  source_entity_id: string;
  title: string;
  description: string | null;
  estimated_value: number | null;
  value_basis: string | null;
  metadata: Record<string, unknown> | null;
};
type RecentRow = { type: OpportunityType; source_entity_id: string; status: OpportunityStatus; created_at: string };

/**
 * Phase 2-9 (A15/B6, rulings Q1-Q5): directed dismissal carry-forward across
 * types for the SAME source - the same underlying condition reappearing
 * under another code stays dismissed. Each rule suppresses creating a new
 * `to` row when, among that source's open-or-dismissed rows of `to` and the
 * `from` types, the most recent is dismissed (Q4) - so an older dismissal
 * never overrides a newer open sibling, and existing open rows are never
 * closed (Q5). Deliberately directed and narrow:
 *   - estimate (Q1): a dismissed pending estimate suppresses the later
 *     expired (stale) estimate for the same estimate id. Legacy lead-keyed
 *     pending dismissals do not reach it (Q1b).
 *   - lead (Q2b): a dismissed uncontacted or qualified-unbooked lead
 *     suppresses only the less-specific active_lead_signal for the same lead
 *     - never the other way, and never a booking prompt after the lead moves.
 * The job/invoice family is intentionally absent (Q3): an overdue invoice is
 * new money-at-risk work and always appears.
 */
const DISMISSAL_CARRY_FORWARD: { to: OpportunityType; from: OpportunityType[] }[] = [
  { to: "stale_estimate", from: ["pending_estimate"] },
  { to: "active_lead_signal", from: ["uncontacted_lead", "qualified_lead_unbooked"] },
];

/**
 * Runs detection and reconciles it against the database. Called from the
 * dashboard page load under the viewing member's own session (see
 * app/(app)/dashboard/page.tsx) - there is no new cron/scheduled route in
 * this pass; this keeps opportunities as fresh as the org's last dashboard
 * visit, the same "compute/refresh on read" shape the dashboard's existing
 * attention items already use, just now with real persistence for the
 * lifecycle (status/resolved_at) this feature actually needs.
 *
 * Verification-pass fix: a dismissed opportunity (a human explicitly said
 * "not now" for this exact source entity) must stay dismissed - it was
 * previously resurrected as a brand-new "open" row on the very next sync
 * whenever the underlying condition (e.g. the lead is still qualified and
 * unbooked) hadn't changed, since the old logic only ever checked for an
 * existing OPEN row, never dismissal history. That defeated dismiss
 * entirely for any persistent condition, which is the common case. Fixed
 * by also fetching each (type, source_entity_id)'s most recent dismissed
 * row and permanently suppressing re-creation for that exact key - this is
 * deliberately different from "resolved" (a detector-driven fact change,
 * e.g. a dormant customer got reactivated), which must still be free to
 * recur as a genuinely new instance and is untouched by this fix.
 */
export async function syncOpportunities(supabase: SupabaseClient, organizationId: string, now: Date = new Date()): Promise<OpportunitySyncResult> {
  let candidates: OpportunityCandidate[];
  let existingRows: ExistingOpenRow[];
  let recentRows: RecentRow[];
  try {
    [candidates, existingRows, recentRows] = await Promise.all([
      detectAllOpportunityCandidates(supabase, organizationId, now),
      // Phase 2H: paged - every open row must be compared, or a candidate
      // whose row was cut off would be inserted again and never resolved.
      checkedAll<ExistingOpenRow>("sync.open_opportunities", () =>
        supabase
          .from("opportunities")
          .select("id, type, source_entity_type, source_entity_id, title, description, estimated_value, value_basis, metadata")
          .eq("organization_id", organizationId)
          .eq("status", "open")
          .order("id"),
      ),
      // Only open/dismissed rows matter for dedup/suppression - a resolved
      // row never blocks re-creation, so it is deliberately excluded here.
      // A failed read here must abort too: an empty list would drop every
      // dismissal and re-open dismissed opportunities.
      // Phase 2H: paged, still newest first (id breaks ties) - past the old
      // 1000-row cap the oldest dismissals fell off and their opportunities
      // were re-created.
      checkedAll<RecentRow>("sync.open_and_dismissed_opportunities", () =>
        supabase
          .from("opportunities")
          .select("type, source_entity_id, status, created_at")
          .eq("organization_id", organizationId)
          .in("status", ["open", "dismissed"])
          .order("created_at", { ascending: false })
          .order("id", { ascending: false }),
      ),
    ]);
  } catch (error) {
    return abortOnReadError(organizationId, error);
  }

  const candidateKey = (type: OpportunityType, sourceEntityId: string) => `${type}:${sourceEntityId}`;
  const candidatesByKey = new Map(candidates.map((candidate) => [candidateKey(candidate.type, candidate.sourceEntityId), candidate]));
  const existingByKey = new Map(existingRows.map((row) => [candidateKey(row.type, row.source_entity_id), row]));

  // recentRows is already newest-first, so the first row seen per key is
  // the most recent open-or-dismissed row for that (type, source_entity_id).
  const dismissedKeys = new Set<string>();
  const seenKeys = new Set<string>();
  for (const row of recentRows) {
    const key = candidateKey(row.type, row.source_entity_id);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    if (row.status === "dismissed") dismissedKeys.add(key);
  }

  // Phase 2-9: per carry-forward rule, the status of each source's most
  // recent open-or-dismissed row among the rule's types (recentRows is
  // newest first, so the first row seen per source wins).
  const carryForwardStatus = new Map<OpportunityType, Map<string, OpportunityStatus>>();
  for (const rule of DISMISSAL_CARRY_FORWARD) {
    const group = new Set<OpportunityType>([rule.to, ...rule.from]);
    const latestBySource = new Map<string, OpportunityStatus>();
    for (const row of recentRows) {
      if (group.has(row.type) && !latestBySource.has(row.source_entity_id)) latestBySource.set(row.source_entity_id, row.status);
    }
    carryForwardStatus.set(rule.to, latestBySource);
  }

  let created = 0;
  let refreshed = 0;
  let resolved = 0;
  let unchanged = 0;
  let suppressed = 0;

  // Auto-resolve: an open row whose (type, source) is no longer a detected candidate.
  const toResolve = existingRows.filter((row) => !candidatesByKey.has(candidateKey(row.type, row.source_entity_id)));
  if (toResolve.length > 0) {
    // Canonical Opportunity Intelligence Layer, outcome instrumentation:
    // distinguishes a lead that was genuinely lost (a real, negative outcome
    // worth learning from later) from every other reason an opportunity's
    // underlying condition stopped being true (the lead got booked, the
    // estimate is no longer expired-and-idle, the customer is no longer
    // dormant, etc. - all genuinely good/neutral outcomes). Only a
    // lead-sourced opportunity can be "lost" this way; every other
    // source_entity_type resolves as condition_no_longer_true. One extra,
    // bounded, org-scoped query - never per-row.
    const leadSourcedIds = toResolve.filter((row) => row.source_entity_type === "lead").map((row) => row.source_entity_id);
    const lostLeadIds = new Set<string>();
    if (leadSourcedIds.length > 0) {
      // Still before the first write: a failed read aborts rather than
      // recording a lost lead as condition_no_longer_true.
      // Phase 2H: the organization's lost leads, matched in memory - the old
      // id list of the leads being resolved failed at ~400 ids.
      let lostLeads: { id: string }[];
      try {
        lostLeads = await checkedAll("sync.resolved_lead_statuses", () => supabase.from("leads").select("id").eq("organization_id", organizationId).eq("status", "lost").order("id"));
      } catch (error) {
        return abortOnReadError(organizationId, error);
      }
      const resolvingLeadIds = new Set(leadSourcedIds);
      for (const row of lostLeads) {
        if (resolvingLeadIds.has(row.id)) lostLeadIds.add(row.id);
      }
    }

    const lostRows = toResolve.filter((row) => lostLeadIds.has(row.source_entity_id));
    const otherRows = toResolve.filter((row) => !lostLeadIds.has(row.source_entity_id));

    // Phase 2H: in chunks of RESOLVE_CHUNK ids - a single update naming
    // every row failed outright past ~400 ids and was counted as 0 resolved
    // with nothing logged, leaving those opportunities open for good. Each
    // chunk counts the rows it actually changed; a failed chunk is logged.
    async function resolveBatch(rows: ExistingOpenRow[], reason: OpportunityResolutionReason): Promise<number> {
      let changed = 0;
      for (let i = 0; i < rows.length; i += RESOLVE_CHUNK) {
        const chunk = rows.slice(i, i + RESOLVE_CHUNK);
        const { data, error } = await supabase
          .from("opportunities")
          .update({ status: "resolved", resolved_at: now.toISOString(), resolution_reason: reason })
          .in("id", chunk.map((row) => row.id))
          .eq("organization_id", organizationId)
          .eq("status", "open")
          .select("id");
        if (error) console.error("[opportunities] failed to resolve opportunities", { organizationId, reason, count: chunk.length, error: error.message });
        else changed += (data ?? []).length;
      }
      return changed;
    }

    const [lostResolved, otherResolved] = await Promise.all([resolveBatch(lostRows, "lost"), resolveBatch(otherRows, "condition_no_longer_true")]);
    resolved = lostResolved + otherResolved;
  }

  for (const candidate of candidates) {
    const key = candidateKey(candidate.type, candidate.sourceEntityId);
    const existing = existingByKey.get(key);

    // Phase 2-6 (B1): pending estimates used to be keyed to their lead. A
    // dismissal of that old lead-keyed row carries forward to every
    // estimate-keyed candidate of the same lead, exactly as the old key
    // suppressed every estimate of that lead - so no dismissal is resurrected
    // by the re-key. The canonical estimate key is checked as for every type.
    const carriedLeadKey = candidate.type === "pending_estimate" ? pendingEstimateLeadId(candidate) : null;
    // Phase 2-8 (M5): a dismissal of any of the lead's completed visits suppresses its one completed-visit item.
    // Phase 2-9 (A15/B6): a directed cross-type carry-forward for the same source (DISMISSAL_CARRY_FORWARD).
    const dismissed =
      dismissedKeys.has(key) ||
      (carriedLeadKey !== null && dismissedKeys.has(candidateKey("pending_estimate", carriedLeadKey))) ||
      (candidate.dismissalAliases ?? []).some((alias) => dismissedKeys.has(candidateKey(candidate.type, alias))) ||
      carryForwardStatus.get(candidate.type)?.get(candidate.sourceEntityId) === "dismissed";

    if (!existing && dismissed) {
      suppressed += 1;
      continue;
    }

    if (!existing) {
      // Insert. A 23505 here means a concurrent sync (e.g. two tabs) already
      // won the race for this exact (org, type, source) - the partial
      // unique index is the real guarantee; this insert racing safely to a
      // no-op is the same "fast pre-check, DB constraint is the backstop"
      // shape this codebase already uses for appointment booking.
      const { error } = await supabase.from("opportunities").insert({
        organization_id: organizationId,
        type: candidate.type,
        source_entity_type: candidate.sourceEntityType,
        source_entity_id: candidate.sourceEntityId,
        contact_id: candidate.contactId,
        title: candidate.title,
        description: candidate.description,
        estimated_value: candidate.estimatedValue,
        value_basis: candidate.valueBasis,
        metadata: candidate.metadata,
      });
      if (!error) created += 1;
      else if (error.code !== "23505") console.error("[opportunities] failed to create opportunity", { organizationId, type: candidate.type, sourceEntityId: candidate.sourceEntityId, error: error.message });
      continue;
    }

    const changed =
      existing.title !== candidate.title ||
      existing.description !== candidate.description ||
      existing.estimated_value !== candidate.estimatedValue ||
      existing.value_basis !== candidate.valueBasis;

    if (changed) {
      const { error } = await supabase
        .from("opportunities")
        .update({ title: candidate.title, description: candidate.description, estimated_value: candidate.estimatedValue, value_basis: candidate.valueBasis, metadata: candidate.metadata })
        .eq("id", existing.id)
        .eq("organization_id", organizationId)
        .eq("status", "open");
      if (!error) refreshed += 1;
    } else {
      unchanged += 1;
    }
  }

  return { created, refreshed, resolved, unchanged, suppressed };
}

export type DismissOpportunityResult = { ok: true } | { ok: false; error: string };

/**
 * Finalization pass: the pure state-transition logic behind
 * app/(app)/dashboard/actions.ts's dismissOpportunity Server Action,
 * extracted so it can be exercised directly with a real, session-scoped test
 * client. That file's createClient() requires next/headers' cookies(), which
 * only resolves inside a real Next.js request - unreachable from a plain
 * node test, which is exactly why this write path had no dedicated test
 * before now. The exported Server Action is now a thin wrapper that resolves
 * the caller's own session/organization and delegates here; behavior is
 * byte-for-byte unchanged. Mirrors this codebase's own established
 * "*AsService"/dependency-injected split (e.g. createAutomationEvent vs.
 * createAutomationEventAsService, getAgencyHealth(sessionSupabase, ...)) -
 * not a new pattern.
 */
export async function dismissOpportunityForOrganization(supabase: SupabaseClient, organizationId: string, opportunityId: string): Promise<DismissOpportunityResult> {
  const opportunity = await getOpportunityById(supabase, organizationId, opportunityId);
  if (!opportunity) {
    return { ok: false, error: "Opportunity not found" };
  }
  if (opportunity.status !== "open") {
    return { ok: true };
  }

  const { error } = await supabase
    .from("opportunities")
    .update({ status: "dismissed", resolved_at: new Date().toISOString(), resolution_reason: "dismissed" })
    .eq("id", opportunityId)
    .eq("organization_id", organizationId)
    .eq("status", "open");

  if (error) {
    return { ok: false, error: "We couldn't dismiss that opportunity right now. Please try again." };
  }

  return { ok: true };
}

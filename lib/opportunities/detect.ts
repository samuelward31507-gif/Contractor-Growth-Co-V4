import type { SupabaseClient } from "@supabase/supabase-js";
import { contactDisplayName } from "@/lib/contacts/format";
import {
  isReactivationDue,
  ACTIVE_APPOINTMENT_STATUSES,
  ACTIVE_ESTIMATE_STATUSES,
  ACTIVE_JOB_STATUSES,
} from "@/lib/automation/customer-reactivation";
import { getAutomationConfigByOrganization, readCustomerReactivationConfig } from "@/lib/automation/settings";
import { OPEN_LEAD_STATUSES, type LeadStatus } from "@/lib/leads/queries";
import type { OpportunityType, OpportunityStatus } from "./queries";

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
 *   completed_appointment_no_estimate - the exact same query shape
 *                                        lib/bi/metrics.ts's own
 *                                        buildRevenueOpportunity already
 *                                        computes for
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
 *   completed_job_no_review_request - review_requests is only created when
 *                                      the organization has a real
 *                                      review_url configured (see
 *                                      lib/reviews-referrals/tracking.ts's
 *                                      recordPostJobFollowupOutcome) - a
 *                                      missing row is ambiguous between "the
 *                                      automation hasn't run yet", "it
 *                                      failed", and "this org simply has no
 *                                      review_url configured", which is not
 *                                      itself an actionable opportunity.
 *   repeat_service / maintenance    - no service-type or service-interval
 *                                      data exists anywhere in this schema;
 *                                      any "due for maintenance" claim would
 *                                      be fabricated, not derived.
 */

const MAX_ROWS = 5000;

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

async function detectQualifiedLeadsUnbooked(supabase: SupabaseClient, organizationId: string): Promise<OpportunityCandidate[]> {
  const { data: leadRows } = await supabase
    .from("leads")
    .select("id, contact_id, service, estimated_value, contacts(id, first_name, last_name, company_name)")
    .eq("organization_id", organizationId)
    .eq("status", "qualified")
    .limit(MAX_ROWS);

  const leads = (leadRows ?? []) as { id: string; contact_id: string | null; service: string | null; estimated_value: number | null; contacts: ContactRef }[];
  if (leads.length === 0) return [];

  const { data: appointmentRows } = await supabase.from("appointments").select("lead_id").eq("organization_id", organizationId).not("lead_id", "is", null).limit(MAX_ROWS);
  const bookedLeadIds = new Set(((appointmentRows ?? []) as { lead_id: string | null }[]).map((row) => row.lead_id));

  return leads
    .filter((lead) => !bookedLeadIds.has(lead.id))
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
  const { data } = await supabase
    .from("estimates")
    .select("id, contact_id, title, amount, sent_at, expires_at, contacts(id, first_name, last_name, company_name)")
    .eq("organization_id", organizationId)
    .eq("status", "expired")
    .limit(MAX_ROWS);

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
// C. completed_appointment_no_estimate - the same shape as
// lib/bi/metrics.ts's own getCompletedAppointmentsWithoutEstimate, run here
// independently (that function returns only a count, not enough to build
// individual opportunity rows) rather than duplicating its query logic
// inline there - both express the identical business rule.
// ---------------------------------------------------------------------------

async function detectCompletedAppointmentsWithoutEstimate(supabase: SupabaseClient, organizationId: string): Promise<OpportunityCandidate[]> {
  const { data: appointmentRows } = await supabase
    .from("appointments")
    .select("id, contact_id, lead_id, title, start_at, contacts(id, first_name, last_name, company_name)")
    .eq("organization_id", organizationId)
    .eq("status", "completed")
    .not("lead_id", "is", null)
    .limit(MAX_ROWS);

  const appointments = (appointmentRows ?? []) as { id: string; contact_id: string | null; lead_id: string | null; title: string; start_at: string; contacts: ContactRef }[];
  if (appointments.length === 0) return [];

  const leadIds = [...new Set(appointments.map((row) => row.lead_id).filter((id): id is string => id !== null))];
  const { data: estimateRows } = await supabase.from("estimates").select("lead_id").eq("organization_id", organizationId).in("lead_id", leadIds).limit(MAX_ROWS);
  const leadsWithEstimate = new Set(((estimateRows ?? []) as { lead_id: string | null }[]).map((row) => row.lead_id));

  return appointments
    .filter((row) => row.lead_id !== null && !leadsWithEstimate.has(row.lead_id))
    .map((row) => ({
      type: "completed_appointment_no_estimate" as const,
      sourceEntityType: "appointment" as const,
      sourceEntityId: row.id,
      contactId: row.contact_id,
      title: displayNameOrFallback(row.contacts, row.title),
      description: `Completed appointment "${row.title}" never turned into an estimate.`,
      // No reliable amount exists at this stage - no estimate has ever been
      // created for this lead, so there is nothing real to base a figure
      // on. Never guessed from an average or any other org.
      estimatedValue: null,
      valueBasis: null,
      metadata: { appointment_start_at: row.start_at },
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
  const configByOrg = await getAutomationConfigByOrganization(supabase, "customer-reactivation");
  const config = readCustomerReactivationConfig(configByOrg.get(organizationId) ?? null);

  const { data: jobRows } = await supabase
    .from("jobs")
    .select("id, contact_id, title, completed_at")
    .eq("organization_id", organizationId)
    .eq("status", "completed")
    .not("contact_id", "is", null)
    .not("completed_at", "is", null)
    .order("completed_at", { ascending: false })
    .limit(MAX_ROWS);

  const jobs = (jobRows ?? []) as { id: string; contact_id: string; title: string; completed_at: string }[];
  if (jobs.length === 0) return [];

  // Reduce to the single most recently completed job per contact - jobs
  // were fetched newest-first, exactly matching
  // processCustomerReactivation's own reduction.
  const latestJobByContact = new Map<string, { id: string; contact_id: string; title: string; completed_at: string }>();
  for (const job of jobs) {
    if (!latestJobByContact.has(job.contact_id)) latestJobByContact.set(job.contact_id, job);
  }

  const dueContactIds = [...latestJobByContact.values()].filter((job) => isReactivationDue(job.completed_at, config, now)).map((job) => job.contact_id);
  if (dueContactIds.length === 0) return [];

  const [{ data: leadRows }, { data: appointmentRows }, { data: estimateRows }, { data: activeJobRows }, { data: contactRows }] = await Promise.all([
    supabase.from("leads").select("contact_id, status").eq("organization_id", organizationId).in("contact_id", dueContactIds).limit(MAX_ROWS),
    supabase.from("appointments").select("contact_id").eq("organization_id", organizationId).in("contact_id", dueContactIds).in("status", ACTIVE_APPOINTMENT_STATUSES).limit(MAX_ROWS),
    supabase.from("estimates").select("contact_id").eq("organization_id", organizationId).in("contact_id", dueContactIds).in("status", ACTIVE_ESTIMATE_STATUSES).limit(MAX_ROWS),
    supabase.from("jobs").select("contact_id").eq("organization_id", organizationId).in("contact_id", dueContactIds).in("status", ACTIVE_JOB_STATUSES).limit(MAX_ROWS),
    supabase.from("contacts").select("id, first_name, last_name, company_name").eq("organization_id", organizationId).in("id", dueContactIds).limit(MAX_ROWS),
  ]);

  const contactsWithOpenLead = new Set(((leadRows ?? []) as { contact_id: string | null; status: LeadStatus }[]).filter((row) => row.contact_id && OPEN_LEAD_STATUSES.has(row.status)).map((row) => row.contact_id as string));
  const contactsWithActiveAppointment = new Set(((appointmentRows ?? []) as { contact_id: string | null }[]).map((row) => row.contact_id));
  const contactsWithActiveEstimate = new Set(((estimateRows ?? []) as { contact_id: string | null }[]).map((row) => row.contact_id));
  const contactsWithActiveJob = new Set(((activeJobRows ?? []) as { contact_id: string | null }[]).map((row) => row.contact_id));
  const contactsById = new Map(((contactRows ?? []) as { id: string; first_name: string | null; last_name: string | null; company_name: string | null }[]).map((row) => [row.id, row]));

  const eligibleContactIds = dueContactIds.filter(
    (contactId) => !contactsWithOpenLead.has(contactId) && !contactsWithActiveAppointment.has(contactId) && !contactsWithActiveEstimate.has(contactId) && !contactsWithActiveJob.has(contactId),
  );

  return eligibleContactIds.map((contactId) => {
    const job = latestJobByContact.get(contactId)!;
    const contact = contactsById.get(contactId) ?? null;
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
  const { data } = await supabase
    .from("appointments")
    .select("id, contact_id, title, start_at, contacts(id, first_name, last_name, company_name)")
    .eq("organization_id", organizationId)
    .eq("status", "no_show")
    .limit(MAX_ROWS);

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
  const { data: jobRows } = await supabase
    .from("jobs")
    .select("id, contact_id, title, completed_at, contacts(id, first_name, last_name, company_name)")
    .eq("organization_id", organizationId)
    .eq("status", "completed")
    .limit(MAX_ROWS);

  const jobs = (jobRows ?? []) as { id: string; contact_id: string | null; title: string; completed_at: string | null; contacts: ContactRef }[];
  if (jobs.length === 0) return [];

  const jobIds = jobs.map((job) => job.id);
  const { data: referralRows } = await supabase.from("referral_requests").select("job_id, status").eq("organization_id", organizationId).in("job_id", jobIds).limit(MAX_ROWS);
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

export async function detectAllOpportunityCandidates(supabase: SupabaseClient, organizationId: string, now: Date = new Date()): Promise<OpportunityCandidate[]> {
  const [qualifiedLeads, staleEstimates, completedAppointmentsNoEstimate, dormantCustomers, noShows, completedJobsNoReferralRequest] = await Promise.all([
    detectQualifiedLeadsUnbooked(supabase, organizationId),
    detectStaleEstimates(supabase, organizationId),
    detectCompletedAppointmentsWithoutEstimate(supabase, organizationId),
    detectDormantCustomers(supabase, organizationId, now),
    detectNoShows(supabase, organizationId),
    detectCompletedJobsWithoutReferralRequest(supabase, organizationId),
  ]);

  return [...qualifiedLeads, ...staleEstimates, ...completedAppointmentsNoEstimate, ...dormantCustomers, ...noShows, ...completedJobsNoReferralRequest];
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

export type OpportunitySyncResult = { created: number; refreshed: number; resolved: number; unchanged: number; suppressed: number };

type ExistingOpenRow = { id: string; type: OpportunityType; source_entity_id: string; title: string; description: string | null; estimated_value: number | null; value_basis: string | null; metadata: Record<string, unknown> | null };
type RecentRow = { type: OpportunityType; source_entity_id: string; status: OpportunityStatus; created_at: string };

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
  const [candidates, existingRows, recentRows] = await Promise.all([
    detectAllOpportunityCandidates(supabase, organizationId, now),
    supabase
      .from("opportunities")
      .select("id, type, source_entity_id, title, description, estimated_value, value_basis, metadata")
      .eq("organization_id", organizationId)
      .eq("status", "open")
      .limit(MAX_ROWS)
      .then((res) => (res.data ?? []) as ExistingOpenRow[]),
    // Only open/dismissed rows matter for dedup/suppression - a resolved
    // row never blocks re-creation, so it is deliberately excluded here.
    supabase
      .from("opportunities")
      .select("type, source_entity_id, status, created_at")
      .eq("organization_id", organizationId)
      .in("status", ["open", "dismissed"])
      .order("created_at", { ascending: false })
      .limit(MAX_ROWS)
      .then((res) => (res.data ?? []) as RecentRow[]),
  ]);

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

  let created = 0;
  let refreshed = 0;
  let resolved = 0;
  let unchanged = 0;
  let suppressed = 0;

  // Auto-resolve: an open row whose (type, source) is no longer a detected candidate.
  const toResolve = existingRows.filter((row) => !candidatesByKey.has(candidateKey(row.type, row.source_entity_id)));
  if (toResolve.length > 0) {
    const { error } = await supabase
      .from("opportunities")
      .update({ status: "resolved", resolved_at: now.toISOString() })
      .in("id", toResolve.map((row) => row.id))
      .eq("organization_id", organizationId)
      .eq("status", "open");
    if (!error) resolved = toResolve.length;
  }

  for (const candidate of candidates) {
    const key = candidateKey(candidate.type, candidate.sourceEntityId);
    const existing = existingByKey.get(key);

    if (!existing && dismissedKeys.has(key)) {
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

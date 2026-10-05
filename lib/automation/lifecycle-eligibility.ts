import type { SupabaseClient } from "@supabase/supabase-js";
import { OPEN_LEAD_STATUSES, type LeadStatus } from "@/lib/leads/queries";

/**
 * P0 A3: the ONE rule for whether a lead re-engagement automation (lost-lead
 * nurture, lead reactivation) may still act on a lead. Used by both
 * schedulers before anything is dispatched, and re-checked by the n8n
 * callback before any AI result is acted on - never re-implemented per
 * workflow. It only ever adds a restriction; the outbound gate still runs
 * afterwards, unchanged.
 *
 * For a lead re-engagement automation:
 *
 *   lead_contact_mismatch      the lead is not the acted-on contact's
 *   lead_superseded            an open candidate while the contact has a
 *                              NEWER open lead (the newer opportunity is the
 *                              current one), or a closed (lost) candidate
 *                              while the contact has ANY open lead
 *   contact_active_engagement  the contact has a scheduled/confirmed
 *                              appointment, sent/accepted estimate or
 *                              scheduled/in-progress job (on any lead) - the
 *                              same contact-level rule customer reactivation
 *                              already applies, with the outbound gate's
 *                              own active-status sets
 *   sms_intake_not_qualified   reactivation only: an 'sms_inbound' lead still
 *                              'new'. A1 creates one automatically for any
 *                              text from a contact with only closed history
 *                              (it may just be "thanks"); nothing moves a
 *                              lead out of 'new' except a person, so until
 *                              someone qualifies it, it is not a stale
 *                              opportunity to chase.
 *
 * A block is a business outcome, recorded as a completed execution with a
 * blocked_reason (outcome 'blocked') - never a failure, never an
 * escalation, never a message.
 */
export type LeadReengagementAutomation = "lead.lost_nurture" | "lead.reactivation";

export type LifecycleBlockReason = "lead_contact_mismatch" | "lead_superseded" | "contact_active_engagement" | "sms_intake_not_qualified";

export type LifecycleLead = { id: string; contact_id: string | null; status: LeadStatus; source: string | null; created_at: string };

export type LifecycleFacts = {
  lead: LifecycleLead;
  /** The contact the automation is acting on (the event's contact, else the lead's). */
  contactId: string | null;
  /** The contact's OTHER open leads (never the candidate itself). */
  otherOpenLeads: { id: string; created_at: string }[];
  /** The first active appointment/estimate/job found for the contact, if any. */
  activeEngagement: "appointment" | "estimate" | "job" | null;
};

export type LifecycleDecision = { eligible: true } | { eligible: false; reason: LifecycleBlockReason; detail: string };

export const ACTIVE_APPOINTMENT_STATUSES = ["scheduled", "confirmed"];
export const ACTIVE_ESTIMATE_STATUSES = ["sent", "accepted"];
export const ACTIVE_JOB_STATUSES = ["scheduled", "in_progress"];

/** Pure: the decision for one lead re-engagement touch. */
export function evaluateLifecycleEligibility(automation: LeadReengagementAutomation, facts: LifecycleFacts): LifecycleDecision {
  const { lead } = facts;
  if (!lead.contact_id || (facts.contactId !== null && facts.contactId !== lead.contact_id)) {
    return { eligible: false, reason: "lead_contact_mismatch", detail: "the lead does not belong to this contact" };
  }
  const superseded = OPEN_LEAD_STATUSES.has(lead.status)
    ? facts.otherOpenLeads.some((other) => new Date(other.created_at).getTime() > new Date(lead.created_at).getTime())
    : facts.otherOpenLeads.length > 0;
  if (superseded) {
    return { eligible: false, reason: "lead_superseded", detail: "the contact has a newer open opportunity" };
  }
  if (facts.activeEngagement) {
    return { eligible: false, reason: "contact_active_engagement", detail: `the contact has an active ${facts.activeEngagement}` };
  }
  if (automation === "lead.reactivation" && lead.source === "sms_inbound" && lead.status === "new") {
    return { eligible: false, reason: "sms_intake_not_qualified", detail: "an automatic SMS intake lead nobody has qualified yet" };
  }
  return { eligible: true };
}

/** Reads the facts for one lead (live). Null when the lead no longer exists. */
export async function loadLifecycleFacts(supabase: SupabaseClient, organizationId: string, leadId: string, actingContactId: string | null = null): Promise<LifecycleFacts | null> {
  const { data: lead } = await supabase
    .from("leads")
    .select("id, contact_id, status, source, created_at")
    .eq("id", leadId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!lead) return null;
  const contactId = (lead.contact_id as string | null) ?? null;
  if (!contactId) return { lead: lead as LifecycleLead, contactId: actingContactId, otherOpenLeads: [], activeEngagement: null };

  const [{ data: openLeads }, { data: appointment }, { data: estimate }, { data: job }] = await Promise.all([
    supabase.from("leads").select("id, created_at").eq("organization_id", organizationId).eq("contact_id", contactId).in("status", [...OPEN_LEAD_STATUSES]).order("created_at", { ascending: false }).limit(50),
    supabase.from("appointments").select("id").eq("organization_id", organizationId).eq("contact_id", contactId).in("status", ACTIVE_APPOINTMENT_STATUSES).limit(1).maybeSingle(),
    supabase.from("estimates").select("id").eq("organization_id", organizationId).eq("contact_id", contactId).in("status", ACTIVE_ESTIMATE_STATUSES).limit(1).maybeSingle(),
    supabase.from("jobs").select("id").eq("organization_id", organizationId).eq("contact_id", contactId).in("status", ACTIVE_JOB_STATUSES).limit(1).maybeSingle(),
  ]);

  const otherOpenLeads = ((openLeads ?? []) as { id: string; created_at: string }[]).filter((row) => row.id !== leadId);
  const activeEngagement = appointment ? "appointment" : estimate ? "estimate" : job ? "job" : null;

  return { lead: lead as LifecycleLead, contactId: actingContactId ?? contactId, otherOpenLeads, activeEngagement };
}

/** Load + evaluate. A lead that no longer exists is ineligible (lead_contact_mismatch). */
export async function checkLifecycleEligibility(supabase: SupabaseClient, organizationId: string, automation: LeadReengagementAutomation, leadId: string, actingContactId: string | null = null): Promise<LifecycleDecision> {
  const facts = await loadLifecycleFacts(supabase, organizationId, leadId, actingContactId);
  if (!facts) return { eligible: false, reason: "lead_contact_mismatch", detail: "the lead no longer exists" };
  return evaluateLifecycleEligibility(automation, facts);
}

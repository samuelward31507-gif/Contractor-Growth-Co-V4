import type { SupabaseClient } from "@supabase/supabase-js";
import type { LeadStatus } from "@/lib/leads/queries";

/**
 * P0-B B0: the final staleness re-check for an Instant Lead Follow-Up
 * (`lead.created`) draft, run by the n8n callback immediately before the
 * draft is sent - after the outbound gate has already allowed it.
 *
 * The draft is written by n8n from the lead as it was when it arrived, but
 * it can land much later: an n8n delay, a 60-minute execution timeout, up to
 * 3 automatic A2 retries, or a staff retry days later. By then the customer
 * may have moved forward and a "thanks for reaching out" would be stale.
 * The draft is blocked (a completed execution with a blocked_reason - a
 * business outcome, never a failure, never retried) when, at send time:
 *
 *   lead_not_found          the lead is gone
 *   lead_status_ineligible  the lead is no longer new/contacted/qualified
 *                           (it reached appointment/estimate/won/lost)
 *   draft_expired           the lead arrived more than
 *                           INSTANT_FOLLOWUP_MAX_DRAFT_AGE_HOURS ago
 *   lead_advanced           an appointment, estimate or job was created for
 *                           this customer after the lead arrived (any lead -
 *                           leads.status is not synced when those are made)
 *   customer_replied        the customer texted after the lead arrived (the
 *                           inbound-reply automation answers that instead)
 *   staff_replied           a person on the team messaged the customer after
 *                           the lead arrived
 *
 * "After the lead arrived" is anchored on the lead.created event's own
 * created_at, so prior history (an older job, an old conversation) never
 * blocks a returning customer's first reply. Everything else - the outbound
 * gate, idempotency, A2 retry, A3 - is unchanged.
 */

export const INSTANT_FOLLOWUP_EVENT_TYPE = "lead.created";

/**
 * Covers the legitimate retry window (3 automatic attempts, each bounded by
 * the 60-minute execution timeout, plus backoff - a little over 3 hours)
 * with margin; a draft older than this is a stale first-contact message.
 */
export const INSTANT_FOLLOWUP_MAX_DRAFT_AGE_HOURS = 6;

export const INSTANT_FOLLOWUP_LEAD_STATUSES: readonly LeadStatus[] = ["new", "contacted", "qualified"];

export type InstantFollowupBlockReason = "lead_not_found" | "lead_status_ineligible" | "draft_expired" | "lead_advanced" | "customer_replied" | "staff_replied";

export type InstantFollowupFacts = {
  leadStatus: LeadStatus | null;
  /** The lead.created event's created_at - null only when unknown. */
  draftCreatedAt: string | null;
  advancedSince: "appointment" | "estimate" | "job" | null;
  customerRepliedSince: boolean;
  staffMessagedSince: boolean;
};

export type InstantFollowupDecision = { eligible: true } | { eligible: false; reason: InstantFollowupBlockReason; detail: string };

const HOUR_MS = 60 * 60 * 1000;

/** Pure: whether an instant follow-up draft may still be sent now. */
export function evaluateInstantFollowup(facts: InstantFollowupFacts, now: Date): InstantFollowupDecision {
  if (!facts.leadStatus) return { eligible: false, reason: "lead_not_found", detail: "the lead no longer exists" };
  if (!INSTANT_FOLLOWUP_LEAD_STATUSES.includes(facts.leadStatus)) {
    return { eligible: false, reason: "lead_status_ineligible", detail: `lead status is ${facts.leadStatus}` };
  }
  if (facts.draftCreatedAt) {
    const ageHours = (now.getTime() - new Date(facts.draftCreatedAt).getTime()) / HOUR_MS;
    if (ageHours > INSTANT_FOLLOWUP_MAX_DRAFT_AGE_HOURS) {
      return { eligible: false, reason: "draft_expired", detail: `${Math.floor(ageHours)} hours after the lead arrived` };
    }
  }
  if (facts.advancedSince) return { eligible: false, reason: "lead_advanced", detail: `${facts.advancedSince === "job" ? "a" : "an"} ${facts.advancedSince} was created after the lead arrived` };
  if (facts.customerRepliedSince) return { eligible: false, reason: "customer_replied", detail: "the customer texted after the lead arrived" };
  if (facts.staffMessagedSince) return { eligible: false, reason: "staff_replied", detail: "the team messaged the customer after the lead arrived" };
  return { eligible: true };
}

/** Reads the facts live (service-role client) and evaluates them. */
export async function checkInstantFollowupStillCurrent(
  service: SupabaseClient,
  input: { organizationId: string; leadId: string | null; contactId: string | null; draftCreatedAt: string | null; now?: Date },
): Promise<InstantFollowupDecision> {
  const now = input.now ?? new Date();
  const { data: lead } = input.leadId
    ? await service.from("leads").select("status, contact_id").eq("id", input.leadId).eq("organization_id", input.organizationId).maybeSingle()
    : { data: null };

  const facts: InstantFollowupFacts = {
    leadStatus: ((lead?.status as LeadStatus | undefined) ?? null),
    draftCreatedAt: input.draftCreatedAt,
    advancedSince: null,
    customerRepliedSince: false,
    staffMessagedSince: false,
  };

  const contactId = (lead?.contact_id as string | null | undefined) ?? input.contactId;
  if (lead && contactId && input.draftCreatedAt) {
    const since = input.draftCreatedAt;
    const createdSince = (table: "appointments" | "estimates" | "jobs") =>
      service.from(table).select("id").eq("organization_id", input.organizationId).eq("contact_id", contactId).gt("created_at", since).limit(1).maybeSingle();
    const [{ data: appointment }, { data: estimate }, { data: job }, { data: conversations }] = await Promise.all([
      createdSince("appointments"),
      createdSince("estimates"),
      createdSince("jobs"),
      service.from("conversations").select("id").eq("organization_id", input.organizationId).eq("contact_id", contactId),
    ]);
    facts.advancedSince = appointment ? "appointment" : estimate ? "estimate" : job ? "job" : null;

    const conversationIds = ((conversations ?? []) as { id: string }[]).map((row) => row.id);
    if (conversationIds.length > 0) {
      const [{ data: inbound }, { data: staff }] = await Promise.all([
        service.from("messages").select("id").eq("organization_id", input.organizationId).in("conversation_id", conversationIds).eq("direction", "inbound").gt("created_at", since).limit(1).maybeSingle(),
        service.from("messages").select("id").eq("organization_id", input.organizationId).in("conversation_id", conversationIds).eq("direction", "outbound").eq("sender_type", "user").gt("created_at", since).limit(1).maybeSingle(),
      ]);
      facts.customerRepliedSince = Boolean(inbound);
      facts.staffMessagedSince = Boolean(staff);
    }
  }

  return evaluateInstantFollowup(facts, now);
}

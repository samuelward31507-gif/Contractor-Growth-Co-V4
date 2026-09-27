import type { AttentionItem } from "@/lib/dashboard/queries";
import type { OpportunityType } from "@/lib/opportunities/queries";
import type { StatusTone } from "@/lib/ui/status";

/**
 * Phase 2 (Today pass): translates every machine-named condition the
 * dashboard's Attention Engine can produce into a contractor-readable
 * label and a status tone. Written as an exhaustive Record over the real,
 * current AttentionItem["kind"] union (imported, never re-declared) so
 * TypeScript fails the build the moment a kind is added without a copy
 * entry - the repo already does exactly this in
 * app/(app)/_components/nav-items.test.ts, extended here to a second
 * exhaustiveness point rather than invented fresh.
 *
 * Deliberately does NOT include a "sentence" per kind the way the plan's
 * own example table shows ("The last two unconfirmed visits were
 * no-shows.") - that level of specific narrative needs data this phase
 * has no query for (Phase 2's own instruction is zero new queries). The
 * real, already-correct explanation for every item is already sitting in
 * AttentionItem.detail (see lib/dashboard/queries.ts), so the Today page
 * uses that verbatim as the QueueCard's one sentence, rather than this
 * file inventing plausible-sounding specifics it can't actually verify.
 */
export const ATTENTION_COPY: Record<AttentionItem["kind"], { label: string; tone: StatusTone }> = {
  human_escalation: { label: "Needs a human", tone: "urgent" },
  awaiting_reply: { label: "Waiting on a reply", tone: "urgent" },
  abandoned_conversation: { label: "Conversation went quiet", tone: "urgent" },
  calendar_disconnected: { label: "Calendar disconnected", tone: "urgent" },
  overdue_appointment: { label: "Appointment overdue", tone: "urgent" },
  awaiting_confirmation: { label: "Visit not confirmed", tone: "urgent" },
  no_show: { label: "No-show", tone: "urgent" },
  accepted_estimate_no_job: { label: "They said yes, nothing scheduled", tone: "urgent" },

  hot_lead: { label: "Hot lead", tone: "soon" },
  high_value_lead: { label: "High-value lead", tone: "soon" },
  pending_estimate: { label: "Estimate pending", tone: "soon" },
  stale_estimate: { label: "Quote going cold", tone: "soon" },
  uncontacted_lead: { label: "Nobody called them back", tone: "soon" },

  dormant_customer: { label: "Hasn't called in a while", tone: "good" },
  cancelled_appointment_no_rebooking: { label: "Cancelled, not rebooked", tone: "good" },
  completed_job_no_review_request: { label: "No review requested yet", tone: "good" },
  completed_job_no_referral_request: { label: "No referral requested yet", tone: "good" },
};

/**
 * The two OpportunityType values with no matching AttentionItem kind at
 * all (see lib/dashboard/queries.ts's own AttentionItem["kind"] comment -
 * "qualified_lead_unbooked and completed_appointment_no_estimate remain
 * deliberately unrepresented here... they would duplicate hot_lead/
 * high_value_lead/pending_estimate"). The Today page surfaces these two
 * directly from getOpenOpportunities so their signal isn't lost, without
 * re-deriving the other 8 opportunity types the Attention Engine already
 * folds into the kinds above (rendering both would double-count the same
 * underlying opportunity).
 */
export const OPPORTUNITY_ONLY_COPY: Partial<Record<OpportunityType, { label: string; tone: StatusTone }>> = {
  qualified_lead_unbooked: { label: "Qualified, not booked", tone: "soon" },
  completed_appointment_no_estimate: { label: "Visited, no estimate sent", tone: "soon" },
};

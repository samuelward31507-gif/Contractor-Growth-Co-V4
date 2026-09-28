import {
  CalendarPlus,
  PhoneMissed,
  FileCheck2,
  FileClock,
  FilePlus2,
  CalendarX,
  Repeat,
  UserX,
  Star,
  Share2,
  Flame,
  Send,
  type LucideIcon,
} from "lucide-react";
import type { BadgeTone } from "@/lib/ui/badge";
import type { Opportunity, OpportunityType } from "@/lib/opportunities/queries";

/**
 * Trackpr 2.0, Phase 3F: the presentation-only layer for the 10 opportunity
 * types the existing Opportunity Engine already detects and persists
 * (lib/opportunities/detect.ts/queries.ts, untouched by this file). This
 * gives each raw enum value (never shown to the user directly - see
 * OPPORTUNITY_TYPE_LABEL) a human-readable label, an icon, a restrained
 * BadgeTone, and a link to the existing canonical surface that already owns
 * that opportunity's underlying record - never a new route, never an
 * invented relationship. 8 of these 10 icon/tone choices deliberately match
 * the exact ones app/(app)/dashboard/_components/attention-panel.tsx already
 * uses for the same types, so the same underlying opportunity reads as the
 * same thing whether seen on the Dashboard or here; the 2 types Dashboard
 * has never surfaced (qualified_lead_unbooked, completed_appointment_no_estimate)
 * get new, but consistent, choices.
 *
 * Canonical Opportunity Intelligence Layer: display order below now matches
 * lib/opportunities/intelligence.ts's own TIER_BY_TYPE exactly (committed
 * revenue at risk -> active pursuit -> at risk -> recoverable -> growth) -
 * not a second, independently-drifting ordering. Browsing/filtering here
 * must never disagree with Today's own priority ordering of the same
 * underlying rows.
 */
export const OPPORTUNITY_TYPE_ORDER: OpportunityType[] = [
  "accepted_estimate_no_job",
  "qualified_lead_unbooked",
  "completed_appointment_no_estimate",
  "uncontacted_lead",
  "active_lead_signal",
  "pending_estimate",
  "no_show",
  "cancelled_appointment_no_rebooking",
  "stale_estimate",
  "dormant_customer",
  "completed_job_no_review_request",
  "completed_job_no_referral_request",
];

export const OPPORTUNITY_TYPE_LABEL: Record<OpportunityType, string> = {
  uncontacted_lead: "Never contacted",
  qualified_lead_unbooked: "Qualified, not booked",
  accepted_estimate_no_job: "Accepted, no job yet",
  stale_estimate: "Estimate expired",
  completed_appointment_no_estimate: "Visit completed, no estimate",
  no_show: "Missed appointment",
  cancelled_appointment_no_rebooking: "Cancelled, not rebooked",
  dormant_customer: "Dormant customer",
  completed_job_no_review_request: "Review request needed",
  completed_job_no_referral_request: "Referral request needed",
  active_lead_signal: "Marked hot or high-value",
  pending_estimate: "Estimate sent, awaiting reply",
};

export const OPPORTUNITY_TYPE_ICON: Record<OpportunityType, LucideIcon> = {
  uncontacted_lead: PhoneMissed,
  qualified_lead_unbooked: CalendarPlus,
  accepted_estimate_no_job: FileCheck2,
  stale_estimate: FileClock,
  completed_appointment_no_estimate: FilePlus2,
  no_show: CalendarX,
  cancelled_appointment_no_rebooking: Repeat,
  dormant_customer: UserX,
  completed_job_no_review_request: Star,
  completed_job_no_referral_request: Share2,
  active_lead_signal: Flame,
  pending_estimate: Send,
};

export const OPPORTUNITY_TYPE_TONE: Record<OpportunityType, BadgeTone> = {
  uncontacted_lead: "danger",
  qualified_lead_unbooked: "info",
  accepted_estimate_no_job: "success",
  stale_estimate: "warning",
  completed_appointment_no_estimate: "warning",
  no_show: "warning",
  cancelled_appointment_no_rebooking: "warning",
  dormant_customer: "neutral",
  completed_job_no_review_request: "neutral",
  completed_job_no_referral_request: "neutral",
  active_lead_signal: "info",
  pending_estimate: "neutral",
};

/**
 * The one action target per type - reuses exactly the same canonical
 * destinations Phase 3C/3D/3E already established (People, Schedule's list
 * view, Estimates), or, for the job/estimate-sourced types, the real
 * existing detail route via the opportunity's own sourceEntityId - the exact
 * same deep-link Dashboard's own attention items already use for the two
 * job-sourced types (lib/dashboard/queries.ts). Never a new route, never a
 * fabricated relationship - every href below is either a canonical
 * destination this redesign already shipped, or data the Opportunity Engine
 * already provides on the opportunity itself.
 *
 * Final Major Product Build (nav-restructure follow-up): accepted_estimate_
 * no_job/stale_estimate/pending_estimate used to all point at the generic
 * /money browse view - a real destination, but a dead end relative to the
 * specific record the opportunity is actually about, and stale now that
 * Estimates is its own nav destination rather than Money. These three now
 * deep-link straight to the real estimate record (sourceEntityId for the
 * first two; pending_estimate's own sourceEntityId is deliberately the
 * LEAD's id - see detectPendingEstimates's own comment in
 * lib/opportunities/detect.ts - so its real estimate id is read from
 * metadata.estimate_id, which that same detector always sets).
 * completed_appointment_no_estimate's own action is labeled "Create
 * estimate" (OPPORTUNITY_ACTION_LABEL below) but used to land on a page with
 * no create affordance for this specific customer - it now opens the real
 * create-estimate dialog on /estimates pre-filled with this contact (see
 * AddEstimateButton's own contactId query-param support), so the label is
 * no longer aspirational.
 */
export function opportunityActionHref(opportunity: Opportunity): string {
  switch (opportunity.type) {
    case "uncontacted_lead":
    case "qualified_lead_unbooked":
    case "active_lead_signal":
      return opportunity.contactId ? `/people/${opportunity.contactId}` : "/people";
    case "accepted_estimate_no_job":
    case "stale_estimate":
      return `/estimates/${opportunity.sourceEntityId}`;
    case "pending_estimate": {
      const estimateId = opportunity.metadata.estimate_id;
      return typeof estimateId === "string" ? `/estimates/${estimateId}` : "/estimates";
    }
    case "completed_appointment_no_estimate":
      return opportunity.contactId ? `/estimates?new=estimate&contactId=${opportunity.contactId}` : "/estimates";
    case "no_show":
    case "cancelled_appointment_no_rebooking":
      return "/schedule?view=list";
    case "dormant_customer":
      return opportunity.contactId ? `/people/${opportunity.contactId}` : "/people";
    case "completed_job_no_review_request":
    case "completed_job_no_referral_request":
      return `/jobs/${opportunity.sourceEntityId}`;
  }
}

export const OPPORTUNITY_ACTION_LABEL: Record<OpportunityType, string> = {
  uncontacted_lead: "View lead",
  qualified_lead_unbooked: "View lead",
  accepted_estimate_no_job: "View estimate",
  stale_estimate: "View estimate",
  completed_appointment_no_estimate: "Create estimate",
  no_show: "View schedule",
  cancelled_appointment_no_rebooking: "View schedule",
  dormant_customer: "View customer",
  completed_job_no_review_request: "View job",
  completed_job_no_referral_request: "View job",
  active_lead_signal: "View lead",
  pending_estimate: "View estimate",
};

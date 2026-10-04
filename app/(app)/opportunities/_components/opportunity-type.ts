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
  Receipt,
  AlertTriangle,
  type LucideIcon,
} from "lucide-react";
import type { BadgeTone } from "@/lib/ui/badge";
import { OPPORTUNITY_VALUE_CLASS, summarizeOpportunities, type Opportunity, type OpportunityType } from "@/lib/opportunities/queries";
import { formatCurrency } from "@/lib/dashboard/format";

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
  "invoice_overdue",
  "completed_job_not_invoiced",
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
  completed_job_not_invoiced: Receipt,
  invoice_overdue: AlertTriangle,
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
  completed_job_not_invoiced: "warning",
  invoice_overdue: "danger",
};

/**
 * Phase 2-2: the problem labels, action labels and action links now live in
 * the single next-action registry (lib/decisions/registry.ts). Re-exported
 * here, unchanged, for the By type list and every existing importer.
 */
export { OPPORTUNITY_TYPE_LABEL, OPPORTUNITY_ACTION_LABEL, opportunityActionHref } from "@/lib/decisions/registry";

/**
 * Phase 2-13 (§7): a By type group's header - its class's money total (every
 * type has exactly one class, so a group never mixes committed and
 * potential) and its count. Non-monetary groups, and groups where no item
 * has a value entered yet, show the count only - never a "$0" total.
 */
export function groupTotalLabel(type: OpportunityType, items: Opportunity[]): string {
  const valueClass = OPPORTUNITY_VALUE_CLASS[type];
  if (valueClass === "non_monetary") return String(items.length);
  const total = summarizeOpportunities(items)[valueClass];
  if (total.unknownValueCount === total.count) return String(items.length);
  return `${formatCurrency(total.value)} ${valueClass} · ${items.length}`;
}

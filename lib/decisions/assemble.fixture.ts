/**
 * Phase 2-2: the shared parity fixture for assemble.test.ts - every source
 * Today renders (2 escalations, a calendar failure, all 4 signal kinds, and
 * opportunities in every tier), with ties, unknown values, a missing
 * contact, an invalid phone and two kinds Today ignores. Dates are relative
 * to the moment it is built, so relative ages render deterministically.
 */
import type { AttentionItem } from "@/lib/dashboard/queries";
import type { PrioritizedOpportunity, PriorityTier, RecommendedAction } from "@/lib/opportunities/intelligence";
import type { Opportunity, OpportunityType } from "@/lib/opportunities/queries";

const DAY = 24 * 60 * 60 * 1000;

export function buildParityFixture(now: number = Date.now()): { attentionItems: AttentionItem[]; prioritizedOpportunities: PrioritizedOpportunity[] } {
  const daysAgo = (days: number) => new Date(now - days * DAY).toISOString();

  const attentionItems: AttentionItem[] = [
    { id: "escalation-inc-1", kind: "human_escalation", title: "AI needs your attention", detail: "Customer asked for a person.", value: null, href: "/conversations/c-esc", incidentId: "inc-1", incidentStatus: "open" },
    { id: "escalation-x", kind: "human_escalation", title: "AI needs your attention", detail: "A conversation needs a human reply.", value: null, href: "/conversations" },
    { id: "reply-a", kind: "awaiting_reply", title: "Ann Lee", detail: "Waiting for a reply 2 hours ago", value: null, href: "/conversations/a" },
    { id: "reply-b", kind: "awaiting_reply", title: "Bo Chen", detail: "Waiting for a reply 3 hours ago", value: null, href: "/conversations/b" },
    { id: "abandoned-c", kind: "abandoned_conversation", title: "Cy Diaz", detail: "No reply since we last reached out, 3 days ago", value: null, href: "/conversations/c" },
    { id: "calendar-1", kind: "calendar_disconnected", title: "Google Calendar sync failed", detail: "Token expired", value: null, href: "/settings" },
    { id: "apt-1", kind: "overdue_appointment", title: "Di Evans", detail: "Was scheduled yesterday", value: null, href: "/appointments/apt-1" },
    { id: "apt-confirm-2", kind: "awaiting_confirmation", title: "Ed Fox", detail: "Confirmation requested 2 hours ago - no response yet", value: null, href: "/appointments/apt-2" },
    // Two kinds Today never renders from this list - they must be ignored.
    { id: "hot-1", kind: "hot_lead", title: "Hot Lead", detail: "Marked hot - follow up soon", value: "$9,000", href: "/leads/1" },
    { id: "opp-ns", kind: "no_show", title: "Legacy No-show", detail: "Missed appointment - needs rescheduling.", value: null, href: "/appointments", opportunityId: "opp-legacy" },
  ];

  const make = (
    id: string,
    type: OpportunityType,
    tier: PriorityTier,
    o: { value: number | null; days: number; contactId: string | null; phone: string | null; action: RecommendedAction; primary: string; supporting?: string[]; counter?: string[]; sourceEntityId?: string; metadata?: Record<string, unknown> },
  ): PrioritizedOpportunity => {
    const opportunity: Opportunity = {
      id, type, status: "open", sourceEntityType: "lead", sourceEntityId: o.sourceEntityId ?? `src-${id}`, contactId: o.contactId, title: `Person ${id}`, description: o.primary,
      estimatedValue: o.value, valueBasis: null, createdAt: daysAgo(o.days), updatedAt: daysAgo(o.days), resolvedAt: null, resolutionReason: null, metadata: o.metadata ?? {},
    };
    return {
      opportunity, tier, valueState: o.value != null ? "known" : "unknown",
      explanation: { primaryReason: o.primary, supportingSignals: o.supporting ?? [], counterSignals: o.counter ?? [], confidence: "confirmed" },
      recommendedAction: o.action, automatable: false, contactPhone: o.phone,
    };
  };

  // Deliberately NOT in priority order - buildPriorityQueue sorts.
  const prioritizedOpportunities: PrioritizedOpportunity[] = [
    make("o10", "completed_job_no_referral_request", "growth", { value: null, days: 2, contactId: "c9", phone: null, action: "request_referral", primary: 'Completed job "Roof" has no referral request yet.', supporting: ["Value not yet entered"], sourceEntityId: "job-1" }),
    make("o4", "uncontacted_lead", "active_pursuit", { value: null, days: 2, contactId: "c4", phone: "+15125550104", action: "call", primary: "New lead from the website hasn't been contacted.", supporting: ["Value not yet entered"] }),
    make("o3", "completed_job_not_invoiced", "committed_revenue_at_risk", { value: null, days: 5, contactId: null, phone: null, action: "create_invoice", primary: 'Completed job "Gutter" has not been invoiced yet.', supporting: ["Value not yet entered"], sourceEntityId: "job-3" }),
    make("o8", "no_show", "at_risk", { value: null, days: 2, contactId: "c8", phone: null, action: "rebook", primary: "Missed appointment - needs rescheduling." }),
    make("o1", "invoice_overdue", "committed_revenue_at_risk", { value: 3000, days: 2, contactId: "c1", phone: "+15125550101", action: "collect_payment", primary: "INV-000004 was due 2026-07-23 - $3,000 still outstanding.", sourceEntityId: "job-4", metadata: { invoice_id: "inv-4" } }),
    make("o11", "dormant_customer", "recoverable", { value: null, days: 3, contactId: "c11", phone: null, action: "reactivate", primary: "No activity since their last completed job." }),
    make("o6", "pending_estimate", "active_pursuit", { value: 5000, days: 3, contactId: "c6", phone: null, action: "monitor", primary: 'Estimate "Deck" sent - awaiting the customer\'s decision.', metadata: { estimate_id: "est-9" } }),
    make("o9", "completed_job_no_review_request", "growth", { value: 3000, days: 2, contactId: "c9", phone: null, action: "request_review", primary: 'Completed job "Roof" has no review request yet.', sourceEntityId: "job-1" }),
    make("o5", "uncontacted_lead", "active_pursuit", { value: null, days: 5, contactId: "c5", phone: "555-0105", action: "follow_up", primary: "New lead from the website hasn't been contacted.", supporting: ["Value not yet entered"], counter: ["Flagged 5 days ago - still unresolved."] }),
    make("o2", "accepted_estimate_no_job", "committed_revenue_at_risk", { value: 2500, days: 3, contactId: "c2", phone: null, action: "create_job", primary: 'Estimate "Roof" was accepted, but no job has been created yet.', sourceEntityId: "est-7" }),
    make("o7", "stale_estimate", "at_risk", { value: 1000, days: 3, contactId: "c7", phone: null, action: "follow_up_estimate", primary: 'Estimate "Siding" expired with no customer decision recorded.', sourceEntityId: "est-8" }),
  ];

  return { attentionItems, prioritizedOpportunities };
}

import type { AgentOutput, Finding, Recommendation, Severity } from "../contract";
import { formatCount, formatUsd, plural } from "../format";

/**
 * Sales agent. Reads the decision items Today already assembles
 * (lib/decisions/assemble.ts) - never re-detects anything - and groups them
 * into the few findings a salesperson acts on. Every count is a FACT read
 * from those items. Recommendations point at the existing record or list
 * where a person does the work; this agent never messages anyone.
 */

export type SalesItem = {
  key: string;
  reasonCode: string;
  /** null for operational exceptions. */
  tier: string | null;
  act: "attention" | "opportunity" | "system";
  actor: "human" | "trackpr";
  missedFollowUp: "first_contact" | "reply" | "estimate_followup" | null;
  name: string;
  actionHref: string;
  /** Known dollar value, when the source opportunity records one. */
  value: number | null;
};

export type SalesInput = {
  /** Operational exceptions (human escalations, calendar), human attention items, Act III opportunities - as Today shows them. */
  exceptions: SalesItem[];
  attention: SalesItem[];
  opportunities: SalesItem[];
  /** Attention items Trackpr's own automation still has pending - nothing for a person to do yet. */
  trackprHandling: SalesItem[];
};

type Group = {
  id: string;
  match: (item: SalesItem) => boolean;
  kind: Finding["kind"];
  severity: (items: SalesItem[]) => Severity;
  title: (n: number) => string;
  detail: string;
  fallbackHref: string;
  action: string;
};

const APPOINTMENT_CODES = new Set(["appointment_overdue", "appointment_unconfirmed", "appointment_no_show", "appointment_cancelled_not_rebooked", "appointment_completed_no_estimate"]);
const ESTIMATE_CODES = new Set(["estimate_awaiting_decision", "estimate_expired"]);
const LEAD_CODES = new Set(["lead_not_contacted", "qualified_not_booked", "lead_marked_hot_or_high_value"]);

/** Attention groups, most urgent first. Each item lands in the first group that matches, so nothing is counted twice. */
const ATTENTION_GROUPS: Group[] = [
  {
    id: "missed_follow_up",
    match: (item) => item.missedFollowUp !== null,
    kind: "risk",
    severity: (items) => (items.some((i) => i.missedFollowUp === "reply") ? "critical" : "high"),
    title: (n) => `${formatCount(n)} missed ${plural(n, "follow-up", "follow-ups")}`,
    detail: "Past the follow-up window: a lead never contacted, a reply waiting too long, or a sent estimate with no follow-up since.",
    fallbackHref: "/today",
    action: "Work the missed follow-ups",
  },
  {
    id: "awaiting_reply",
    match: (item) => item.reasonCode === "customer_awaiting_reply",
    kind: "risk",
    severity: () => "high",
    title: (n) => `${formatCount(n)} ${plural(n, "customer is", "customers are")} waiting on a reply`,
    detail: "The customer wrote last and Trackpr is not answering for you.",
    fallbackHref: "/conversations",
    action: "Reply to the waiting customers",
  },
  {
    id: "committed_revenue_at_risk",
    match: (item) => item.tier === "committed_revenue_at_risk",
    kind: "risk",
    severity: () => "high",
    title: (n) => `${formatCount(n)} ${plural(n, "deal", "deals")} won but not yet paid`,
    detail: "Accepted estimates with no job, completed jobs not invoiced, or invoices past due.",
    fallbackHref: "/money",
    action: "Move the won work to cash",
  },
  {
    id: "leads_to_pursue",
    match: (item) => LEAD_CODES.has(item.reasonCode),
    kind: "risk",
    severity: () => "medium",
    title: (n) => `${formatCount(n)} ${plural(n, "lead", "leads")} to pursue`,
    detail: "Never contacted, qualified but not booked, or marked hot or high-value.",
    fallbackHref: "/leads",
    action: "Call the open leads",
  },
  {
    id: "appointments_need_attention",
    match: (item) => APPOINTMENT_CODES.has(item.reasonCode),
    kind: "risk",
    severity: () => "medium",
    title: (n) => `${formatCount(n)} ${plural(n, "appointment needs", "appointments need")} attention`,
    detail: "Overdue, unconfirmed, missed, cancelled without a rebooking, or visited with no estimate.",
    fallbackHref: "/schedule?view=list",
    action: "Sort out the appointments",
  },
  {
    id: "estimates_at_risk",
    match: (item) => ESTIMATE_CODES.has(item.reasonCode),
    kind: "risk",
    severity: () => "medium",
    title: (n) => `${formatCount(n)} ${plural(n, "estimate", "estimates")} at risk`,
    detail: "Sent and still undecided, or expired with no decision recorded.",
    fallbackHref: "/estimates",
    action: "Follow up on the open estimates",
  },
];

const sumKnown = (items: SalesItem[]) => items.reduce((total, item) => total + (item.value ?? 0), 0);

function groupFinding(group: Group, items: SalesItem[]): { finding: Finding; recommendation: Recommendation } {
  const severity = group.severity(items);
  const value = sumKnown(items);
  const evidence = items.slice(0, 3).map((item) => ({ label: item.name, value: item.value != null ? formatUsd(item.value) : "Value not recorded" }));
  if (value > 0) evidence.push({ label: "Known value", value: formatUsd(value) });
  const href = items.length === 1 ? items[0].actionHref : group.fallbackHref;
  return {
    finding: { id: group.id, kind: group.kind, basis: "fact", severity, confidence: "high", category: group.id, title: group.title(items.length), detail: group.detail, evidence, href, sources: [] },
    recommendation: {
      id: `${group.id}:act`,
      title: group.action,
      detail: items.length === 1 ? `Start with ${items[0].name}.` : `Start with ${items[0].name}, the top of today's priority order.`,
      actionKind: group.id === "leads_to_pursue" ? "call_customer" : "review",
      autonomy: "recommend",
      requiresApproval: false,
      priority: severity,
      confidence: "high",
      href,
      relatedFindingIds: [group.id],
    },
  };
}

export function analyzeSales(input: SalesInput): AgentOutput {
  const findings: Finding[] = [];
  const recommendations: Recommendation[] = [];

  const escalations = input.exceptions.filter((item) => item.reasonCode === "human_escalation");
  if (escalations.length > 0) {
    const { finding, recommendation } = groupFinding(
      {
        id: "human_escalation",
        match: () => true,
        kind: "risk",
        severity: () => "critical",
        title: (n) => `${formatCount(n)} ${plural(n, "conversation", "conversations")} handed to you`,
        detail: "Trackpr's AI stopped and asked for a person in these conversations.",
        fallbackHref: "/conversations",
        action: "Take over the escalated conversations",
      },
      escalations,
    );
    findings.push(finding);
    recommendations.push(recommendation);
  }

  // Only human-owned items count as sales work; Trackpr-handled items are summarized below.
  const remaining = input.attention.filter((item) => item.actor === "human");
  for (const group of ATTENTION_GROUPS) {
    const items = remaining.filter(group.match);
    if (items.length === 0) continue;
    for (const item of items) remaining.splice(remaining.indexOf(item), 1);
    const { finding, recommendation } = groupFinding(group, items);
    findings.push(finding);
    recommendations.push(recommendation);
  }
  if (remaining.length > 0) {
    const { finding } = groupFinding(
      {
        id: "other_attention",
        match: () => true,
        kind: "risk",
        severity: () => "low",
        title: (n) => `${formatCount(n)} other ${plural(n, "item needs", "items need")} a person`,
        detail: "Other items on today's attention list.",
        fallbackHref: "/today",
        action: "Review the rest of today's list",
      },
      remaining,
    );
    findings.push(finding);
  }

  // The single highest-value item anywhere in sales work - the "biggest opportunity" candidate.
  const valued = [...input.attention, ...input.opportunities].filter((item) => item.actor === "human" && item.value != null && item.value > 0);
  const top = valued.sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0];
  if (top) {
    findings.push({
      id: "highest_value_opportunity",
      kind: "opportunity",
      basis: "fact",
      severity: "medium",
      confidence: "high",
      category: "high_value",
      title: `Highest-value open item: ${top.name}`,
      detail: `${formatUsd(top.value ?? 0)} recorded on the open item.`,
      evidence: [{ label: "Value", value: formatUsd(top.value ?? 0) }],
      href: top.actionHref,
      sources: [],
    });
    recommendations.push({
      id: "highest_value_opportunity:act",
      title: `Prioritize ${top.name}`,
      detail: "The largest recorded value among the open sales items.",
      actionKind: "review",
      autonomy: "recommend",
      requiresApproval: false,
      priority: "medium",
      confidence: "high",
      href: top.actionHref,
      relatedFindingIds: ["highest_value_opportunity"],
    });
  }

  const growth = input.opportunities.filter((item) => item.actor === "human");
  if (growth.length > 0) {
    findings.push({
      id: "growth_opportunities",
      kind: "opportunity",
      basis: "fact",
      severity: "low",
      confidence: "high",
      category: "growth",
      title: `${formatCount(growth.length)} reactivation, review or referral ${plural(growth.length, "opportunity", "opportunities")}`,
      detail: "Past customers to reconnect with, and finished jobs to ask for a review or referral.",
      evidence: growth.slice(0, 3).map((item) => ({ label: item.name, value: item.reasonCode.replaceAll("_", " ") })),
      href: "/today?view=by-type#opportunities",
      sources: [],
    });
  }

  if (input.trackprHandling.length > 0) {
    const n = input.trackprHandling.length;
    findings.push({
      id: "trackpr_handling",
      kind: "handled",
      basis: "fact",
      severity: "info",
      confidence: "high",
      category: "trackpr_handling",
      title: `Trackpr is handling ${formatCount(n)} ${plural(n, "item", "items")}`,
      detail: "Replies and follow-ups Trackpr's own automation still has pending. They need nothing from you unless they stall.",
      evidence: input.trackprHandling.slice(0, 5).map((item) => ({ label: item.name, value: item.reasonCode.replaceAll("_", " ") })),
      href: "/today",
      sources: [],
    });
  }

  const humanCount = escalations.length + input.attention.filter((item) => item.actor === "human").length;
  return {
    status: findings.length === 0 ? "empty" : "ok",
    summary: humanCount === 0 ? "No sales work needs a person right now." : `${formatCount(humanCount)} sales ${plural(humanCount, "item needs", "items need")} a person.`,
    findings,
    recommendations,
    metadata: { humanItems: humanCount, opportunities: input.opportunities.length, trackprHandling: input.trackprHandling.length },
  };
}

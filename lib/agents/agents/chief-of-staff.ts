import {
  AgentResultSchema,
  confidenceRank,
  severityRank,
  type ActionKind,
  type AgentId,
  type AgentOutput,
  type AgentResult,
  type AgentRunStatus,
  type AutonomyLevel,
  type Confidence,
  type Evidence,
  type SourceRef,
  type FindingBasis,
  type FindingKind,
  type Severity,
} from "../contract";
import { AGENT_REGISTRY, SPECIALIST_AGENT_IDS } from "../registry";
import { formatCount, plural } from "../format";

/**
 * Chief of Staff. The only agent the operator talks to, and the only one
 * that reads other agents - through their validated AgentResults, nothing
 * else. It adds no data of its own: every line of the briefing is one of
 * the specialists' findings or recommendations, ranked, with its basis
 * (FACT / INFERENCE) and source agent kept. The one sentence it writes
 * itself - today's recommendation - is composed from those items and
 * labeled a RECOMMENDATION. Deterministic: no model call, so it cannot
 * invent anything.
 *
 * Ranking: severity first. A low-confidence item ranks one severity level
 * lower than it is labeled. At equal rank, system reliability comes before
 * sales, sales before revenue analytics (a broken automation silently drops
 * every follow-up, so it is fixed first), then facts before inferences,
 * then higher confidence, then the agent's own order.
 */

export type BriefingItem = {
  key: string;
  agent: AgentId;
  agentName: string;
  kind: FindingKind;
  /** The specialist's own topic, e.g. "missed_follow_up", "n8n_callback_failed". */
  category: string;
  basis: FindingBasis;
  severity: Severity;
  confidence: Confidence;
  title: string;
  detail: string;
  /** The specialist's own evidence and sources, carried through unchanged. */
  evidence: Evidence[];
  sources: SourceRef[];
  /** The Trackpr screen the finding is about. */
  href?: string;
};

export type BriefingAction = {
  key: string;
  agent: AgentId;
  agentName: string;
  title: string;
  detail: string;
  priority: Severity;
  confidence: Confidence;
  actionKind: ActionKind;
  autonomy: AutonomyLevel;
  requiresApproval: boolean;
  href?: string;
  relatedItemKeys: string[];
};

export type AgentStatusLine = { agent: AgentId; name: string; status: AgentRunStatus | "rejected"; summary: string; priority: Severity; findings: number };

export type ChiefOfStaffBriefing = {
  traceId: string;
  createdAt: string;
  /** TODAY'S RECOMMENDATION - always a recommendation, composed only from the items below. */
  recommendation: string;
  mostImportant: BriefingItem | null;
  biggestRisk: BriefingItem | null;
  biggestOpportunity: BriefingItem | null;
  salesPriority: BriefingItem | null;
  systemPriority: BriefingItem | null;
  /** WHAT MATTERS NOW - the few most important issues and opportunities, across every agent. */
  whatMattersNow: BriefingItem[];
  /** NEEDS YOUR ATTENTION - risks that need an operator decision or action, other than the system and revenue items their own sections hold. */
  needsAttention: BriefingItem[];
  /** TRACKPR IS HANDLING - work the automation already has in hand. */
  trackprHandling: BriefingItem[];
  /** REVENUE - pipeline leakage and revenue opportunities. */
  revenue: BriefingItem[];
  /** SYSTEM HEALTH - automation and system problems, then system status. */
  systemHealth: BriefingItem[];
  /** All opportunities, ranked (the source of biggestOpportunity). */
  opportunities: BriefingItem[];
  /** Recommended next actions a person can take now through existing screens. */
  nextActions: BriefingAction[];
  /** Proposed actions that must not happen without an explicit yes. Nothing here is executed. */
  approvals: BriefingAction[];
  agents: AgentStatusLine[];
};

export const SECTION_LIMITS = { whatMattersNow: 3, needsAttention: 6, trackprHandling: 5, revenue: 4, systemHealth: 3, opportunities: 5, nextActions: 4, approvals: 5 } as const;

/** Sales categories that are about money rather than responsiveness - they belong in Revenue too. */
const SALES_REVENUE_CATEGORIES: ReadonlySet<string> = new Set(["committed_revenue_at_risk", "estimates_at_risk", "high_value", "growth"]);

const DOMAIN_ORDER: AgentId[] = ["qa_health", "engineering", "sales", "trackpr_intelligence", "prospecting", "market_intelligence", "chief_of_staff"];
const DOMAIN_PHRASE: Partial<Record<AgentId, string>> = { qa_health: "system reliability", engineering: "system reliability", sales: "sales follow-through", trackpr_intelligence: "revenue leakage" };
const SYSTEM_AGENTS: ReadonlySet<AgentId> = new Set(["qa_health", "engineering"]);

/** Ranking severity: low confidence costs one level. */
export function effectiveSeverityRank(severity: Severity, confidence: Confidence): number {
  return Math.max(0, severityRank(severity) - (confidence === "low" ? 1 : 0));
}

type Ranked<T> = T & { order: number };

function compareItems(a: Ranked<BriefingItem>, b: Ranked<BriefingItem>): number {
  return (
    effectiveSeverityRank(b.severity, b.confidence) - effectiveSeverityRank(a.severity, a.confidence) ||
    DOMAIN_ORDER.indexOf(a.agent) - DOMAIN_ORDER.indexOf(b.agent) ||
    (a.basis === b.basis ? 0 : a.basis === "fact" ? -1 : 1) ||
    confidenceRank(b.confidence) - confidenceRank(a.confidence) ||
    a.order - b.order
  );
}

function compareActions(a: Ranked<BriefingAction>, b: Ranked<BriefingAction>): number {
  return (
    effectiveSeverityRank(b.priority, b.confidence) - effectiveSeverityRank(a.priority, a.confidence) ||
    DOMAIN_ORDER.indexOf(a.agent) - DOMAIN_ORDER.indexOf(b.agent) ||
    confidenceRank(b.confidence) - confidenceRank(a.confidence) ||
    a.order - b.order
  );
}

const strip = <T>(ranked: Ranked<T>): T => {
  const { order, ...rest } = ranked;
  void order;
  return rest as T;
};
const lowerFirst = (text: string) => (/^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text);
const trimPeriod = (text: string) => text.replace(/[.\s]+$/, "");

/** Validates what arrived. Anything that does not satisfy the contract is set aside and reported, never read. */
export function acceptResults(results: unknown[]): { accepted: AgentResult[]; rejected: number } {
  const accepted: AgentResult[] = [];
  let rejected = 0;
  for (const result of results) {
    const parsed = AgentResultSchema.safeParse(result);
    if (parsed.success && parsed.data.agent !== "chief_of_staff") accepted.push(parsed.data);
    else rejected += 1;
  }
  return { accepted, rejected };
}

export function buildBriefing(results: unknown[], context: { traceId: string; now: Date }): ChiefOfStaffBriefing {
  const { accepted, rejected } = acceptResults(results);
  let order = 0;
  const items: Ranked<BriefingItem>[] = [];
  const actions: Ranked<BriefingAction>[] = [];

  for (const result of accepted) {
    const agentName = AGENT_REGISTRY[result.agent].name;
    if (result.status === "failed") {
      // A failed agent is itself a system-health fact - never a silent gap.
      items.push({ key: `${result.agent}:failed`, agent: result.agent, agentName, kind: "risk", category: "agent_failed", basis: "fact", severity: "medium", confidence: "high", title: `${agentName} agent could not run`, detail: `${result.error ?? "Unknown error"}. Its area is not covered in this briefing.`, evidence: [], sources: [], order: order++ });
      continue;
    }
    for (const finding of result.findings) {
      items.push({ key: `${result.agent}:${finding.id}`, agent: result.agent, agentName, kind: finding.kind, category: finding.category, basis: finding.basis, severity: finding.severity, confidence: finding.confidence, title: finding.title, detail: finding.detail, evidence: finding.evidence, sources: finding.sources, href: finding.href, order: order++ });
    }
    for (const recommendation of result.recommendations) {
      actions.push({
        key: `${result.agent}:${recommendation.id}`,
        agent: result.agent,
        agentName,
        title: recommendation.title,
        detail: recommendation.detail,
        priority: recommendation.priority,
        confidence: recommendation.confidence,
        actionKind: recommendation.actionKind,
        autonomy: recommendation.autonomy,
        // Re-derived here too: the Chief of Staff never shows a sensitive action as safe, whatever arrived.
        requiresApproval: recommendation.requiresApproval || recommendation.autonomy === "requires_approval",
        href: recommendation.href,
        relatedItemKeys: recommendation.relatedFindingIds.map((id) => `${result.agent}:${id}`),
        order: order++,
      });
    }
  }
  if (rejected > 0) {
    items.push({ key: "chief_of_staff:rejected", agent: "chief_of_staff", agentName: AGENT_REGISTRY.chief_of_staff.name, kind: "risk", category: "invalid_result", basis: "fact", severity: "medium", confidence: "high", title: `${formatCount(rejected)} agent ${plural(rejected, "result", "results")} failed validation`, detail: "Set aside unread. The briefing covers only results that matched the agent contract.", evidence: [], sources: [], order: order++ });
  }

  items.sort(compareItems);
  actions.sort(compareActions);

  const top = (filter: (item: BriefingItem) => boolean, limit: number) => items.filter(filter).slice(0, limit).map(strip<BriefingItem>);
  const isSystem = (item: BriefingItem) => SYSTEM_AGENTS.has(item.agent) || item.key.endsWith(":failed") || item.agent === "chief_of_staff";

  const atLeastMedium = (item: BriefingItem) => effectiveSeverityRank(item.severity, item.confidence) >= severityRank("medium");
  const isSystemItem = (item: BriefingItem) => isSystem(item);
  const isRevenue = (item: BriefingItem) => item.kind !== "handled" && (item.agent === "trackpr_intelligence" || (item.agent === "sales" && SALES_REVENUE_CATEGORIES.has(item.category)));

  // Engineering's diagnoses are hypotheses about System health items, so they explain those rather than headline on their own.
  const whatMattersNow = top((item) => (item.kind === "risk" || item.kind === "opportunity") && item.agent !== "engineering" && atLeastMedium(item), SECTION_LIMITS.whatMattersNow);
  // Below the top priorities each item lives in exactly one section: System health owns system items, Revenue owns money items, and Needs your attention holds the rest of the operator's decisions.
  const needsAttention = top((item) => item.kind === "risk" && !isSystemItem(item) && !isRevenue(item) && atLeastMedium(item), SECTION_LIMITS.needsAttention);
  const trackprHandling = top((item) => item.kind === "handled", SECTION_LIMITS.trackprHandling);
  const revenue = top(isRevenue, SECTION_LIMITS.revenue);
  const opportunities = top((item) => item.kind === "opportunity", SECTION_LIMITS.opportunities);
  const systemRisks = items.filter((item) => isSystemItem(item) && item.kind === "risk");
  const systemStatus = items.filter((item) => SYSTEM_AGENTS.has(item.agent) && item.kind === "status");
  const systemHealth = [...systemRisks, ...systemStatus].slice(0, SECTION_LIMITS.systemHealth).map(strip<BriefingItem>);

  const biggestRisk = top((item) => item.kind === "risk", 1)[0] ?? null;
  const biggestOpportunity = opportunities[0] ?? null;
  const salesPriority = top((item) => item.agent === "sales" && (item.kind === "risk" || item.kind === "opportunity"), 1)[0] ?? null;
  const systemPriority = systemRisks[0] ? strip(systemRisks[0]) : null;
  const mostImportant =
    biggestRisk && (!biggestOpportunity || effectiveSeverityRank(biggestRisk.severity, biggestRisk.confidence) >= effectiveSeverityRank(biggestOpportunity.severity, biggestOpportunity.confidence))
      ? biggestRisk
      : biggestOpportunity;

  const approvals = actions.filter((a) => a.requiresApproval).slice(0, SECTION_LIMITS.approvals).map(strip<BriefingAction>);
  const nextActions = actions.filter((a) => !a.requiresApproval).slice(0, SECTION_LIMITS.nextActions).map(strip<BriefingAction>);

  const agents: AgentStatusLine[] = SPECIALIST_AGENT_IDS.map((id) => {
    const result = accepted.find((r) => r.agent === id);
    return result
      ? { agent: id, name: AGENT_REGISTRY[id].name, status: result.status, summary: result.summary, priority: result.priority, findings: result.findings.length }
      : { agent: id, name: AGENT_REGISTRY[id].name, status: "rejected", summary: "No valid result arrived.", priority: "info", findings: 0 };
  });

  const recommendation = composeRecommendation({ accepted, items: items.map(strip<BriefingItem>), mostImportant, nextActions, approvals });

  return { traceId: context.traceId, createdAt: context.now.toISOString(), recommendation, mostImportant, biggestRisk, biggestOpportunity, salesPriority, systemPriority, whatMattersNow, needsAttention, trackprHandling, revenue, systemHealth, opportunities, nextActions, approvals, agents };
}

function composeRecommendation(input: { accepted: AgentResult[]; items: BriefingItem[]; mostImportant: BriefingItem | null; nextActions: BriefingAction[]; approvals: BriefingAction[] }): string {
  const organizationAgents = input.accepted.filter((r) => AGENT_REGISTRY[r.agent].scope === "organization");
  if (organizationAgents.length === 0 || organizationAgents.every((r) => r.status === "failed")) {
    return "I can't brief you yet: none of the business or system agents could read their data. Start with system health.";
  }

  const first = input.mostImportant;
  if (!first) return "Nothing needs you right now. No risks or opportunities stand out in what the agents could read.";

  const sentences: string[] = [];
  if (first.kind === "risk") {
    const domain = DOMAIN_PHRASE[first.agent];
    sentences.push(domain ? `Your biggest immediate issue is ${domain}: ${lowerFirst(trimPeriod(first.title))}.` : `Your biggest immediate issue: ${lowerFirst(trimPeriod(first.title))}.`);
    const second = input.items.find((item) => item.kind === "risk" && item.agent !== first.agent && !(SYSTEM_AGENTS.has(item.agent) && SYSTEM_AGENTS.has(first.agent)) && effectiveSeverityRank(item.severity, item.confidence) >= severityRank("medium"));
    if (second) sentences.push(`${second.agentName} also reports ${lowerFirst(trimPeriod(second.title))}.`);
  } else {
    sentences.push(`Nothing is on fire. Your biggest opportunity: ${lowerFirst(trimPeriod(first.title))}.`);
  }

  // Lead with the action tied to the most important item, then the next one in rank order.
  const [a1, a2] = [...input.nextActions.filter((a) => a.relatedItemKeys.includes(first.key)), ...input.nextActions.filter((a) => !a.relatedItemKeys.includes(first.key))];
  if (a1) sentences.push(`I recommend you ${lowerFirst(trimPeriod(a1.title))} first${a2 ? `, then ${lowerFirst(trimPeriod(a2.title))}` : ""}.`);
  if (input.approvals.length > 0) sentences.push(`${formatCount(input.approvals.length)} proposed ${plural(input.approvals.length, "action waits", "actions wait")} for your approval; nothing runs on its own.`);
  return sentences.join(" ");
}

/** The Chief of Staff's own AgentResult body - the briefing's items and actions, in rank order, so its run is traceable like any other. */
export function chiefOfStaffOutput(briefing: ChiefOfStaffBriefing): AgentOutput {
  const seen = new Set<string>();
  const items = [briefing.mostImportant, ...briefing.whatMattersNow, ...briefing.needsAttention, ...briefing.trackprHandling, ...briefing.revenue, ...briefing.systemHealth, ...briefing.opportunities].filter((item): item is BriefingItem => item !== null && !seen.has(item.key) && (seen.add(item.key), true));
  return {
    status: "ok",
    summary: briefing.recommendation.slice(0, 1000),
    findings: items.map((item) => ({ id: item.key.slice(0, 120), kind: item.kind, basis: item.basis, severity: item.severity, confidence: item.confidence, category: item.category, title: item.title, detail: item.detail, href: item.href, evidence: item.evidence, sources: item.sources })),
    recommendations: [...briefing.nextActions, ...briefing.approvals].map((action) => ({
      id: action.key.slice(0, 120),
      title: action.title,
      detail: action.detail,
      actionKind: action.actionKind,
      autonomy: action.autonomy,
      requiresApproval: action.requiresApproval,
      priority: action.priority,
      confidence: action.confidence,
      href: action.href,
      relatedFindingIds: action.relatedItemKeys.filter((key) => seen.has(key)).map((key) => key.slice(0, 120)),
    })),
    metadata: { agentsReporting: briefing.agents.filter((a) => a.status === "ok" || a.status === "empty").length, approvalsPending: briefing.approvals.length },
  };
}

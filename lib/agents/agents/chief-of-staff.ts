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
  basis: FindingBasis;
  severity: Severity;
  confidence: Confidence;
  title: string;
  detail: string;
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
  needsAttention: BriefingItem[];
  opportunities: BriefingItem[];
  systemHealth: BriefingItem[];
  sales: BriefingItem[];
  market: BriefingItem[];
  /** Recommended next actions a person can take now through existing screens. */
  nextActions: BriefingAction[];
  /** Proposed actions that must not happen without an explicit yes. Nothing here is executed. */
  approvals: BriefingAction[];
  agents: AgentStatusLine[];
};

export const SECTION_LIMITS = { needsAttention: 3, opportunities: 3, systemHealth: 2, sales: 3, market: 2, nextActions: 3, approvals: 5 } as const;

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
      items.push({ key: `${result.agent}:failed`, agent: result.agent, agentName, kind: "risk", basis: "fact", severity: "medium", confidence: "high", title: `${agentName} agent could not run`, detail: `${result.error ?? "Unknown error"}. Its area is not covered in this briefing.`, order: order++ });
      continue;
    }
    for (const finding of result.findings) {
      items.push({ key: `${result.agent}:${finding.id}`, agent: result.agent, agentName, kind: finding.kind, basis: finding.basis, severity: finding.severity, confidence: finding.confidence, title: finding.title, detail: finding.detail, href: finding.href, order: order++ });
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
    items.push({ key: "chief_of_staff:rejected", agent: "chief_of_staff", agentName: AGENT_REGISTRY.chief_of_staff.name, kind: "risk", basis: "fact", severity: "medium", confidence: "high", title: `${formatCount(rejected)} agent ${plural(rejected, "result", "results")} failed validation`, detail: "Set aside unread. The briefing covers only results that matched the agent contract.", order: order++ });
  }

  items.sort(compareItems);
  actions.sort(compareActions);

  const top = (filter: (item: BriefingItem) => boolean, limit: number) => items.filter(filter).slice(0, limit).map(strip<BriefingItem>);
  const isSystem = (item: BriefingItem) => SYSTEM_AGENTS.has(item.agent) || item.key.endsWith(":failed") || item.agent === "chief_of_staff";

  const needsAttention = top((item) => item.kind === "risk" && item.agent !== "engineering" && effectiveSeverityRank(item.severity, item.confidence) >= severityRank("medium"), SECTION_LIMITS.needsAttention);
  const opportunities = top((item) => item.kind === "opportunity", SECTION_LIMITS.opportunities);
  const systemRisks = items.filter((item) => isSystem(item) && item.kind === "risk");
  const systemHealth = (systemRisks.length > 0 ? systemRisks : items.filter((item) => item.agent === "qa_health")).slice(0, SECTION_LIMITS.systemHealth).map(strip<BriefingItem>);
  const salesItems = items.filter((item) => item.agent === "sales");
  const sales = [...salesItems.filter((i) => i.kind !== "status"), ...salesItems.filter((i) => i.kind === "status")].slice(0, SECTION_LIMITS.sales).map(strip<BriefingItem>);
  const market = top((item) => item.agent === "market_intelligence", SECTION_LIMITS.market);

  const biggestRisk = top((item) => item.kind === "risk", 1)[0] ?? null;
  const biggestOpportunity = opportunities[0] ?? null;
  const salesPriority = sales.find((item) => item.kind !== "status") ?? null;
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

  return { traceId: context.traceId, createdAt: context.now.toISOString(), recommendation, mostImportant, biggestRisk, biggestOpportunity, salesPriority, systemPriority, needsAttention, opportunities, systemHealth, sales, market, nextActions, approvals, agents };
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
  const items = [briefing.mostImportant, ...briefing.needsAttention, ...briefing.opportunities, ...briefing.systemHealth, ...briefing.sales, ...briefing.market].filter((item): item is BriefingItem => item !== null && !seen.has(item.key) && (seen.add(item.key), true));
  return {
    status: "ok",
    summary: briefing.recommendation.slice(0, 1000),
    findings: items.map((item) => ({ id: item.key.slice(0, 120), kind: item.kind, basis: item.basis, severity: item.severity, confidence: item.confidence, category: item.agent, title: item.title, detail: item.detail, href: item.href, evidence: [], sources: [] })),
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

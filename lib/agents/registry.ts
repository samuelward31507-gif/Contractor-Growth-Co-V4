import type { AgentId, AutonomyLevel } from "./contract";
import { PHASE_1_MAX_AUTONOMY } from "./permissions";

/**
 * Agent Operating Layer, Phase 1: the seven agents, declared once.
 *
 * Every data source an agent may read is named here and maps to an existing
 * read in this codebase (./sources.ts) - nothing new is queried, and every
 * organization read runs on the request's own RLS-scoped Supabase client.
 * Agents themselves never receive a database client: they get a typed,
 * already-loaded input and return structured output (./runtime.ts).
 */

export const DATA_SOURCES = {
  /** lib/decisions/assemble.ts over getDashboardSqlData + getPrioritizedOpportunities + getDecisionContext - exactly what Today renders. */
  decisions: "decisions",
  /** lib/bi/metrics.ts getBusinessMetricsSnapshot, last 30 days in the organization's timezone. */
  businessMetrics: "business_metrics",
  /** lib/automation-health/health.ts getOrganizationHealth. */
  organizationHealth: "organization_health",
  /** lib/automation-health/queries.ts listIncidents (open and acknowledged). */
  automationIncidents: "automation_incidents",
  /** lib/settings/queries.ts getAutomationMode. */
  automationMode: "automation_mode",
  /** Operator-supplied research notes. No source is connected in Phase 1. */
  prospectResearch: "prospect_research",
  /** Operator-supplied, sourced market notes. No source is connected in Phase 1. */
  marketResearch: "market_research",
  /** The other agents' AgentResults - the Chief of Staff's only input. */
  agentResults: "agent_results",
} as const;
export type DataSource = (typeof DATA_SOURCES)[keyof typeof DATA_SOURCES];

export type AgentScope = "organization" | "platform";

export type AgentDefinition = {
  id: AgentId;
  name: string;
  description: string;
  purpose: string;
  /** "organization": reads one organization's data under RLS. "platform": about Trackpr itself; reads no customer data. */
  scope: AgentScope;
  allowedDataSources: readonly DataSource[];
  /** The most autonomy this agent's recommendations may claim. Phase 1: never above "recommend". */
  maxAutonomy: AutonomyLevel;
};

export const AGENT_REGISTRY: Record<AgentId, AgentDefinition> = {
  chief_of_staff: {
    id: "chief_of_staff",
    name: "Chief of Staff",
    description: "Turns every other agent's findings into one short operating briefing.",
    purpose: "Answer what happened, what matters, what is broken, what opportunity exists, and what to do next - using only what the other agents found.",
    scope: "organization",
    allowedDataSources: [DATA_SOURCES.agentResults],
    maxAutonomy: PHASE_1_MAX_AUTONOMY,
  },
  sales: {
    id: "sales",
    name: "Sales",
    description: "Leads, replies, appointments, estimates and jobs that need a person.",
    purpose: "Find stale leads, missed follow-ups, revenue at risk and the highest-value work to do next.",
    scope: "organization",
    allowedDataSources: [DATA_SOURCES.decisions],
    maxAutonomy: PHASE_1_MAX_AUTONOMY,
  },
  prospecting: {
    id: "prospecting",
    name: "Prospecting",
    description: "Ideal prospects for Trackpr's own growth.",
    purpose: "Turn research inputs into prospect fit, likely pain, reason to contact and a suggested angle. Never contacts anyone.",
    scope: "platform",
    allowedDataSources: [DATA_SOURCES.prospectResearch],
    maxAutonomy: PHASE_1_MAX_AUTONOMY,
  },
  trackpr_intelligence: {
    id: "trackpr_intelligence",
    name: "Trackpr Intelligence",
    description: "Where the revenue lifecycle is losing money.",
    purpose: "Read the lead-to-payment lifecycle and name the stages where money is being lost.",
    scope: "organization",
    allowedDataSources: [DATA_SOURCES.businessMetrics],
    maxAutonomy: PHASE_1_MAX_AUTONOMY,
  },
  qa_health: {
    id: "qa_health",
    name: "QA / Health",
    description: "Whether Trackpr's automation is working.",
    purpose: "Classify automation incidents, stuck work and configuration problems, and recommend the next step. Never changes production.",
    scope: "organization",
    allowedDataSources: [DATA_SOURCES.organizationHealth, DATA_SOURCES.automationIncidents, DATA_SOURCES.automationMode, DATA_SOURCES.decisions],
    maxAutonomy: PHASE_1_MAX_AUTONOMY,
  },
  market_intelligence: {
    id: "market_intelligence",
    name: "Market Intelligence",
    description: "What is changing in the markets Trackpr serves.",
    purpose: "Keep verified information, inference and opinion apart for contractors, peptide businesses, gyms and clinics.",
    scope: "platform",
    allowedDataSources: [DATA_SOURCES.marketResearch],
    maxAutonomy: PHASE_1_MAX_AUTONOMY,
  },
  engineering: {
    id: "engineering",
    name: "Engineering",
    description: "Likely causes, affected code and safe next steps for what QA sees.",
    purpose: "Map incidents to the code that owns them, propose investigation and tests, and give rollback guidance. Read and analysis only.",
    scope: "organization",
    allowedDataSources: [DATA_SOURCES.automationIncidents, DATA_SOURCES.organizationHealth],
    maxAutonomy: PHASE_1_MAX_AUTONOMY,
  },
};

/** The specialists, in the order their results are shown and ties are broken. The Chief of Staff runs after them. */
export const SPECIALIST_AGENT_IDS = ["qa_health", "sales", "trackpr_intelligence", "engineering", "market_intelligence", "prospecting"] as const satisfies readonly AgentId[];
export type SpecialistAgentId = (typeof SPECIALIST_AGENT_IDS)[number];

import type { AgentResult } from "./contract";
import { AGENT_REGISTRY } from "./registry";
import { runAgent, type AgentRunContext, type SourceRead } from "./runtime";
import { analyzeSales, type SalesInput } from "./agents/sales";
import { analyzeTrackprIntelligence, type TrackprIntelligenceInput } from "./agents/trackpr-intelligence";
import { analyzeQaHealth, type QaHealthInput } from "./agents/qa-health";
import { analyzeEngineering, type EngineeringInput } from "./agents/engineering";
import { analyzeMarketIntelligence, type MarketSignal } from "./agents/market-intelligence";
import { analyzeProspecting, type ProspectResearchInput } from "./agents/prospecting";
import { buildBriefing, chiefOfStaffOutput, type ChiefOfStaffBriefing } from "./agents/chief-of-staff";

/**
 * Agent Operating Layer, Phase 1: one run of the whole layer.
 *
 *   operator -> Chief of Staff -> Sales / Prospecting / Trackpr Intelligence
 *                                 / QA / Market Intelligence / Engineering
 *
 * The six specialists run in parallel, each on its own already-loaded input
 * (./sources.ts), under one trace id. They never call each other. The Chief
 * of Staff then reads their AgentResults - and only those - and produces the
 * briefing. Pure apart from the clock: no I/O, nothing sent, nothing
 * written. Persistence, if enabled, is the caller's separate step
 * (./persistence.ts).
 */

export type SpecialistInputs = {
  sales: SourceRead<SalesInput>;
  trackpr_intelligence: SourceRead<TrackprIntelligenceInput>;
  qa_health: SourceRead<QaHealthInput>;
  engineering: SourceRead<EngineeringInput>;
  market_intelligence: SourceRead<MarketSignal[]>;
  prospecting: SourceRead<ProspectResearchInput[]>;
};

export type OperatingLayerRun = {
  traceId: string;
  /** The six specialist results, in SPECIALIST_AGENT_IDS order. */
  results: AgentResult[];
  chiefOfStaff: AgentResult;
  briefing: ChiefOfStaffBriefing;
};

export async function runOperatingLayer(inputs: SpecialistInputs, options: Partial<AgentRunContext> = {}): Promise<OperatingLayerRun> {
  const context: AgentRunContext = { ...options, traceId: options.traceId ?? crypto.randomUUID(), now: options.now ?? new Date() };

  const results = await Promise.all([
    runAgent(AGENT_REGISTRY.qa_health, analyzeQaHealth, inputs.qa_health, context),
    runAgent(AGENT_REGISTRY.sales, analyzeSales, inputs.sales, context),
    runAgent(AGENT_REGISTRY.trackpr_intelligence, analyzeTrackprIntelligence, inputs.trackpr_intelligence, context),
    runAgent(AGENT_REGISTRY.engineering, analyzeEngineering, inputs.engineering, context),
    runAgent(AGENT_REGISTRY.market_intelligence, analyzeMarketIntelligence, inputs.market_intelligence, context),
    runAgent(AGENT_REGISTRY.prospecting, analyzeProspecting, inputs.prospecting, context),
  ]);

  const briefing = buildBriefing(results, { traceId: context.traceId, now: context.now });
  const chiefOfStaff = await runAgent(AGENT_REGISTRY.chief_of_staff, () => chiefOfStaffOutput(briefing), { ok: true, data: null }, context);

  return { traceId: context.traceId, results, chiefOfStaff, briefing };
}

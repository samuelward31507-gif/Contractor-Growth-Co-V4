import { z } from "zod";
import { HttpsUrlSchema, type AgentOutput, type Finding, type Recommendation } from "../contract";
import { formatCount, plural } from "../format";

/**
 * Market Intelligence agent - the markets Trackpr serves, never customer
 * data. Phase 1 is the interface: market notes a person supplies, each
 * labeled as VERIFIED (must cite an https source), INFERENCE or OPINION.
 * Verified notes become fact findings, inferences become inference
 * findings, opinions become recommendations - never mixed. The agent
 * fetches and scrapes nothing; with no notes connected it reports
 * "not configured" rather than producing generic market commentary.
 */

export const MARKETS = ["contractor", "peptide", "gym", "clinic", "competitors", "pricing", "ai_adoption"] as const;

export const MarketSignalSchema = z
  .object({
    market: z.enum(MARKETS),
    statement: z.string().trim().min(1).max(500),
    kind: z.enum(["verified", "inference", "opinion"]),
    source: z.object({ title: z.string().trim().min(1).max(200), url: HttpsUrlSchema }).strict().optional(),
    observedAt: z.iso.date(),
  })
  .strict()
  .refine((signal) => signal.kind !== "verified" || signal.source !== undefined, { message: "a verified signal must cite a source", path: ["source"] });
export type MarketSignal = z.input<typeof MarketSignalSchema>;

const MARKET_LABEL: Record<(typeof MARKETS)[number], string> = {
  contractor: "Contractors",
  peptide: "Peptide",
  gym: "Gyms",
  clinic: "Clinics",
  competitors: "Competitors",
  pricing: "Pricing",
  ai_adoption: "AI adoption",
};

export function analyzeMarketIntelligence(signals: MarketSignal[]): AgentOutput {
  if (signals.length === 0) {
    return {
      status: "not_configured",
      summary: "No market sources connected yet. Market Intelligence is interface-only in this phase.",
      findings: [],
      recommendations: [],
      metadata: { signals: 0 },
    };
  }

  const findings: Finding[] = [];
  const recommendations: Recommendation[] = [];
  let rejected = 0;
  signals.forEach((raw, index) => {
    const parsed = MarketSignalSchema.safeParse(raw);
    if (!parsed.success) {
      rejected += 1;
      return;
    }
    const signal = parsed.data;
    const id = `market:${index}`;
    const title = signal.statement.slice(0, 200);
    const provenance = signal.source ? `${MARKET_LABEL[signal.market]} · recorded ${signal.observedAt} · source: ${signal.source.title}.` : `${MARKET_LABEL[signal.market]} · recorded ${signal.observedAt} · no source - verify before relying on it.`;
    if (signal.kind === "opinion") {
      recommendations.push({ id, title, detail: `Opinion. ${provenance}`, actionKind: "review", autonomy: "recommend", requiresApproval: false, priority: "info", confidence: "low", relatedFindingIds: [] });
      return;
    }
    findings.push({
      id,
      kind: "status",
      basis: signal.kind === "verified" ? "fact" : "inference",
      severity: "info",
      confidence: signal.kind === "verified" ? "high" : "low",
      category: `market_${signal.market}`,
      title,
      detail: provenance,
      evidence: [{ label: "Observed", value: signal.observedAt }],
      sources: signal.source ? [signal.source] : [],
    });
  });

  return {
    status: findings.length + recommendations.length === 0 ? "empty" : "ok",
    summary: `${formatCount(findings.length + recommendations.length)} market ${plural(findings.length + recommendations.length, "note", "notes")}${rejected > 0 ? `, ${formatCount(rejected)} rejected (a verified note needs a source)` : ""}.`,
    findings,
    recommendations,
    metadata: { signals: signals.length, rejected },
  };
}

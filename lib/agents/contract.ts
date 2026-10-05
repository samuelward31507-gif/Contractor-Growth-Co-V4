import { z } from "zod";

/**
 * Agent Operating Layer, Phase 1: the one contract every Trackpr agent
 * speaks. An agent never returns prose - it returns an AgentOutput (findings
 * and recommendations), which the runtime (./runtime.ts) validates against
 * the schemas below, stamps with a run id, trace id and timestamps, and
 * passes through the approval policy (./permissions.ts) to produce an
 * AgentResult. The Chief of Staff (./agents/chief-of-staff.ts) consumes
 * AgentResults only - never another agent's internals.
 *
 * Vocabulary reused rather than invented where the codebase already has it:
 * severity extends the incident severities (lib/automation-health/types.ts)
 * to the five levels the operating console needs; confidence uses the same
 * high/medium/low scale as the AI observations (lib/bi/insights.ts).
 */

export const AGENT_IDS = ["chief_of_staff", "sales", "prospecting", "trackpr_intelligence", "qa_health", "market_intelligence", "engineering"] as const;
export const AgentIdSchema = z.enum(AGENT_IDS);
export type AgentId = z.infer<typeof AgentIdSchema>;

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export const SeveritySchema = z.enum(SEVERITIES);
export type Severity = z.infer<typeof SeveritySchema>;

export const CONFIDENCES = ["high", "medium", "low"] as const;
export const ConfidenceSchema = z.enum(CONFIDENCES);
export type Confidence = z.infer<typeof ConfidenceSchema>;

/**
 * What a finding is. A FACT is read straight from Trackpr's own data (a
 * count, a status, a stored record). An INFERENCE is a conclusion drawn from
 * facts (a likely root cause, a likely fit). Recommendations are their own
 * type below - they are never mixed into findings.
 */
export const FindingBasisSchema = z.enum(["fact", "inference"]);
export type FindingBasis = z.infer<typeof FindingBasisSchema>;

/**
 * Whether a finding is a problem, an upside, a plain status line, or work
 * Trackpr's own automation is already handling (no operator action yet).
 * Decides which briefing section it can appear in.
 */
export const FindingKindSchema = z.enum(["risk", "opportunity", "status", "handled"]);
export type FindingKind = z.infer<typeof FindingKindSchema>;

/**
 * The approval model (Phase 5). Ordered least to most autonomous.
 *  - read_only:         looks at data, proposes nothing.
 *  - recommend:         proposes something a person does through the
 *                       existing, already-gated Trackpr UI.
 *  - requires_approval: proposes an action that must not happen without an
 *                       explicit human yes (see SENSITIVE_ACTION_KINDS).
 *  - autonomous:        acts on its own. Not granted to any agent in Phase 1;
 *                       the runtime downgrades any claim of it.
 */
export const AUTONOMY_LEVELS = ["read_only", "recommend", "requires_approval", "autonomous"] as const;
export const AutonomyLevelSchema = z.enum(AUTONOMY_LEVELS);
export type AutonomyLevel = z.infer<typeof AutonomyLevelSchema>;

export const ACTION_KINDS = [
  // A person looks at something in the app. Never changes anything by itself.
  "review",
  "investigate",
  "call_customer",
  // Anything below changes the world and always requires approval.
  "send_customer_message",
  "send_email",
  "contact_prospect",
  "change_production",
  "deploy_code",
  "modify_billing",
  "delete_data",
  "change_credentials",
  "change_integrations",
  "destructive_operation",
] as const;
export const ActionKindSchema = z.enum(ACTION_KINDS);
export type ActionKind = z.infer<typeof ActionKindSchema>;

/** In-app link only: a path on this site, never an external URL or a javascript:/data: scheme. */
const InAppHrefSchema = z
  .string()
  .max(500)
  .regex(/^\/(?!\/)[^\s]*$/, "must be an in-app path starting with a single /");

/** External sources (market and prospect research) must be https. */
export const HttpsUrlSchema = z
  .string()
  .max(1000)
  .refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an https URL");

const ShortText = z.string().trim().min(1).max(200);
const LongText = z.string().trim().min(1).max(1000);

export const EvidenceSchema = z.object({ label: ShortText, value: z.string().trim().min(1).max(300) }).strict();
export type Evidence = z.infer<typeof EvidenceSchema>;

export const SourceRefSchema = z.object({ title: ShortText, url: HttpsUrlSchema }).strict();
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const FindingSchema = z
  .object({
    /** Stable within one agent's output - recommendations point at it. */
    id: z.string().min(1).max(120),
    kind: FindingKindSchema,
    basis: FindingBasisSchema,
    severity: SeveritySchema,
    confidence: ConfidenceSchema,
    /** Short machine-readable topic, e.g. "missed_follow_up", "n8n_callback_failed". */
    category: z.string().min(1).max(80),
    title: ShortText,
    detail: LongText,
    evidence: z.array(EvidenceSchema).max(10).default([]),
    href: InAppHrefSchema.optional(),
    sources: z.array(SourceRefSchema).max(10).default([]),
  })
  .strict();
export type Finding = z.infer<typeof FindingSchema>;

export const RecommendationSchema = z
  .object({
    id: z.string().min(1).max(120),
    title: ShortText,
    detail: LongText,
    actionKind: ActionKindSchema,
    /** What the action needs. The runtime raises it for sensitive actions and lowers any claim above the agent's ceiling. */
    autonomy: AutonomyLevelSchema,
    requiresApproval: z.boolean(),
    priority: SeveritySchema,
    confidence: ConfidenceSchema,
    href: InAppHrefSchema.optional(),
    relatedFindingIds: z.array(z.string().min(1).max(120)).max(20).default([]),
  })
  .strict();
export type Recommendation = z.infer<typeof RecommendationSchema>;

/** Plain scalar metadata only - never nested objects, so nothing large or sensitive rides along by accident. */
export const MetadataSchema = z.record(z.string().max(60), z.union([z.string().max(300), z.number(), z.boolean(), z.null()]));

export const AgentRunStatusSchema = z.enum(["ok", "empty", "not_configured", "failed"]);
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

/** What an agent's analyze() returns. The runtime fills in everything else. */
export const AgentOutputSchema = z
  .object({
    status: z.enum(["ok", "empty", "not_configured"]).default("ok"),
    summary: LongText,
    findings: z.array(FindingSchema).max(50).default([]),
    recommendations: z.array(RecommendationSchema).max(30).default([]),
    metadata: MetadataSchema.default({}),
  })
  .strict();
export type AgentOutput = z.input<typeof AgentOutputSchema>;
export type ParsedAgentOutput = z.output<typeof AgentOutputSchema>;

export const AgentResultSchema = z
  .object({
    agent: AgentIdSchema,
    runId: z.uuid(),
    traceId: z.uuid(),
    status: AgentRunStatusSchema,
    summary: LongText,
    findings: z.array(FindingSchema),
    recommendations: z.array(RecommendationSchema),
    /** The highest severity among the findings and recommendations; "info" when there are none. */
    priority: SeveritySchema,
    /** The lowest confidence among the findings; see overallConfidence(). */
    confidence: ConfidenceSchema,
    /** True when any recommendation needs a human yes. */
    requiresApproval: z.boolean(),
    dataSources: z.array(z.string().min(1).max(80)),
    /** A safe, generic message - never a stack trace, query text or raw provider error. */
    error: z.string().max(300).nullable(),
    startedAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
    durationMs: z.number().int().nonnegative(),
    metadata: MetadataSchema,
  })
  .strict();
export type AgentResult = z.infer<typeof AgentResultSchema>;

// ---------------------------------------------------------------------------
// Ordering helpers shared by the runtime and the Chief of Staff
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
const CONFIDENCE_RANK: Record<Confidence, number> = { high: 2, medium: 1, low: 0 };

export const severityRank = (severity: Severity) => SEVERITY_RANK[severity];
export const confidenceRank = (confidence: Confidence) => CONFIDENCE_RANK[confidence];

export function highestSeverity(severities: Severity[]): Severity {
  return severities.reduce<Severity>((best, next) => (SEVERITY_RANK[next] > SEVERITY_RANK[best] ? next : best), "info");
}

export function lowestConfidence(confidences: Confidence[], fallback: Confidence): Confidence {
  if (confidences.length === 0) return fallback;
  return confidences.reduce((worst, next) => (CONFIDENCE_RANK[next] < CONFIDENCE_RANK[worst] ? next : worst));
}

/** One confidence step down - used when an agent's inputs were only partly readable. */
export function lowerConfidence(confidence: Confidence): Confidence {
  return confidence === "high" ? "medium" : "low";
}

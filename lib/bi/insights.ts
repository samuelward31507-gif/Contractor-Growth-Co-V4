import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordAiCostEventForInteraction, resolveTrustedAiProvider, isValidTokenCount } from "@/lib/costs/ai-cost-events";
import type {
  BusinessMetricsSnapshot,
  BusinessMetricsComparisons,
  BiLeadMetrics,
  BiPipelineMetrics,
  BiEstimateMetrics,
  BiJobMetrics,
  BiAppointmentMetrics,
  BiCommunicationMetrics,
  BiAutomationMetrics,
  BiAiMetrics,
  BiFollowUpMetrics,
  BiDataQuality,
  ResolvedDateRange,
} from "./types";

/**
 * Phase 5.3 - AI Business Insights layer. This is a pure TRANSFORMATION on
 * top of Phase 5.2's BusinessMetricsSnapshot (lib/bi/metrics.ts, frozen -
 * not modified here) and Phase 5.1 (lib/bi/types.ts / lib/bi/queries.ts,
 * also frozen). It never queries Supabase for anything the deterministic BI
 * layer hasn't already computed, and it never asks Claude to calculate a
 * count/sum/rate itself:
 *
 *   Supabase data -> Phase 5.1 BI queries -> Phase 5.2 BusinessMetricsSnapshot
 *       -> Phase 5.3 AI insight layer (this file) -> structured insights
 *
 * Architecture finding from inspection (see the Phase 5.3 report): this
 * codebase has NEVER called the Claude/Anthropic API directly from its own
 * backend before this phase - every existing AI generation happens inside
 * n8n workflows, using n8n's own "Gateway credits" (not a Trackpr-held API
 * key), and Trackpr's backend only ever RECEIVES already-drafted AI output
 * via the n8n callback route (app/api/automation/n8n-callback). There is
 * therefore no existing "provider pattern" to reuse for a direct call - this
 * file is the first one, built minimally with the official @anthropic-ai/sdk
 * (the same reasoning that led to using the official `twilio` package for
 * the SMS provider rather than raw HTTP - see lib/automation/sms.ts).
 *
 * Mirrors two established conventions elsewhere in this codebase:
 *  - The unconfigured-provider fail-closed pattern (lib/automation/sms.ts,
 *    lib/automation/n8n.ts): if ANTHROPIC_API_KEY is unset, this returns a
 *    typed failure without ever attempting a network call - never pretends a
 *    call happened. Confirmed unset in this dev environment, which is also
 *    why the test suite for this phase never reaches a real API call.
 *  - The injectable test-seam pattern (lib/messaging/outbound.ts's
 *    `sendSmsFn`): `callClaudeFn` lets a test supply a deterministic fake
 *    instead of hitting the real API, so the validation/business logic can
 *    be tested without spending API credits or risking a real call.
 *
 * Phase 5D-2 (telemetry persistence only - no change to the above): the real
 * Anthropic response's `usage` (input_tokens/output_tokens) is now captured
 * and persisted alongside the existing business_insights ai_interactions
 * row, and an ai_cost_events row is opportunistically recorded from it (see
 * lib/costs/ai-cost-events.ts). This never affects the model call itself,
 * the prompt, response parsing, or the returned BusinessInsightsReport - a
 * `callClaudeFn`-injected test double still has no usage to report (real
 * usage only exists on a real API response), which correctly persists as
 * unknown, exactly like any other missing/malformed usage case.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const INSIGHT_TYPES = [
  "lead_volume",
  "pipeline",
  "estimates",
  "appointments",
  "jobs",
  "communication",
  "follow_up",
  "automation",
  "data_quality",
] as const;
export type InsightType = (typeof INSIGHT_TYPES)[number];

export const INSIGHT_SEVERITIES = ["info", "attention"] as const;
export type InsightSeverity = (typeof INSIGHT_SEVERITIES)[number];

export const INSIGHT_CONFIDENCES = ["high", "medium", "low"] as const;
export type InsightConfidence = (typeof INSIGHT_CONFIDENCES)[number];

export const MAX_INSIGHTS = 8;
export const TARGET_INSIGHTS_MIN = 3;
export const TARGET_INSIGHTS_MAX = 6;

export type InsightEvidence = {
  metric: string;
  value: string;
  /** Optional - omitted when no meaningful period comparison applies to this evidence item. */
  comparison?: string;
};

export type BusinessInsight = {
  type: InsightType;
  title: string;
  description: string;
  evidence: InsightEvidence[];
  severity: InsightSeverity;
  confidence: InsightConfidence;
};

export type BusinessInsightsReport = {
  summary: string;
  insights: BusinessInsight[];
  dataLimitations: string[];
};

export type GenerateInsightsResult =
  | { ok: true; report: BusinessInsightsReport; interactionId: string | null }
  | { ok: false; error: string };

/** Test seam only - production callers must never pass this; see the file header. */
export type ClaudeCallFn = (systemPrompt: string, userPrompt: string) => Promise<string>;

export type GenerateInsightsOptions = {
  callClaudeFn?: ClaudeCallFn;
  /**
   * Supplying a Supabase client opts INTO best-effort persistence to
   * ai_interactions (interaction_type = "business_insights"). Omit it to run
   * in a pure compute-only mode with no database write at all - persistence
   * is never forced. See "AI interaction persistence" in the Phase 5.3
   * report for the reasoning.
   */
  supabase?: SupabaseClient;
};

// ---------------------------------------------------------------------------
// AI input payload - the ONLY data Claude ever sees
// ---------------------------------------------------------------------------

/**
 * Explicit allowlist of exactly the Phase 5.2 metric groups, never the whole
 * snapshot object. Deliberately excludes `organizationId` (an internal
 * identifier the AI has no use for) and `generatedAt` (irrelevant metadata).
 * Phase 5.2's BusinessMetricsSnapshot already contains zero customer PII by
 * design (no names, phone numbers, email addresses, or message bodies - only
 * aggregate counts/sums/rates) - this allowlist exists as an explicit,
 * auditable boundary rather than relying on that implicitly.
 */
export type AiInsightsInput = {
  period: ResolvedDateRange;
  comparisons: BusinessMetricsComparisons;
  leadMetrics: BiLeadMetrics;
  pipelineMetrics: BiPipelineMetrics;
  estimateMetrics: BiEstimateMetrics;
  jobMetrics: BiJobMetrics;
  appointmentMetrics: BiAppointmentMetrics;
  communicationMetrics: BiCommunicationMetrics;
  automationMetrics: BiAutomationMetrics;
  aiMetrics: BiAiMetrics;
  followUpMetrics: BiFollowUpMetrics;
  dataQuality: BiDataQuality;
};

export function buildAiInsightsInput(snapshot: BusinessMetricsSnapshot): AiInsightsInput {
  return {
    period: snapshot.period,
    comparisons: snapshot.comparisons,
    leadMetrics: snapshot.leadMetrics,
    pipelineMetrics: snapshot.pipelineMetrics,
    estimateMetrics: snapshot.estimateMetrics,
    jobMetrics: snapshot.jobMetrics,
    appointmentMetrics: snapshot.appointmentMetrics,
    communicationMetrics: snapshot.communicationMetrics,
    automationMetrics: snapshot.automationMetrics,
    aiMetrics: snapshot.aiMetrics,
    followUpMetrics: snapshot.followUpMetrics,
    dataQuality: snapshot.dataQuality,
  };
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a business-analytics assistant for Trackpr, a contractor CRM. You turn ALREADY-COMPUTED business metrics into a short, factual report for the contractor who owns the business. You do not calculate anything yourself - every number you are given is already final.

MANDATORY RULES - failing any of these makes your entire response unusable:
1. Use only the metrics supplied in the user message. Never invent, estimate, or guess a number that is not present there.
2. Never invent a cause, reason, or explanation for a change unless the supplied metrics explicitly state it. "Lead volume decreased" is fine. "Your marketing stopped working" is not - nothing in the data says why it changed.
3. Never infer a customer's motive, opinion, or behavior (e.g. "customers are price-sensitive," "customers disliked the service," "customers are unreliable"). You only have aggregate counts, never customer intent.
4. Never claim a lead source is better, worse, higher-converting, or lower-converting than another, even if one has a higher count. A higher lead count from one source is not evidence of quality - report counts only, e.g. "Facebook accounted for X leads."
5. Never call pipelineValue, estimateValue, acceptedEstimateValue, contractedJobValue, or completedContractedJobValue "revenue," "revenue collected," "cash collected," "profit," or "income." These are quoted/contracted figures, not confirmed collected money - completedContractedJobValue is the contracted value of completed work, not a payment record. If dataQuality.collectedRevenueUnavailable is true, you may say collected revenue is not available because Trackpr does not currently have payment data.
5b. Never claim an estimate was "too expensive," "overpriced," or that price caused any outcome - price is never given to you as a cause.
6. Never claim automation, AI, a follow-up, or a nurture/reactivation touch "generated," "caused," "recovered," or is responsible for any dollar amount or specific outcome. You may report factually that a certain number of these automated touches occurred.
7. Never claim a historical stage-transition duration (e.g. "leads took 3 days to become qualified") unless a metric explicitly labeled as measuring that is supplied to you. If dataQuality.stageHistoryUnavailable is true, no such historical timing data exists at all.
8. Never include or reference any customer name, phone number, email address, or message content - you are never given any of these, so this should never come up, but do not invent placeholder customer details either.
9. Read the dataQuality flags. If a limitation is relevant to something you are about to say, mention it briefly in plain language (e.g. "Trackpr does not currently have payment data, so collected revenue isn't included in this report."). Do not list every flag mechanically if it isn't relevant to what you're reporting.
10. Return ONLY the JSON object described below - no prose before or after it, no markdown code fences.

WHAT YOU MAY SAY (observational language only):
- "Lead volume increased from X to Y."
- "Estimate acceptance was X% during this period."
- "Appointment no-show rate was X%."
- "Automation failures increased compared with the previous period."
- "Facebook accounted for X leads in this period." (count only, never a quality judgment)

WHAT YOU MAY NEVER SAY:
- Any specific dollar amount as "revenue," "profit," "income," or "cash collected."
- Any claim that automation/AI/a follow-up "generated" or "recovered" money.
- Any claim about why a number changed, unless the data states the reason.
- Any ranking or quality judgment about a lead source.
- Any historical stage-transition timing not explicitly supplied.
- Any statement about customer motives, satisfaction, or reliability.

OUTPUT SHAPE (return exactly this JSON object, nothing else):
{
  "summary": "2-4 sentences, factual, describing the period using only the supplied metrics. No generic filler like 'Your business is doing great!' - if there is not yet enough activity to say anything meaningful, say so plainly instead.",
  "insights": [
    {
      "type": "one of: lead_volume | pipeline | estimates | appointments | jobs | communication | follow_up | automation | data_quality",
      "title": "short, specific, factual",
      "description": "1-3 sentences, factual, no invented causes",
      "evidence": [
        { "metric": "short label for the metric", "value": "the actual value as a short string", "comparison": "optional - only include when a real previous-period comparison exists" }
      ],
      "severity": "info | attention - use attention only for a meaningful operational change or issue worth reviewing, never invent urgency beyond that",
      "confidence": "high | medium | low - high for a direct count/sum with good data, medium for a documented proxy, low for weak/limited data"
    }
  ],
  "dataLimitations": ["short plain-language notes about any data-quality limitation that materially affects what you reported - omit if none are relevant"]
}

Return between 0 and 8 insights. Aim for 3-6 when the data supports meaningful observations. If the organization has little or no activity in this period, return fewer insights (including zero) rather than inventing something to fill space - a brief factual summary noting the lack of activity is correct in that case.`;

// ---------------------------------------------------------------------------
// Claude call (production path)
// ---------------------------------------------------------------------------

/** The exact model this file has always hardcoded (unchanged) - also the one value lib/costs/ai-cost-events.ts's trust boundary is entitled to trust for this interaction_type, since it is set here, by Trackpr's own code, never self-reported by an external system. */
const CLAUDE_MODEL = "claude-sonnet-5";

export type AiUsageTelemetry = { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };

/**
 * Phase 5D-2: reads the real Anthropic response's own `usage` block - always
 * present on a successful response per the SDK's type (input_tokens/
 * output_tokens are non-optional numbers), but validated defensively rather
 * than trusted blindly, matching this codebase's standing "never assume,
 * always check the shape" discipline. total_tokens is a real derived sum of
 * two real observed numbers (never invented, never substituted for a
 * missing value) - null whenever either input or output is itself not a
 * valid number.
 */
export function extractUsageFromMessage(message: Pick<Anthropic.Message, "usage">): AiUsageTelemetry {
  const usage = message.usage;
  const inputTokens = isValidTokenCount(usage?.input_tokens) ? usage.input_tokens : null;
  const outputTokens = isValidTokenCount(usage?.output_tokens) ? usage.output_tokens : null;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
  };
}

type ClaudeCallWithUsage = { text: string; usage: AiUsageTelemetry };

async function defaultCallClaudeWithUsage(systemPrompt: string, userPrompt: string): Promise<ClaudeCallWithUsage> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("AI insights are not configured for this environment.");
  }

  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const textBlock = message.content.find((block): block is Anthropic.TextBlock => block.type === "text");
  if (!textBlock) {
    throw new Error("Claude returned no text content.");
  }
  return { text: textBlock.text, usage: extractUsageFromMessage(message) };
}

// ---------------------------------------------------------------------------
// JSON parsing - mirrors the established n8n Code-node pattern (strip
// markdown fences, then JSON.parse) used throughout every AI-generation
// branch in the n8n workflow this codebase already relies on.
// ---------------------------------------------------------------------------

function parseJsonLoose(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  let text = raw.trim();
  text = text.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: "Claude did not return valid JSON." };
  }
}

// ---------------------------------------------------------------------------
// Strict schema validation - reject, never repair. Any malformed field,
// invalid enum value, missing required field, unexpected extra field, or
// unsupported number fails the ENTIRE report.
// ---------------------------------------------------------------------------

const MAX_STRING = { title: 200, description: 1000, summary: 2000, evidenceField: 200, limitation: 500 };

/**
 * Architectural (not just prompt-level) enforcement of the forbidden-claim
 * rules: automation/AI "generated" or "recovered" a dollar amount,
 * lead-source performance ranking, fabricated historical stage-transition
 * timing, and inferred customer motive/pricing causation. Heuristic,
 * regex-based, deliberately not a language model - mirrors the documented
 * philosophy of lib/automation/content-safety.ts exactly: a
 * last-line-of-defense backstop, not the only safeguard (the system prompt
 * already instructs the model not to produce these in the first place).
 * Checked against every free-text field in the report. Collected-revenue
 * terminology is handled separately below (REVENUE_NEGATION_PATTERN) since,
 * unlike these four, it has one legitimate negated phrasing.
 */
const FORBIDDEN_CLAIM_PATTERNS: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /\b(generated|caused|recovered)\b[^.]{0,40}\$|\$[^.]{0,40}\b(generated|caused|recovered)\b/i,
    reason: "response claims automation/AI/a follow-up generated, caused, or recovered a dollar amount",
  },
  {
    pattern: /\b(best|worst)\s+(lead\s+)?source\b|highest.?convert|lowest.?convert|better than\s+\w+\s+at\s+convert|source\s+(is|was)\s+(better|worse)/i,
    reason: "response ranks or judges lead-source performance",
  },
  {
    pattern: /took an average of|average time (for|it takes)? ?(leads?|customers?) to (become|convert|get)|\bdays to (become|convert) qualified\b/i,
    reason: "response claims a historical stage-transition duration not supplied by the metric layer",
  },
  {
    pattern: /overpriced|too expensive|price.?sensitive|customers? (disliked|didn't like|are unreliable|don't want|weren't interested)/i,
    reason: "response infers customer motive, satisfaction, or pricing causation",
  },
];

/**
 * The one sanctioned use of "collected revenue" wording is the negated form
 * the system prompt explicitly teaches ("Collected revenue is unavailable
 * because Trackpr does not currently have payment data.") - a blanket ban
 * on the phrase would also reject that ALLOWED sentence. A
 * revenue/cash-collected/profit/income mention is only treated as forbidden
 * when the same string does NOT also contain a nearby negation/unavailable
 * word explaining that it doesn't exist - i.e. only an AFFIRMATIVE claim of
 * collected money is blocked.
 */
const REVENUE_NEGATION_PATTERN = /\b(unavailable|not\s+available|not\s+currently|does\s*not|doesn'?t|isn'?t|is\s+not|no\s+payment|not\s+included)\b/i;

function findForbiddenClaim(texts: string[]): string | null {
  for (const text of texts) {
    if (/revenue\s+collected|cash\s+collected|collected\s+revenue|\bprofit\b|\bincome\b/i.test(text) && !REVENUE_NEGATION_PATTERN.test(text)) {
      return "response uses collected-revenue/profit/income terminology as an affirmative claim (not the sanctioned 'unavailable' phrasing)";
    }
    for (const { pattern, reason } of FORBIDDEN_CLAIM_PATTERNS) {
      if (pattern.test(text)) return reason;
    }
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(obj: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(obj).every((key) => allowed.includes(key));
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

/** Recursively collects every finite number appearing anywhere in the AI input payload. */
function collectKnownNumbers(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number" && Number.isFinite(value)) {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectKnownNumbers(item, out);
  } else if (isPlainObject(value)) {
    for (const item of Object.values(value)) collectKnownNumbers(item, out);
  }
  return out;
}

function extractNumbers(text: string): number[] {
  const matches = text.match(/-?\d+(\.\d+)?/g);
  if (!matches) return [];
  return matches.map(Number).filter((n) => Number.isFinite(n));
}

/** Allows a small rounding tolerance (e.g. a percentage rounded to the nearest whole number) - a heuristic backstop, not a perfect prover, matching the documented philosophy of lib/automation/content-safety.ts. */
function isKnownNumber(value: number, known: number[]): boolean {
  const tolerance = 1;
  return known.some((k) => Math.abs(k - value) <= tolerance || Math.abs(Math.round(k) - value) <= tolerance);
}

function validateEvidence(value: unknown, known: number[]): value is InsightEvidence {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, ["metric", "value", "comparison"])) return false;
  if (!isNonEmptyString(value.metric, MAX_STRING.evidenceField)) return false;
  if (!isNonEmptyString(value.value, MAX_STRING.evidenceField)) return false;
  if (value.comparison !== undefined && (typeof value.comparison !== "string" || value.comparison.length > MAX_STRING.evidenceField)) return false;

  for (const text of [value.value, value.comparison].filter((v): v is string => typeof v === "string")) {
    for (const number of extractNumbers(text)) {
      if (!isKnownNumber(number, known)) return false;
    }
  }
  return true;
}

function validateInsight(value: unknown, known: number[]): value is BusinessInsight {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, ["type", "title", "description", "evidence", "severity", "confidence"])) return false;
  if (typeof value.type !== "string" || !(INSIGHT_TYPES as readonly string[]).includes(value.type)) return false;
  if (!isNonEmptyString(value.title, MAX_STRING.title)) return false;
  if (!isNonEmptyString(value.description, MAX_STRING.description)) return false;
  if (extractNumbers(value.description).some((n) => !isKnownNumber(n, known))) return false;
  if (!Array.isArray(value.evidence) || !value.evidence.every((item) => validateEvidence(item, known))) return false;
  if (typeof value.severity !== "string" || !(INSIGHT_SEVERITIES as readonly string[]).includes(value.severity)) return false;
  if (typeof value.confidence !== "string" || !(INSIGHT_CONFIDENCES as readonly string[]).includes(value.confidence)) return false;
  return true;
}

export function validateInsightsReport(raw: unknown, aiInput: AiInsightsInput): { ok: true; report: BusinessInsightsReport } | { ok: false; error: string } {
  if (!isPlainObject(raw)) return { ok: false, error: "Response is not a JSON object." };
  if (!hasOnlyKeys(raw, ["summary", "insights", "dataLimitations"])) return { ok: false, error: "Response contains unexpected top-level fields." };

  if (!isNonEmptyString(raw.summary, MAX_STRING.summary)) return { ok: false, error: "summary is missing or invalid." };

  const known = collectKnownNumbers(aiInput);
  if (extractNumbers(raw.summary).some((n) => !isKnownNumber(n, known))) {
    return { ok: false, error: "summary contains a number not present in the supplied metrics." };
  }

  if (!Array.isArray(raw.insights)) return { ok: false, error: "insights is missing or invalid." };
  if (raw.insights.length > MAX_INSIGHTS) return { ok: false, error: `insights exceeds the maximum of ${MAX_INSIGHTS}.` };
  if (!raw.insights.every((item) => validateInsight(item, known))) {
    return { ok: false, error: "One or more insights failed validation (invalid type/severity/confidence, missing field, unexpected field, or an unsupported number)." };
  }

  if (!Array.isArray(raw.dataLimitations) || !raw.dataLimitations.every((item) => typeof item === "string" && item.length <= MAX_STRING.limitation)) {
    return { ok: false, error: "dataLimitations is missing or invalid." };
  }
  if (raw.dataLimitations.length > 10) return { ok: false, error: "dataLimitations has too many entries." };

  const insights = raw.insights as BusinessInsight[];
  const dataLimitations = raw.dataLimitations as string[];

  const allFreeText = [
    raw.summary,
    ...dataLimitations,
    ...insights.flatMap((insight) => [
      insight.title,
      insight.description,
      ...insight.evidence.flatMap((e) => [e.metric, e.value, e.comparison ?? ""]),
    ]),
  ];
  const forbiddenReason = findForbiddenClaim(allFreeText);
  if (forbiddenReason) return { ok: false, error: `Response rejected: ${forbiddenReason}.` };

  return {
    ok: true,
    report: { summary: raw.summary, insights, dataLimitations },
  };
}

// ---------------------------------------------------------------------------
// Persistence (opt-in only - see GenerateInsightsOptions.supabase)
// ---------------------------------------------------------------------------

export async function persistInsightsInteraction(
  supabase: SupabaseClient,
  organizationId: string,
  input: AiInsightsInput,
  report: BusinessInsightsReport,
  usage: AiUsageTelemetry | null,
): Promise<string | null> {
  // Best-effort, matching every other AI/automation persistence write in
  // this codebase (e.g. the n8n callback route's ai_interactions upsert) -
  // a logging failure must never fail insight generation itself. No
  // lead/contact/conversation/workflow_execution linkage applies here (this
  // is an organization-level aggregate insight, not tied to any single
  // entity or automation dispatch), so those columns are left null.
  //
  // Phase 5D-2: `output` gains a sibling `usage` field alongside the
  // existing report fields - the exact same shape convention n8n-driven
  // interactions already use (output.usage.input_tokens/output_tokens/
  // total_tokens, see app/api/automation/n8n-callback/route.ts), so
  // lib/agency/cost-readiness.ts's existing extractAiTokenUsage() picks it
  // up automatically with no change to that file. The report returned to
  // this function's own caller (generateBusinessInsights) is never
  // mutated - only what gets written to the database gains this field, so
  // the dashboard's rendered insights are completely unaffected.
  // `tokens_used` is populated the same way the n8n path already does:
  // only when a real total is known, left null (never 0) otherwise.
  const { data, error } = await supabase
    .from("ai_interactions")
    .insert({
      organization_id: organizationId,
      interaction_type: "business_insights",
      input,
      output: usage ? { ...report, usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, total_tokens: usage.totalTokens } } : report,
      model: CLAUDE_MODEL,
      tokens_used: usage?.totalTokens ?? null,
    })
    .select("id, created_at")
    .single();

  if (error) {
    console.error("[bi] failed to persist business_insights ai_interaction", { organizationId, error: error.message });
    return null;
  }

  // Phase 5D-2: opportunistic AI cost-event creation - best-effort, never
  // affects insight generation's own success/failure. "business_insights" is
  // the one interaction_type lib/costs/ai-cost-events.ts's trust boundary
  // recognizes (Trackpr's own code set both provider and model here, never
  // an n8n self-report) - see that file's own header comment for why every
  // other interaction_type is intentionally excluded. Missing/malformed
  // usage or a missing rate card both resolve to a real, non-crashing
  // "unpriced"/"unknown" outcome - this call's result is never surfaced to
  // the insight-generation caller, only logged, matching the same
  // best-effort discipline as the insert above.
  const trustedProvider = resolveTrustedAiProvider("business_insights");
  if (trustedProvider && usage) {
    const result = await recordAiCostEventForInteraction(supabase, {
      organizationId,
      sourceInteractionId: data.id as string,
      provider: trustedProvider,
      model: CLAUDE_MODEL,
      usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      occurredAt: data.created_at as string,
    });
    if (result.outcome === "error") {
      console.error("[bi] failed to record ai_cost_event for business_insights interaction", { organizationId, interactionId: data.id, error: result.error });
    }
  }

  return data.id as string;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Generates a structured, validated business insights report from an
 * already-computed Phase 5.2 BusinessMetricsSnapshot. Never queries
 * Supabase for raw data itself (all data comes from the snapshot the caller
 * already computed via lib/bi/metrics.ts), never sends customer PII to
 * Claude, and never returns unsafe/unvalidated structured data - any
 * failure (unconfigured, network error, malformed JSON, schema violation,
 * unsupported number) resolves to a typed `{ ok: false }` result, never a
 * thrown exception and never a "repaired" guess at what the AI meant.
 */
export async function generateBusinessInsights(
  snapshot: BusinessMetricsSnapshot,
  options: GenerateInsightsOptions = {},
): Promise<GenerateInsightsResult> {
  const aiInput = buildAiInsightsInput(snapshot);

  let rawText: string;
  // Phase 5D-2: usage is only ever real for the actual default (production)
  // Claude call - a test-injected callClaudeFn returns text only, so usage
  // correctly stays null for that path (there is no real API response to
  // read it from), never fabricated.
  let usage: AiUsageTelemetry | null = null;
  try {
    if (options.callClaudeFn) {
      rawText = await options.callClaudeFn(SYSTEM_PROMPT, JSON.stringify(aiInput));
    } else {
      const result = await defaultCallClaudeWithUsage(SYSTEM_PROMPT, JSON.stringify(aiInput));
      rawText = result.text;
      usage = result.usage;
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Claude call failed." };
  }

  const parsed = parseJsonLoose(rawText);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const validated = validateInsightsReport(parsed.value, aiInput);
  if (!validated.ok) return { ok: false, error: validated.error };

  let interactionId: string | null = null;
  if (options.supabase) {
    interactionId = await persistInsightsInteraction(options.supabase, snapshot.organizationId, aiInput, validated.report, usage);
  }

  return { ok: true, report: validated.report, interactionId };
}

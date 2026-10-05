import {
  AgentOutputSchema,
  AgentResultSchema,
  highestSeverity,
  lowestConfidence,
  type AgentOutput,
  type AgentResult,
  type Confidence,
  type ParsedAgentOutput,
} from "./contract";
import { enforceRecommendationPolicy } from "./permissions";
import type { AgentDefinition } from "./registry";

/**
 * Agent Operating Layer, Phase 1: how one agent runs.
 *
 * An agent is a pure analyzer - typed input in, AgentOutput out. It gets no
 * Supabase client, no fetch, no SMS/email/n8n/Stripe handle, so it has no
 * way to read another organization's data, bypass RLS or the outbound gate,
 * or change anything. The runtime around it:
 *  - turns a failed data read into a "failed" result instead of guessing;
 *  - catches anything the analyzer throws, and times it out;
 *  - validates the output against the contract (malformed output never
 *    reaches the Chief of Staff);
 *  - applies the approval model to every recommendation;
 *  - stamps run id, trace id and timestamps.
 * It never throws: every path ends in a valid AgentResult.
 */

/** The result of loading one agent's input. `reason` is a fixed, safe label - never a raw database or provider error. */
export type SourceRead<T> = { ok: true; data: T } | { ok: false; reason: string };

export type AgentAnalyzer<I> = (input: I, context: { now: Date }) => AgentOutput | Promise<AgentOutput>;

export type AgentRunContext = {
  traceId: string;
  now: Date;
  /** Test seams. */
  clock?: () => number;
  newId?: () => string;
  timeoutMs?: number;
};

export const DEFAULT_AGENT_TIMEOUT_MS = 10_000;

const SAFE_REASON = /^[a-z0-9_ .,:'-]{1,120}$/i;

function safeReason(reason: string): string {
  return SAFE_REASON.test(reason) ? reason : "data source unavailable";
}

class AgentTimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new AgentTimeoutError()), ms)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type Stamp = { runId: string; traceId: string; startedAt: string; startMs: number; clock: () => number };

function finish(definition: AgentDefinition, stamp: Stamp, body: Pick<AgentResult, "status" | "summary" | "findings" | "recommendations" | "error" | "metadata">): AgentResult {
  const status = body.status;
  const fallbackConfidence: Confidence = status === "ok" || status === "empty" ? "high" : "low";
  const result: AgentResult = {
    agent: definition.id,
    runId: stamp.runId,
    traceId: stamp.traceId,
    ...body,
    priority: highestSeverity([...body.findings.map((f) => f.severity), ...body.recommendations.map((r) => r.priority)]),
    confidence: lowestConfidence(body.findings.map((f) => f.confidence), fallbackConfidence),
    requiresApproval: body.recommendations.some((r) => r.requiresApproval),
    dataSources: [...definition.allowedDataSources],
    startedAt: stamp.startedAt,
    createdAt: new Date(stamp.clock()).toISOString(),
    durationMs: Math.max(0, Math.round(stamp.clock() - stamp.startMs)),
  };
  return result;
}

function failed(definition: AgentDefinition, stamp: Stamp, error: string, metadata: AgentResult["metadata"] = {}): AgentResult {
  return finish(definition, stamp, {
    status: "failed",
    summary: `${definition.name} could not run: ${error}.`,
    findings: [],
    recommendations: [],
    error,
    metadata,
  });
}

/** Drops duplicate finding ids and recommendation links to findings that do not exist - structure the Chief of Staff can trust. */
function normalize(output: ParsedAgentOutput): ParsedAgentOutput {
  const seen = new Set<string>();
  const findings = output.findings.filter((finding) => (seen.has(finding.id) ? false : (seen.add(finding.id), true)));
  const recommendations = output.recommendations.map((r) => ({ ...r, relatedFindingIds: r.relatedFindingIds.filter((id) => seen.has(id)) }));
  const status = output.status === "ok" && findings.length === 0 && recommendations.length === 0 ? "empty" : output.status;
  return { ...output, status, findings, recommendations };
}

export async function runAgent<I>(definition: AgentDefinition, analyze: AgentAnalyzer<I>, input: SourceRead<I>, context: AgentRunContext): Promise<AgentResult> {
  const clock = context.clock ?? Date.now;
  const startMs = clock();
  const stamp: Stamp = { runId: (context.newId ?? (() => crypto.randomUUID()))(), traceId: context.traceId, startedAt: new Date(startMs).toISOString(), startMs, clock };

  if (!input.ok) return failed(definition, stamp, safeReason(input.reason));

  let raw: unknown;
  try {
    raw = await withTimeout(Promise.resolve().then(() => analyze(input.data, { now: context.now })), context.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS);
  } catch (error) {
    return failed(definition, stamp, error instanceof AgentTimeoutError ? "timed out" : "analysis error");
  }

  const parsed = AgentOutputSchema.safeParse(raw);
  if (!parsed.success) return failed(definition, stamp, "malformed output", { issueCount: parsed.error.issues.length });

  const output = normalize(parsed.data);
  const adjustments: string[] = [];
  const recommendations = output.recommendations.map((recommendation) => {
    const enforced = enforceRecommendationPolicy(recommendation, definition.maxAutonomy);
    if (enforced.adjustment) adjustments.push(enforced.adjustment.reason);
    return enforced.recommendation;
  });

  const result = finish(definition, stamp, {
    status: output.status,
    summary: output.summary,
    findings: output.findings,
    recommendations,
    error: null,
    metadata: { ...output.metadata, policyAdjustments: adjustments.length },
  });

  // Belt and braces: whatever finish() built must itself satisfy the contract.
  const check = AgentResultSchema.safeParse(result);
  return check.success ? check.data : failed(definition, stamp, "malformed output", { issueCount: check.error.issues.length });
}

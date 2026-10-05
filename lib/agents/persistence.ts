import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentResult } from "./contract";

/**
 * Agent Operating Layer, Phase 1: optional, best-effort run history in
 * public.agent_runs (supabase/pending/agent_runs.sql - NOT yet applied to
 * production; a person applies it deliberately, as with every pending
 * migration).
 *
 * Off unless TRACKPR_AGENT_RUN_PERSISTENCE is exactly "on", so deploying
 * this code changes no production behavior and writes nothing until both
 * the table exists and someone turns it on. Written with the caller's own
 * RLS-scoped client (the table's insert policy requires an agency admin who
 * is a member of the organization, recording themselves as created_by) -
 * never the service role. One row per agent per run, all sharing the trace
 * id, so a briefing can be traced back to the exact agent outputs behind it.
 *
 * Never throws and never blocks the console: a failed insert is reported in
 * the return value only. Results hold findings and recommendations built
 * from the narrow projections in ./sources.ts - no tokens, credentials,
 * phone numbers or message bodies.
 */

export const AGENT_RUN_PERSISTENCE_FLAG = "TRACKPR_AGENT_RUN_PERSISTENCE";

export function agentRunPersistenceEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[AGENT_RUN_PERSISTENCE_FLAG] === "on";
}

export type AgentRunRow = {
  organization_id: string;
  trace_id: string;
  run_id: string;
  agent_id: string;
  status: string;
  summary: string;
  priority: string;
  confidence: string;
  requires_approval: boolean;
  finding_count: number;
  result: { findings: AgentResult["findings"]; recommendations: AgentResult["recommendations"]; metadata: AgentResult["metadata"]; dataSources: string[] };
  error: string | null;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  created_by: string;
};

export function toAgentRunRow(result: AgentResult, organizationId: string, userId: string): AgentRunRow {
  return {
    organization_id: organizationId,
    trace_id: result.traceId,
    run_id: result.runId,
    agent_id: result.agent,
    status: result.status,
    summary: result.summary,
    priority: result.priority,
    confidence: result.confidence,
    requires_approval: result.requiresApproval,
    finding_count: result.findings.length,
    result: { findings: result.findings, recommendations: result.recommendations, metadata: result.metadata, dataSources: result.dataSources },
    error: result.error,
    started_at: result.startedAt,
    finished_at: result.createdAt,
    duration_ms: result.durationMs,
    created_by: userId,
  };
}

export type PersistOutcome = { persisted: false; reason: "disabled" | "insert_failed" } | { persisted: true; rows: number };

export async function persistAgentRuns(supabase: SupabaseClient, input: { organizationId: string; userId: string; results: AgentResult[] }, env: Record<string, string | undefined> = process.env): Promise<PersistOutcome> {
  if (!agentRunPersistenceEnabled(env)) return { persisted: false, reason: "disabled" };
  try {
    const rows = input.results.map((result) => toAgentRunRow(result, input.organizationId, input.userId));
    const { error } = await supabase.from("agent_runs").insert(rows);
    return error ? { persisted: false, reason: "insert_failed" } : { persisted: true, rows: rows.length };
  } catch {
    return { persisted: false, reason: "insert_failed" };
  }
}

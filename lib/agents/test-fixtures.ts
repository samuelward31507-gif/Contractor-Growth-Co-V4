import type { AgentResult } from "./contract";
import type { SalesInput, SalesItem } from "./agents/sales";
import type { TrackprIntelligenceInput } from "./agents/trackpr-intelligence";
import type { QaHealthInput, QaIncident } from "./agents/qa-health";
import type { SpecialistInputs } from "./operating-layer";

/** Shared, hand-written fixtures for lib/agents tests. No database, no network. */

export const NOW = new Date("2026-10-05T14:00:00.000Z");
export const TRACE_ID = "11111111-1111-4111-8111-111111111111";

let seq = 0;
export function sequentialIds(): () => string {
  seq = 0;
  return () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
}

export function salesItem(overrides: Partial<SalesItem> = {}): SalesItem {
  return { key: "k", reasonCode: "lead_not_contacted", tier: "active_pursuit", act: "attention", actor: "human", missedFollowUp: null, name: "Pat Jones", actionHref: "/people/p1", value: null, ...overrides };
}

export function emptySalesInput(): SalesInput {
  return { exceptions: [], attention: [], opportunities: [], trackprHandlingCount: 0 };
}

/** Twelve leads past their follow-up window - the brief's example. */
export function twelveStaleLeads(): SalesInput {
  return {
    ...emptySalesInput(),
    attention: Array.from({ length: 12 }, (_, i) => salesItem({ key: `lead-${i}`, name: `Lead ${i + 1}`, actionHref: `/people/p${i}`, missedFollowUp: "first_contact", value: i === 3 ? 9000 : null })),
  };
}

export function emptyTrackprInput(): TrackprIntelligenceInput {
  return {
    periodLabel: "in the last 30 days",
    leads: { total: 0, won: 0, lost: 0, qualifiedWithoutAppointment: 0, lostRate: null },
    appointments: { noShows: 0, noShowRate: null, completedWithoutEstimate: 0 },
    estimates: { openValue: 0, expiredValue: 0, recoverableValue: 0 },
    invoices: { overdueValue: 0, overdueCount: 0, outstandingValue: 0 },
    automation: { failedExecutions: 0, successRate: null },
    unavailable: { revenueOpportunity: false, billing: false, automation: false, partial: false },
  };
}

export function incident(overrides: Partial<QaIncident> = {}): QaIncident {
  return { id: "inc-1", category: "n8n_callback_failed", severity: "warning", status: "open", title: "Callback failed", occurrenceCount: 1, lastSeenAt: "2026-10-05T13:30:00.000Z", ...overrides };
}

export function healthyQaInput(overrides: Partial<QaHealthInput> = {}): QaHealthInput {
  return {
    automationMode: "live",
    health: { status: "healthy", paymentStatus: "active", automationPaused: false, staleScheduledAutomationCount: 0, failedWorkflowExecutions: 0, automationSuccessRate: 0.98, incidentsUnavailable: false },
    incidents: [],
    calendarDisconnected: false,
    ...overrides,
  };
}

export function quietInputs(): SpecialistInputs {
  return {
    sales: { ok: true, data: emptySalesInput() },
    trackpr_intelligence: { ok: true, data: emptyTrackprInput() },
    qa_health: { ok: true, data: healthyQaInput() },
    engineering: { ok: true, data: { incidents: [], incidentsUnavailable: false } },
    market_intelligence: { ok: true, data: [] },
    prospecting: { ok: true, data: [] },
  };
}

/** The brief's worked example: 2 callback failures, 12 stale leads, one sourced market note. */
export function exampleInputs(): SpecialistInputs {
  const incidents = [incident({ id: "inc-1", occurrenceCount: 1 }), incident({ id: "inc-2", occurrenceCount: 1 })];
  return {
    ...quietInputs(),
    sales: { ok: true, data: twelveStaleLeads() },
    qa_health: { ok: true, data: healthyQaInput({ incidents, health: { ...healthyQaInput().health, status: "degraded" } }) },
    engineering: { ok: true, data: { incidents, incidentsUnavailable: false } },
    market_intelligence: {
      ok: true,
      data: [{ market: "peptide", kind: "inference", statement: "Peptide clinics are increasingly adopting automated qualification.", observedAt: "2026-10-01" }],
    },
  };
}

export function validResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    agent: "sales",
    runId: "22222222-2222-4222-8222-222222222222",
    traceId: TRACE_ID,
    status: "ok",
    summary: "Summary.",
    findings: [],
    recommendations: [],
    priority: "info",
    confidence: "high",
    requiresApproval: false,
    dataSources: ["decisions"],
    error: null,
    startedAt: NOW.toISOString(),
    createdAt: NOW.toISOString(),
    durationMs: 1,
    metadata: {},
    ...overrides,
  };
}

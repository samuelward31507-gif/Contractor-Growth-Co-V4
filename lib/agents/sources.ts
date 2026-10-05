import type { AssembledDecisions, DecisionItem } from "@/lib/decisions/types";
import type { PrioritizedOpportunity } from "@/lib/opportunities/intelligence";
import type { BusinessMetricsSnapshot } from "@/lib/bi/types";
import type { AutomationIncident, OrganizationHealthSummary } from "@/lib/automation-health/types";
import type { SalesInput, SalesItem } from "./agents/sales";
import type { TrackprIntelligenceInput } from "./agents/trackpr-intelligence";
import type { QaHealthInput, QaIncident } from "./agents/qa-health";

/**
 * Agent Operating Layer, Phase 1: pure projections from the existing reads
 * (see ./load.ts) to each agent's narrow input. An agent only ever sees the
 * fields named here - no tokens, phone numbers, message bodies, payment
 * details or raw rows - which is also what keeps a persisted run free of
 * anything sensitive.
 */

function toSalesItem(item: DecisionItem, valueByOpportunityId: Map<string, number | null>): SalesItem {
  return {
    key: item.key,
    reasonCode: item.reasonCode,
    tier: item.tier,
    act: item.act,
    actor: item.actor,
    missedFollowUp: item.missedFollowUp ?? null,
    name: item.subject.name.slice(0, 200) || "Unnamed",
    actionHref: item.nextAction.href.startsWith("/") && !item.nextAction.href.startsWith("//") ? item.nextAction.href : "/today",
    value: item.source.kind === "opportunity" ? (valueByOpportunityId.get(item.source.opportunityId) ?? null) : null,
  };
}

export function projectSalesInput(decisions: AssembledDecisions, prioritized: PrioritizedOpportunity[]): SalesInput {
  const values = new Map(prioritized.map((p) => [p.opportunity.id, p.opportunity.estimatedValue ?? null]));
  return {
    exceptions: decisions.exceptions.map((item) => toSalesItem(item, values)),
    attention: decisions.attention.map((item) => toSalesItem(item, values)),
    opportunities: decisions.opportunities.map((item) => toSalesItem(item, values)),
    trackprHandlingCount: decisions.trackprHandling.length,
  };
}

export function projectTrackprIntelligenceInput(snapshot: BusinessMetricsSnapshot, periodLabel = "in the last 30 days"): TrackprIntelligenceInput {
  const unavailable = snapshot.revenueOpportunityUnavailable;
  return {
    periodLabel,
    leads: {
      total: snapshot.leadMetrics.totalLeads,
      won: snapshot.leadMetrics.wonLeads,
      lost: snapshot.leadMetrics.lostLeads,
      lostRate: snapshot.leadMetrics.lostRate,
      qualifiedWithoutAppointment: snapshot.revenueOpportunity.qualifiedLeadsWithoutAppointment,
    },
    appointments: {
      noShows: snapshot.appointmentMetrics.noShowAppointments,
      noShowRate: snapshot.appointmentMetrics.appointmentNoShowRate,
      completedWithoutEstimate: snapshot.revenueOpportunity.completedAppointmentsWithoutEstimate,
    },
    estimates: {
      openValue: snapshot.revenueOpportunity.openEstimateValue,
      expiredValue: snapshot.revenueOpportunity.expiredEstimateValue,
      recoverableValue: snapshot.revenueOpportunity.recoverableEstimateValue,
    },
    invoices: {
      overdueValue: snapshot.billingMetrics.overdueValue,
      overdueCount: snapshot.billingMetrics.overdueInvoices,
      outstandingValue: snapshot.billingMetrics.outstandingValue,
    },
    automation: { failedExecutions: snapshot.automationMetrics.failedWorkflowExecutions, successRate: snapshot.automationMetrics.automationSuccessRate },
    unavailable: {
      revenueOpportunity: unavailable.estimates || unavailable.qualifiedNoAppointment || unavailable.visitsNoEstimate,
      billing: snapshot.dataQuality.collectedRevenueUnavailable,
      automation: snapshot.automationUnavailable,
      partial: snapshot.partialData,
    },
  };
}

export function projectIncidents(incidents: AutomationIncident[]): QaIncident[] {
  return incidents
    .filter((incident): incident is AutomationIncident & { status: "open" | "acknowledged" } => incident.status === "open" || incident.status === "acknowledged")
    .map((incident) => ({ id: incident.id, category: incident.category, severity: incident.severity, status: incident.status, title: incident.title.slice(0, 200), occurrenceCount: incident.occurrenceCount, lastSeenAt: incident.lastSeenAt }));
}

export function projectQaInput(health: OrganizationHealthSummary, incidents: AutomationIncident[], automationMode: "test" | "live", decisions: AssembledDecisions | null): QaHealthInput {
  return {
    automationMode,
    health: {
      status: health.status,
      paymentStatus: health.paymentStatus,
      automationPaused: health.automationPaused,
      staleScheduledAutomationCount: health.staleScheduledAutomationCount,
      failedWorkflowExecutions: health.failedWorkflowExecutions,
      automationSuccessRate: health.automationSuccessRate,
      incidentsUnavailable: health.incidentsUnavailable,
    },
    incidents: projectIncidents(incidents),
    calendarDisconnected: decisions?.exceptions.some((item) => item.reasonCode === "calendar_sync_failed") ?? false,
  };
}

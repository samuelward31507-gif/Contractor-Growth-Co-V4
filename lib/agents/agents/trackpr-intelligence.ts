import { lowerConfidence, type AgentOutput, type Confidence, type Finding, type Recommendation } from "../contract";
import { formatCount, formatUsd, percent, plural } from "../format";

/**
 * Trackpr Intelligence agent: "where is money being lost?" across the
 * lead -> appointment -> estimate -> job -> invoice -> payment lifecycle.
 *
 * Reads a narrow projection of the deterministic BI snapshot
 * (lib/bi/metrics.ts) - it never calculates a figure the BI layer did not
 * already compute, and a group the snapshot marks unavailable is reported as
 * unavailable, never as a confident zero. Thresholds below only decide
 * whether a stored rate is worth raising; the rate itself is a fact.
 */

export type TrackprIntelligenceInput = {
  periodLabel: string;
  leads: { total: number; won: number; lost: number; qualifiedWithoutAppointment: number; lostRate: number | null };
  appointments: { noShows: number; noShowRate: number | null; completedWithoutEstimate: number };
  estimates: { openValue: number; expiredValue: number; recoverableValue: number };
  invoices: { overdueValue: number; overdueCount: number; outstandingValue: number };
  automation: { failedExecutions: number; successRate: number | null };
  unavailable: { revenueOpportunity: boolean; billing: boolean; automation: boolean; partial: boolean };
};

/** A rate is raised only above these, and only over enough events to mean something. */
export const LOST_RATE_ALERT = 0.5;
export const NO_SHOW_RATE_ALERT = 0.15;
export const AUTOMATION_SUCCESS_ALERT = 0.9;
const MIN_EVENTS = 3;

export function analyzeTrackprIntelligence(input: TrackprIntelligenceInput): AgentOutput {
  const findings: Finding[] = [];
  const recommendations: Recommendation[] = [];
  const confidence: Confidence = input.unavailable.partial ? lowerConfidence("high") : "high";

  const add = (finding: Omit<Finding, "basis" | "confidence" | "sources" | "evidence"> & { evidence?: Finding["evidence"]; basis?: Finding["basis"] }, action?: Omit<Recommendation, "id" | "autonomy" | "requiresApproval" | "confidence" | "relatedFindingIds" | "priority" | "actionKind"> & { actionKind?: Recommendation["actionKind"] }) => {
    findings.push({ basis: "fact", confidence, sources: [], evidence: [], ...finding });
    if (action) {
      recommendations.push({ id: `${finding.id}:act`, actionKind: "review", autonomy: "recommend", requiresApproval: false, priority: finding.severity, confidence, relatedFindingIds: [finding.id], ...action });
    }
  };

  if (input.unavailable.billing) {
    add({ id: "billing_unavailable", kind: "status", severity: "info", category: "data_quality", title: "Invoice and payment figures unavailable", detail: "The invoice ledger could not be read, so overdue and outstanding money is not shown here." });
  } else if (input.invoices.overdueCount > 0) {
    add(
      {
        id: "overdue_invoices",
        kind: "risk",
        severity: "high",
        category: "collections",
        title: `${formatUsd(input.invoices.overdueValue)} overdue across ${formatCount(input.invoices.overdueCount)} ${plural(input.invoices.overdueCount, "invoice", "invoices")}`,
        detail: "Billed, past the due date, and not yet paid - the closest money to collect.",
        evidence: [
          { label: "Overdue", value: formatUsd(input.invoices.overdueValue) },
          { label: "Outstanding in total", value: formatUsd(input.invoices.outstandingValue) },
        ],
        href: "/money?browse=invoices&status=overdue",
      },
      { title: "Collect the overdue invoices", detail: "Start with the oldest overdue balance.", href: "/money?browse=invoices&status=overdue" },
    );
  }

  if (input.unavailable.revenueOpportunity) {
    add({ id: "revenue_opportunity_unavailable", kind: "status", severity: "info", category: "data_quality", title: "Pipeline leak figures unavailable", detail: "Some estimate and booking reads failed, so recoverable value and unbooked leads are not shown here." });
  } else {
    if (input.estimates.recoverableValue > 0) {
      add(
        {
          id: "recoverable_estimates",
          kind: "opportunity",
          severity: input.estimates.expiredValue > 0 ? "high" : "medium",
          category: "estimates",
          title: `${formatUsd(input.estimates.recoverableValue)} in quoted work not yet won`,
          detail: "Estimates sent and undecided, or expired with no decision - none of it declined.",
          evidence: [
            { label: "Sent, awaiting decision", value: formatUsd(input.estimates.openValue) },
            { label: "Expired, no decision", value: formatUsd(input.estimates.expiredValue) },
          ],
          href: "/estimates",
        },
        { title: "Follow up on expired and open estimates", detail: "Expired quotes first - their follow-up window has already closed.", href: "/estimates" },
      );
    }
    if (input.leads.qualifiedWithoutAppointment > 0) {
      const n = input.leads.qualifiedWithoutAppointment;
      add(
        { id: "qualified_unbooked", kind: "risk", severity: "medium", category: "booking", title: `${formatCount(n)} qualified ${plural(n, "lead has", "leads have")} never been booked`, detail: "Ready to buy, with no appointment ever scheduled.", href: "/leads" },
        { title: "Book the qualified leads", detail: "A qualified lead with no visit is the cheapest booking to win.", href: "/leads", actionKind: "call_customer" },
      );
    }
    if (input.appointments.completedWithoutEstimate > 0) {
      const n = input.appointments.completedWithoutEstimate;
      add(
        { id: "visits_without_estimate", kind: "risk", severity: "medium", category: "estimates", title: `${formatCount(n)} completed ${plural(n, "visit", "visits")} never quoted`, detail: "The visit happened; no estimate was ever sent.", href: "/estimates" },
        { title: "Quote the completed visits", detail: "Each one is a customer who already let you in.", href: "/estimates" },
      );
    }
  }

  if (input.appointments.noShowRate != null && input.appointments.noShowRate >= NO_SHOW_RATE_ALERT && input.appointments.noShows >= MIN_EVENTS) {
    add({
      id: "no_show_rate",
      kind: "risk",
      severity: "medium",
      category: "appointments",
      title: `${percent(input.appointments.noShowRate)} of resolved appointments were no-shows`,
      detail: `${formatCount(input.appointments.noShows)} no-shows ${input.periodLabel}. Reminders and confirmations are where this is usually won back.`,
      href: "/schedule?view=list",
    });
  }

  const decided = input.leads.won + input.leads.lost;
  if (input.leads.lostRate != null && input.leads.lostRate >= LOST_RATE_ALERT && decided >= MIN_EVENTS) {
    add({
      id: "lost_rate",
      kind: "risk",
      severity: "medium",
      category: "conversion",
      title: `${percent(input.leads.lostRate)} of decided leads were lost`,
      detail: `${formatCount(input.leads.lost)} lost against ${formatCount(input.leads.won)} won. This is a current-state ratio, not a trend.`,
      href: "/leads",
    });
  }

  if (input.unavailable.automation) {
    add({ id: "automation_metrics_unavailable", kind: "status", severity: "info", category: "data_quality", title: "Automation figures unavailable", detail: "Execution counts could not be read for this period." });
  } else if (input.automation.successRate != null && input.automation.successRate < AUTOMATION_SUCCESS_ALERT && input.automation.failedExecutions > 0) {
    add({
      id: "automation_success_rate",
      kind: "risk",
      severity: "medium",
      category: "automation",
      title: `Automation succeeded ${percent(input.automation.successRate)} of the time`,
      detail: `${formatCount(input.automation.failedExecutions)} failed ${plural(input.automation.failedExecutions, "run", "runs")} ${input.periodLabel}. Failed follow-ups are revenue touches that never happened.`,
      href: "/automation-health",
    });
  }

  const leaks = findings.filter((f) => f.kind !== "status").length;
  return {
    status: findings.length === 0 ? "empty" : "ok",
    summary: leaks === 0 ? `No money leaks stand out ${input.periodLabel}.` : `${formatCount(leaks)} ${plural(leaks, "place", "places")} where money is being lost or left on the table.`,
    findings,
    recommendations,
    metadata: { period: input.periodLabel, partialData: input.unavailable.partial, totalLeads: input.leads.total },
  };
}

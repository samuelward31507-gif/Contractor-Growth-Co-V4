import type { IncidentCategory, IncidentSeverity, OrganizationHealthStatus } from "@/lib/automation-health/types";
import { INCIDENT_SENTENCE } from "@/lib/ui/incident-language";
import type { AgentOutput, Finding, Recommendation, Severity } from "../contract";
import { formatCount, percent, plural } from "../format";

/**
 * QA / Health agent. Classifies what the deterministic automation-health
 * layer (lib/automation-health) already recorded - incidents, stuck work,
 * stale schedules, pause and payment state - into CRITICAL / HIGH / MEDIUM /
 * LOW / INFO and recommends the next step. It never acknowledges, resolves,
 * retries or changes anything: any recommendation that would touch
 * production is a requires-approval recommendation, and the runtime
 * enforces that whatever this file says.
 */

export type QaIncident = {
  id: string;
  category: IncidentCategory;
  severity: IncidentSeverity;
  status: "open" | "acknowledged";
  title: string;
  occurrenceCount: number;
  lastSeenAt: string;
};

export type QaHealthInput = {
  automationMode: "test" | "live";
  health: {
    status: OrganizationHealthStatus;
    paymentStatus: string;
    automationPaused: boolean;
    staleScheduledAutomationCount: number;
    failedWorkflowExecutions: number;
    automationSuccessRate: number | null;
    incidentsUnavailable: boolean;
  };
  incidents: QaIncident[];
  calendarDisconnected: boolean;
};

/** Integration and callback failures are the ones that silently stop customer work, so a warning there is HIGH, not MEDIUM. */
const HIGH_WHEN_WARNING: ReadonlySet<IncidentCategory> = new Set(["n8n_callback_failed", "n8n_dispatch_failed", "repeated_workflow_failure", "sms_send_failed", "online_payment_reconciliation"]);

export function classifyIncidentSeverity(category: IncidentCategory, severity: IncidentSeverity): Severity {
  if (severity === "critical") return "critical";
  if (severity === "warning") return HIGH_WHEN_WARNING.has(category) ? "high" : "medium";
  return "low";
}

/** Operator-facing plural nouns per category ("2 active n8n callback failures"). */
export const INCIDENT_NOUN: Record<IncidentCategory, [one: string, many: string]> = {
  workflow_failed: ["workflow failure", "workflow failures"],
  repeated_workflow_failure: ["repeating workflow failure", "repeating workflow failures"],
  workflow_stuck: ["stuck workflow", "stuck workflows"],
  n8n_dispatch_failed: ["n8n dispatch failure", "n8n dispatch failures"],
  n8n_callback_failed: ["n8n callback failure", "n8n callback failures"],
  sms_send_failed: ["SMS send failure", "SMS send failures"],
  sms_delivery_failed: ["SMS delivery failure", "SMS delivery failures"],
  human_escalation_requested: ["human escalation", "human escalations"],
  scheduled_automation_stale: ["late scheduled automation", "late scheduled automations"],
  online_payment_reconciliation: ["payment to reconcile", "payments to reconcile"],
};

/** "Oct 5, 13:30 UTC" - stated in UTC so the operator never has to guess the zone. */
function formatSeenAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }).format(date)} UTC`;
}

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

export function analyzeQaHealth(input: QaHealthInput): AgentOutput {
  const findings: Finding[] = [];
  const recommendations: Recommendation[] = [];
  const { health } = input;

  if (input.automationMode === "test") {
    findings.push({
      id: "test_mode",
      kind: "status",
      basis: "fact",
      severity: "info",
      confidence: "high",
      category: "automation_mode",
      title: "Workspace is in test mode",
      detail: "Trackpr sends no real customer messages from a test workspace - the outbound gate blocks every send until the workspace is live.",
      evidence: [],
      href: "/settings",
      sources: [],
    });
  }

  if (health.incidentsUnavailable) {
    findings.push({ id: "health_unavailable", kind: "risk", basis: "fact", severity: "high", confidence: "high", category: "observability", title: "Automation health could not be read", detail: "The health read failed, so incidents and failures are unknown - not zero.", evidence: [], href: "/automation-health", sources: [] });
    recommendations.push({ id: "health_unavailable:act", title: "Check automation health directly", detail: "Open the health page; if it also fails, the database or its health function needs a look.", actionKind: "investigate", autonomy: "recommend", requiresApproval: false, priority: "high", confidence: "high", href: "/automation-health", relatedFindingIds: ["health_unavailable"] });
  }

  if (health.paymentStatus !== "active") {
    findings.push({ id: "payment_blocked", kind: "risk", basis: "fact", severity: "high", confidence: "high", category: "payment_gate", title: "Automation is blocked by payment status", detail: `Payment status is "${health.paymentStatus}". The payment gate stops every automated send until it is active.`, evidence: [], href: "/settings", sources: [] });
    recommendations.push({ id: "payment_blocked:act", title: "Review the billing status", detail: "Any change to billing needs an explicit decision by the account owner.", actionKind: "modify_billing", autonomy: "requires_approval", requiresApproval: true, priority: "high", confidence: "high", href: "/settings", relatedFindingIds: ["payment_blocked"] });
  } else if (health.automationPaused) {
    findings.push({ id: "automation_paused", kind: "risk", basis: "fact", severity: "medium", confidence: "high", category: "automation_pause", title: "Automation is paused", detail: "No automated follow-ups or replies go out while paused.", evidence: [], href: "/automations", sources: [] });
  }

  // One finding per incident category, worst first. Human escalations are sales work (the Sales agent reports them).
  const byCategory = new Map<IncidentCategory, QaIncident[]>();
  for (const incident of input.incidents) {
    if (incident.category === "human_escalation_requested") continue;
    byCategory.set(incident.category, [...(byCategory.get(incident.category) ?? []), incident]);
  }
  const groups = [...byCategory.entries()].map(([category, incidents]) => {
    const severity = incidents.map((i) => classifyIncidentSeverity(category, i.severity)).sort((a, b) => SEVERITY_ORDER.indexOf(a) - SEVERITY_ORDER.indexOf(b))[0];
    return { category, incidents, severity };
  });
  groups.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));

  for (const { category, incidents, severity } of groups) {
    const occurrences = incidents.reduce((total, i) => total + Math.max(1, i.occurrenceCount), 0);
    const latest = incidents.map((i) => i.lastSeenAt).sort().at(-1) ?? "";
    const id = `incident:${category}`;
    findings.push({
      id,
      kind: "risk",
      basis: "fact",
      severity,
      confidence: "high",
      category,
      title: `${formatCount(incidents.length)} active ${plural(incidents.length, ...INCIDENT_NOUN[category])}`,
      detail: `${INCIDENT_SENTENCE[category]} ${formatCount(occurrences)} ${plural(occurrences, "occurrence", "occurrences")} in total.`,
      evidence: [
        ...incidents.slice(0, 3).map((i) => ({ label: i.status === "acknowledged" ? "Acknowledged" : "Open", value: i.title.slice(0, 300) || category })),
        ...(latest ? [{ label: "Last seen", value: formatSeenAt(latest) }] : []),
      ],
      href: "/automation-health",
      sources: [],
    });
    recommendations.push({
      id: `${id}:investigate`,
      title: `Investigate the ${INCIDENT_NOUN[category][1]}`,
      detail: "Read the incident details and the Engineering agent's likely cause before changing anything.",
      actionKind: "investigate",
      autonomy: "recommend",
      requiresApproval: false,
      priority: severity,
      confidence: "high",
      href: "/automation-health",
      relatedFindingIds: [id],
    });
    if (category === "workflow_failed" || category === "repeated_workflow_failure" || category === "n8n_dispatch_failed" || category === "n8n_callback_failed") {
      recommendations.push({
        id: `${id}:retry`,
        title: "Retry the failed runs once the cause is fixed",
        detail: "A retry re-runs customer-facing automation through the outbound gate. It needs your explicit go-ahead.",
        actionKind: "change_production",
        autonomy: "requires_approval",
        requiresApproval: true,
        priority: severity === "critical" ? "high" : severity,
        confidence: "medium",
        href: "/automations",
        relatedFindingIds: [id],
      });
    }
  }

  if (health.staleScheduledAutomationCount > 0 && !byCategory.has("scheduled_automation_stale")) {
    const n = health.staleScheduledAutomationCount;
    findings.push({ id: "stale_schedules", kind: "risk", basis: "fact", severity: "medium", confidence: "medium", category: "scheduled_automation_stale", title: `${formatCount(n)} scheduled ${plural(n, "automation has", "automations have")} gone quiet`, detail: "Observed running before and silent past its grace window. Real but unproven - the cron may simply have had nothing to do.", evidence: [], href: "/automation-health", sources: [] });
  }

  if (input.calendarDisconnected) {
    findings.push({ id: "calendar_disconnected", kind: "risk", basis: "fact", severity: "medium", confidence: "high", category: "integration", title: "Calendar is disconnected", detail: "Appointments are not syncing to the connected calendar.", evidence: [], href: "/settings", sources: [] });
    recommendations.push({ id: "calendar_disconnected:act", title: "Reconnect the calendar", detail: "Reconnecting changes an integration, so it needs your explicit go-ahead.", actionKind: "change_integrations", autonomy: "requires_approval", requiresApproval: true, priority: "medium", confidence: "high", href: "/settings", relatedFindingIds: ["calendar_disconnected"] });
  }

  const problems = findings.filter((f) => f.kind === "risk").length;
  if (problems === 0 && !health.incidentsUnavailable) {
    findings.push({
      id: "healthy",
      kind: "status",
      basis: "fact",
      severity: "info",
      confidence: "high",
      category: "health",
      title: "Automation is running normally",
      detail: health.automationSuccessRate != null ? `${percent(health.automationSuccessRate)} of runs succeeded over the last 30 days.` : "No completed or failed runs in the last 30 days to rate.",
      evidence: [],
      href: "/automation-health",
      sources: [],
    });
  }

  return {
    status: "ok",
    summary: problems === 0 ? "No system problems found." : `${formatCount(problems)} system ${plural(problems, "problem", "problems")} found.`,
    findings,
    recommendations,
    metadata: { healthStatus: health.status, activeIncidents: input.incidents.length, automationMode: input.automationMode },
  };
}

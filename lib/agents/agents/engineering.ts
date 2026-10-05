import type { IncidentCategory } from "@/lib/automation-health/types";
import type { AgentOutput, Confidence, Finding, Recommendation } from "../contract";
import { formatCount, plural } from "../format";
import { classifyIncidentSeverity, type QaIncident } from "./qa-health";

/**
 * Engineering agent. For each active incident category, names the code that
 * owns it, the likely causes, the tests to run, the deployment risk of a
 * fix and how to roll one back. Phase 1 is read and analysis only: every
 * cause is an INFERENCE from the category and how often it recurs (the
 * agent sees no logs, stack traces or secrets), and shipping any fix is a
 * requires-approval recommendation. It never edits code, n8n workflows,
 * Twilio, Stripe or production configuration.
 *
 * The playbook paths are real files in this repository; a test
 * (lib/agents/agents.test.ts) fails if any of them stops existing.
 */

export type EngineeringPlaybook = {
  subsystem: string;
  likelyCauses: string[];
  files: string[];
  tests: string[];
  deployRisk: "low" | "medium" | "high";
  rollback: string;
};

const VERCEL_ROLLBACK = "Roll back with Vercel's instant rollback to the last good deployment; no database change is involved.";

export const ENGINEERING_PLAYBOOK: Partial<Record<IncidentCategory, EngineeringPlaybook>> = {
  n8n_callback_failed: {
    subsystem: "n8n callback route",
    likelyCauses: [
      "N8N_WEBHOOK_SECRET differs between n8n and this deployment (environment configuration).",
      "SUPABASE_SERVICE_ROLE_KEY is missing in this environment, so the callback cannot record the result.",
      "The callback payload no longer matches what the route validates (a workflow change on the n8n side).",
      "A late or duplicate callback for an execution that is no longer running.",
    ],
    files: ["app/api/automation/n8n-callback/route.ts", "lib/automation/executions.ts", "lib/supabase/service.ts"],
    tests: ["app/api/automation/n8n-callback/booking.integration.test.ts", "app/api/automation/n8n-callback/human-escalation.integration.test.ts", "lib/automation/executions.test.ts"],
    deployRisk: "high",
    rollback: `Every n8n workflow reports through this route. ${VERCEL_ROLLBACK}`,
  },
  n8n_dispatch_failed: {
    subsystem: "n8n dispatch",
    likelyCauses: ["N8N_BASE_URL is unset or unreachable from this deployment.", "The target n8n workflow is inactive or its webhook path changed.", "n8n rejected the shared secret."],
    files: ["lib/automation/n8n.ts", "lib/automation/n8n-retry.ts", "lib/automation/executions.ts"],
    tests: ["lib/automation/n8n.test.ts", "lib/automation/retry.test.ts"],
    deployRisk: "medium",
    rollback: VERCEL_ROLLBACK,
  },
  workflow_failed: {
    subsystem: "workflow execution",
    likelyCauses: ["The workflow reported a failure for one record (data-specific).", "An upstream dependency of the workflow failed."],
    files: ["lib/automation/executions.ts", "lib/automation/retry.ts", "lib/automation/retry-eligibility.ts"],
    tests: ["lib/automation/executions.test.ts", "lib/automation/retry-eligibility.test.ts"],
    deployRisk: "medium",
    rollback: VERCEL_ROLLBACK,
  },
  repeated_workflow_failure: {
    subsystem: "workflow execution",
    likelyCauses: ["A systematic failure - configuration or a code change - rather than one bad record, since it has recurred three or more times."],
    files: ["lib/automation/executions.ts", "lib/automation/retry.ts", "lib/automation-health/service.ts"],
    tests: ["lib/automation/executions.test.ts", "lib/automation/retry.test.ts"],
    deployRisk: "medium",
    rollback: VERCEL_ROLLBACK,
  },
  workflow_stuck: {
    subsystem: "execution liveness",
    likelyCauses: ["n8n accepted the dispatch but never called back.", "The callback failed - check for n8n callback incidents at the same time."],
    files: ["app/api/automation/health/route.ts", "lib/automation-health/health.ts", "app/api/automation/n8n-callback/route.ts"],
    tests: ["lib/automation-health/health.cache.test.ts", "lib/automation/execution-detail.test.ts"],
    deployRisk: "low",
    rollback: VERCEL_ROLLBACK,
  },
  sms_send_failed: {
    subsystem: "outbound SMS",
    likelyCauses: ["The SMS provider rejected the send (credentials, sender number or account state).", "The destination number is invalid for the provider."],
    files: ["lib/automation/sms.ts", "lib/messaging/outbound.ts", "lib/automation/outbound-gate.ts"],
    tests: ["lib/automation/sms.test.ts", "lib/automation/outbound-gate.test.ts"],
    deployRisk: "high",
    rollback: `Outbound messaging is customer-facing; verify in a test workspace first. ${VERCEL_ROLLBACK}`,
  },
  sms_delivery_failed: {
    subsystem: "SMS delivery status",
    likelyCauses: ["The carrier rejected or could not deliver the message (often number registration or content filtering)."],
    files: ["app/api/webhooks/sms/status/route.ts", "lib/messaging/delivery-status.ts"],
    tests: ["lib/messaging/delivery-status.test.ts"],
    deployRisk: "low",
    rollback: VERCEL_ROLLBACK,
  },
  scheduled_automation_stale: {
    subsystem: "scheduled automations",
    likelyCauses: ["The scheduler stopped calling the cron route.", "The cron secret no longer matches, so scheduled calls are rejected.", "There was genuinely nothing to process - liveness is unproven, not confirmed broken."],
    files: ["lib/automation-health/scheduled-automation-liveness.ts", "lib/automation-health/scheduler-watchdog.ts", "lib/automation/cron-auth.ts", "vercel.json"],
    tests: ["lib/automation-health/scheduled-automation-liveness.test.ts", "lib/automation-health/scheduler-watchdog.test.ts", "lib/automation/cron-auth.test.ts"],
    deployRisk: "medium",
    rollback: VERCEL_ROLLBACK,
  },
  online_payment_reconciliation: {
    subsystem: "online payments",
    likelyCauses: ["Stripe recorded a payment the invoice ledger could not - a person must reconcile it in Stripe and on the invoice."],
    files: ["lib/payments/online-payment.ts", "app/api/webhooks/stripe-connect/route.ts"],
    tests: ["lib/payments/online-payment.test.ts", "app/api/webhooks/stripe-connect/route.guard.test.ts"],
    deployRisk: "high",
    rollback: `Payment code touches money. Never replay or edit Stripe events from here. ${VERCEL_ROLLBACK}`,
  },
};

export type EngineeringInput = { incidents: QaIncident[]; incidentsUnavailable: boolean };

export function analyzeEngineering(input: EngineeringInput): AgentOutput {
  const findings: Finding[] = [];
  const recommendations: Recommendation[] = [];

  if (input.incidentsUnavailable) {
    return {
      status: "ok",
      summary: "Incidents could not be read, so there is nothing to diagnose yet.",
      findings: [{ id: "no_incident_data", kind: "status", basis: "fact", severity: "info", confidence: "high", category: "observability", title: "No incident data to diagnose", detail: "The automation health read failed; QA reports it.", evidence: [], sources: [] }],
      recommendations: [],
      metadata: {},
    };
  }

  const categories = new Map<IncidentCategory, QaIncident[]>();
  for (const incident of input.incidents) categories.set(incident.category, [...(categories.get(incident.category) ?? []), incident]);

  for (const [category, incidents] of categories) {
    const playbook = ENGINEERING_PLAYBOOK[category];
    if (!playbook) continue;
    const occurrences = incidents.reduce((total, i) => total + Math.max(1, i.occurrenceCount), 0);
    // Recurrence is the one signal this agent has: a cause is likelier systemic when the incident keeps happening.
    const confidence: Confidence = occurrences >= 3 ? "medium" : "low";
    const severity = incidents.map((i) => classifyIncidentSeverity(category, i.severity)).includes("critical") ? "high" : "medium";
    const id = `diagnosis:${category}`;
    findings.push({
      id,
      kind: "risk",
      basis: "inference",
      severity,
      confidence,
      category,
      title: `Likely cause of the ${playbook.subsystem} incidents`,
      detail: playbook.likelyCauses[0],
      evidence: [
        { label: "Incidents", value: `${formatCount(incidents.length)} active, ${formatCount(occurrences)} ${plural(occurrences, "occurrence", "occurrences")}` },
        ...playbook.likelyCauses.slice(1, 3).map((cause, index) => ({ label: `Alternative ${index + 1}`, value: cause })),
        { label: "Code", value: playbook.files.join(", ") },
        { label: "Deploy risk", value: playbook.deployRisk },
      ],
      href: "/automation-health",
      sources: [],
    });
    recommendations.push({
      id: `${id}:verify`,
      title: `Verify the ${playbook.subsystem} hypothesis`,
      detail: `Check the cause against the incident details, then run: ${playbook.tests.join(", ")}.`,
      actionKind: "investigate",
      autonomy: "recommend",
      requiresApproval: false,
      priority: severity,
      confidence,
      href: "/automation-health",
      relatedFindingIds: [id],
    });
    recommendations.push({
      id: `${id}:fix`,
      title: `Ship the ${playbook.subsystem} fix only with approval`,
      detail: `Deploy risk ${playbook.deployRisk}. ${playbook.rollback}`,
      actionKind: "deploy_code",
      autonomy: "requires_approval",
      requiresApproval: true,
      priority: severity === "high" ? "medium" : "low",
      confidence,
      relatedFindingIds: [id],
    });
  }

  return {
    status: findings.length === 0 ? "empty" : "ok",
    summary: findings.length === 0 ? "No incidents that need an engineering diagnosis." : `${formatCount(findings.length)} ${plural(findings.length, "incident type", "incident types")} diagnosed, all as hypotheses to verify.`,
    findings,
    recommendations,
    metadata: { diagnosedCategories: findings.length },
  };
}

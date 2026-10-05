/**
 * Agent Operating Layer: the six specialist agents' analysis rules, with
 * hand-written inputs. Pure: no network, no database.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/agents/agents.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const load = <T>(p: string): T => require(path.join(ROOT, p));
const { analyzeSales } = load<typeof import("./agents/sales")>("lib/agents/agents/sales.ts");
const { analyzeTrackprIntelligence } = load<typeof import("./agents/trackpr-intelligence")>("lib/agents/agents/trackpr-intelligence.ts");
const { analyzeQaHealth, classifyIncidentSeverity } = load<typeof import("./agents/qa-health")>("lib/agents/agents/qa-health.ts");
const { analyzeEngineering, ENGINEERING_PLAYBOOK } = load<typeof import("./agents/engineering")>("lib/agents/agents/engineering.ts");
const { analyzeProspecting } = load<typeof import("./agents/prospecting")>("lib/agents/agents/prospecting.ts");
const { analyzeMarketIntelligence } = load<typeof import("./agents/market-intelligence")>("lib/agents/agents/market-intelligence.ts");
const { AgentOutputSchema } = load<typeof import("./contract")>("lib/agents/contract.ts");
const fx = load<typeof import("./test-fixtures")>("lib/agents/test-fixtures.ts");

const valid = (output: unknown) => {
  const parsed = AgentOutputSchema.safeParse(output);
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3)));
  return parsed.data;
};

// --- Sales -----------------------------------------------------------------

test("sales: no data is an honest empty result", () => {
  const out = valid(analyzeSales(fx.emptySalesInput()));
  assert.equal(out.status, "empty");
  assert.equal(out.findings.length, 0);
  assert.match(out.summary, /No sales work/);
});

test("sales: 12 stale leads become one missed-follow-up finding with the real count, facts only", () => {
  const out = valid(analyzeSales(fx.twelveStaleLeads()));
  const missed = out.findings.find((f) => f.id === "missed_follow_up");
  assert.ok(missed);
  assert.equal(missed.title, "12 missed follow-ups");
  assert.equal(missed.basis, "fact");
  assert.equal(missed.severity, "high");
  // Each item is counted once - a missed follow-up is not also a "lead to pursue".
  assert.equal(out.findings.some((f) => f.id === "leads_to_pursue"), false);
  // The highest recorded value is surfaced, from the data - $9,000 on Lead 4.
  const top = out.findings.find((f) => f.id === "highest_value_opportunity");
  assert.equal(top?.title, "Highest-value open item: Lead 4");
  assert.equal(top?.href, "/people/p3");
});

test("sales: a missed reply is critical; escalations are critical; Trackpr-handled items are status only", () => {
  const out = valid(
    analyzeSales({
      exceptions: [fx.salesItem({ key: "e", reasonCode: "human_escalation", tier: null, name: "Sam", actionHref: "/conversations/c1" })],
      attention: [fx.salesItem({ key: "r", reasonCode: "customer_awaiting_reply", tier: "needs_reply", missedFollowUp: "reply" }), fx.salesItem({ key: "t", actor: "trackpr" })],
      opportunities: [],
      trackprHandlingCount: 1,
    }),
  );
  assert.equal(out.findings.find((f) => f.id === "human_escalation")?.severity, "critical");
  assert.equal(out.findings.find((f) => f.id === "missed_follow_up")?.severity, "critical");
  assert.equal(out.findings.find((f) => f.id === "trackpr_handling")?.kind, "status");
  assert.ok(out.recommendations.every((r) => r.requiresApproval === false && r.actionKind !== "send_customer_message"), "sales never proposes sending in Phase 1");
});

test("sales: groups land in the right buckets", () => {
  const out = valid(
    analyzeSales({
      ...fx.emptySalesInput(),
      attention: [
        fx.salesItem({ key: "1", reasonCode: "invoice_overdue", tier: "committed_revenue_at_risk", value: 500 }),
        fx.salesItem({ key: "2", reasonCode: "appointment_unconfirmed", tier: "at_risk" }),
        fx.salesItem({ key: "3", reasonCode: "estimate_expired", tier: "at_risk" }),
      ],
      opportunities: [fx.salesItem({ key: "4", reasonCode: "customer_dormant", tier: "recoverable", act: "opportunity" })],
    }),
  );
  assert.deepEqual(out.findings.map((f) => f.id), ["committed_revenue_at_risk", "appointments_need_attention", "estimates_at_risk", "highest_value_opportunity", "growth_opportunities"]);
});

// --- Trackpr Intelligence --------------------------------------------------

test("trackpr intelligence: empty lifecycle is empty, not invented", () => {
  const out = valid(analyzeTrackprIntelligence(fx.emptyTrackprInput()));
  assert.equal(out.status, "empty");
});

test("trackpr intelligence: names where money is lost with stored figures", () => {
  const input = fx.emptyTrackprInput();
  input.invoices = { overdueValue: 1200, overdueCount: 2, outstandingValue: 3000 };
  input.estimates = { openValue: 4000, expiredValue: 1000, recoverableValue: 5000 };
  input.leads.qualifiedWithoutAppointment = 3;
  input.appointments = { noShows: 4, noShowRate: 0.2, completedWithoutEstimate: 2 };
  input.automation = { failedExecutions: 3, successRate: 0.8 };
  const out = valid(analyzeTrackprIntelligence(input));
  const byId = new Map(out.findings.map((f) => [f.id, f]));
  assert.equal(byId.get("overdue_invoices")?.title, "$1,200 overdue across 2 invoices");
  assert.equal(byId.get("recoverable_estimates")?.severity, "high");
  assert.ok(byId.has("qualified_unbooked") && byId.has("visits_without_estimate") && byId.has("no_show_rate") && byId.has("automation_success_rate"));
});

test("trackpr intelligence: unavailable data is disclosed, never a confident zero; partial data lowers confidence", () => {
  const input = fx.emptyTrackprInput();
  input.unavailable = { revenueOpportunity: true, billing: true, automation: true, partial: true };
  input.invoices.overdueCount = 5; // must be ignored - the ledger read failed
  const out = valid(analyzeTrackprIntelligence(input));
  assert.deepEqual(out.findings.map((f) => f.id).sort(), ["automation_metrics_unavailable", "billing_unavailable", "revenue_opportunity_unavailable"]);
  assert.ok(out.findings.every((f) => f.kind === "status" && f.confidence === "medium"));
});

test("trackpr intelligence: small samples do not raise a rate", () => {
  const input = fx.emptyTrackprInput();
  input.leads = { ...input.leads, won: 1, lost: 1, lostRate: 0.5 };
  input.appointments = { noShows: 1, noShowRate: 0.5, completedWithoutEstimate: 0 };
  assert.equal(valid(analyzeTrackprIntelligence(input)).status, "empty");
});

// --- QA / Health -----------------------------------------------------------

test("qa: classification into the five levels", () => {
  assert.equal(classifyIncidentSeverity("workflow_failed", "critical"), "critical");
  assert.equal(classifyIncidentSeverity("n8n_callback_failed", "warning"), "high");
  assert.equal(classifyIncidentSeverity("workflow_stuck", "warning"), "medium");
  assert.equal(classifyIncidentSeverity("sms_delivery_failed", "info"), "low");
});

test("qa: healthy system reports one INFO status line", () => {
  const out = valid(analyzeQaHealth(fx.healthyQaInput()));
  assert.deepEqual(out.findings.map((f) => [f.id, f.severity]), [["healthy", "info"]]);
  assert.equal(out.recommendations.length, 0);
});

test("qa: TEST workspace is stated plainly", () => {
  const out = valid(analyzeQaHealth(fx.healthyQaInput({ automationMode: "test" })));
  const testMode = out.findings.find((f) => f.id === "test_mode");
  assert.ok(testMode);
  assert.match(testMode.detail, /no real customer messages/);
});

test("qa: two callback failures are one HIGH finding; any retry or integration change requires approval", () => {
  const out = valid(analyzeQaHealth(fx.healthyQaInput({ incidents: [fx.incident({ id: "a" }), fx.incident({ id: "b" })], calendarDisconnected: true })));
  const callbacks = out.findings.find((f) => f.id === "incident:n8n_callback_failed");
  assert.equal(callbacks?.severity, "high");
  assert.match(callbacks?.title ?? "", /^2 active n8n callback failures$/);
  for (const r of out.recommendations) {
    if (r.actionKind === "change_production" || r.actionKind === "change_integrations" || r.actionKind === "modify_billing") assert.equal(r.requiresApproval, true, r.id);
  }
  assert.ok(out.recommendations.some((r) => r.actionKind === "change_production"));
});

test("qa: unreadable health is HIGH and unknown, never 'no incidents'", () => {
  const out = valid(analyzeQaHealth(fx.healthyQaInput({ health: { ...fx.healthyQaInput().health, incidentsUnavailable: true } })));
  assert.equal(out.findings.find((f) => f.id === "health_unavailable")?.severity, "high");
  assert.equal(out.findings.some((f) => f.id === "healthy"), false);
});

test("qa: payment block and human escalations", () => {
  const out = valid(analyzeQaHealth(fx.healthyQaInput({ health: { ...fx.healthyQaInput().health, paymentStatus: "payment_required" }, incidents: [fx.incident({ category: "human_escalation_requested" })] })));
  assert.ok(out.findings.some((f) => f.id === "payment_blocked"));
  assert.equal(out.findings.some((f) => f.category === "human_escalation_requested"), false, "escalations are reported by Sales");
});

// --- Engineering -----------------------------------------------------------

test("engineering: every playbook path is a real file in this repository", () => {
  for (const [category, playbook] of Object.entries(ENGINEERING_PLAYBOOK)) {
    for (const file of [...playbook!.files, ...playbook!.tests]) assert.ok(fs.existsSync(path.join(ROOT, file)), `${category}: ${file}`);
  }
});

test("engineering: diagnoses are inferences with modest confidence; shipping a fix always needs approval", () => {
  const once = valid(analyzeEngineering({ incidents: [fx.incident()], incidentsUnavailable: false }));
  assert.equal(once.findings[0].basis, "inference");
  assert.equal(once.findings[0].confidence, "low");
  const recurring = valid(analyzeEngineering({ incidents: [fx.incident({ occurrenceCount: 3 })], incidentsUnavailable: false }));
  assert.equal(recurring.findings[0].confidence, "medium");
  const fix = recurring.recommendations.find((r) => r.actionKind === "deploy_code");
  assert.equal(fix?.requiresApproval, true);
  assert.ok(once.findings.every((f) => f.confidence !== "high"), "an inference is never high confidence");
});

test("engineering: nothing to diagnose is empty; unreadable incidents are stated", () => {
  assert.equal(valid(analyzeEngineering({ incidents: [], incidentsUnavailable: false })).status, "empty");
  assert.equal(valid(analyzeEngineering({ incidents: [], incidentsUnavailable: true })).findings[0].id, "no_incident_data");
});

// --- Prospecting and Market Intelligence -----------------------------------

test("prospecting: no inputs is not_configured; contacting a prospect always needs approval; fit is never high confidence", () => {
  assert.equal(valid(analyzeProspecting([])).status, "not_configured");
  const out = valid(
    analyzeProspecting([
      { company: "Acme Roofing", vertical: "contractor", signals: [{ observation: "No online booking", source: "https://acme.example/contact" }] },
      { company: "Lift Gym", vertical: "gym" },
      { company: "", vertical: "contractor" } as never,
      { company: "Bad URL Spa", vertical: "clinic", signals: [{ observation: "x", source: "http://insecure.example" }] },
    ]),
  );
  assert.equal(out.findings.length, 2);
  assert.equal(out.metadata.rejected, 2);
  assert.equal(out.findings[0].confidence, "medium");
  assert.equal(out.findings[1].confidence, "low");
  assert.ok(out.findings.every((f) => f.basis === "inference"));
  assert.ok(out.recommendations.every((r) => r.actionKind === "contact_prospect" && r.requiresApproval));
});

test("market: verified needs a source; verified, inference and opinion never mix", () => {
  assert.equal(valid(analyzeMarketIntelligence([])).status, "not_configured");
  const out = valid(
    analyzeMarketIntelligence([
      { market: "gym", kind: "verified", statement: "Sourced fact.", source: { title: "Report", url: "https://example.com/r" }, observedAt: "2026-10-01" },
      { market: "gym", kind: "verified", statement: "Unsourced 'fact'.", observedAt: "2026-10-01" },
      { market: "peptide", kind: "inference", statement: "A trend.", observedAt: "2026-10-01" },
      { market: "pricing", kind: "opinion", statement: "We should raise prices.", observedAt: "2026-10-01" },
    ]),
  );
  assert.equal(out.metadata.rejected, 1);
  assert.deepEqual(out.findings.map((f) => [f.basis, f.confidence]), [["fact", "high"], ["inference", "low"]]);
  assert.equal(out.recommendations.length, 1, "the opinion is a recommendation, not a finding");
});

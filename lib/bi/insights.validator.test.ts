/**
 * Phase 1B-4: validateInsightsReport's collected-revenue rules now that a
 * real payment ledger exists (lib/bi/billing.ts). Pure - a hand-built
 * AiInsightsInput, no network, no Supabase. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/bi/insights.validator.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { AiInsightsInput } from "./insights";

const require = createRequire(import.meta.url);
const { validateInsightsReport }: typeof import("./insights") = require("./insights.ts");
const { SANCTIONED_COLLECTED_REVENUE_DEFINITION }: typeof import("./billing") = require("./billing.ts");

const comparison = (current: number, previous: number | null) => ({
  current,
  previous,
  change: previous === null ? null : current - previous,
  percentageChange: previous === null || previous === 0 ? null : ((current - previous) / previous) * 100,
});

function makeInput(overrides: { collectedRevenueUnavailable?: boolean } = {}): AiInsightsInput {
  return {
    period: { label: "last 30 days", from: "2026-10-01T00:00:00.000Z", to: "2026-10-31T00:00:00.000Z" },
    comparisons: {
      leadCount: comparison(12, 10),
      estimateCount: comparison(5, 5),
      jobCount: comparison(3, 2),
      leadsTransitionedToQualified: comparison(4, 4),
      leadsTransitionedToWon: comparison(2, 1),
      leadsContacted: comparison(9, 8),
      invoicedValue: comparison(4800, 3000),
      collectedValue: comparison(1200, 900),
    },
    leadMetrics: { totalLeads: 12, newLeads: 4, contactedLeads: 3, qualifiedLeads: 2, appointmentStageLeads: 1, estimateStageLeads: 1, wonLeads: 1, lostLeads: 0, hotLeads: 2, warmLeads: 6, coldLeads: 4, lostRate: null, sourceCounts: {}, leadToBookingRate: 25 },
    pipelineMetrics: { openOpportunityCount: 7, pipelineValue: 22000, averagePipelineValue: 3142.86 },
    estimateMetrics: { totalEstimates: 5, draftEstimates: 1, sentEstimates: 2, acceptedEstimates: 2, declinedEstimates: 0, cancelledEstimates: 0, expiredEstimates: 0, estimateValue: 15000, acceptedEstimateValue: 7500, averageEstimateValue: 3000, estimateAcceptanceRate: 100, estimateToJobRate: 150 },
    jobMetrics: { totalJobs: 3, scheduledJobs: 1, inProgressJobs: 1, completedJobs: 1, cancelledJobs: 0, contractedJobValue: 9000, completedContractedJobValue: 4800, averageContractedJobValue: 3000, jobCompletionRate: 100 },
    appointmentMetrics: { totalAppointments: 4, scheduledAppointments: 2, confirmedAppointments: 1, completedAppointments: 1, cancelledAppointments: 0, noShowAppointments: 0, appointmentNoShowRate: 0 },
    communicationMetrics: { inboundMessages: 20, outboundMessages: 30, customerReplies: 20, aiOutboundMessages: 18, userOutboundMessages: 10, systemOutboundMessages: 2, conversationsOpened: 6, conversationsClosed: 3, optOutCount: 0 },
    automationMetrics: { automationEvents: 40, completedAutomationEvents: 38, failedAutomationEvents: 2, pendingAutomationEvents: 0, workflowExecutions: 40, successfulWorkflowExecutions: 38, failedWorkflowExecutions: 2, runningWorkflowExecutions: 0, automationSuccessRate: 95 },
    aiMetrics: { aiInteractions: 18, aiOutboundInteractions: 15, customerReplyAiInteractions: 12, aiNeedsHumanCount: 1, totalTokensUsed: null, averageTokensPerInteraction: null, interactionsWithUsageData: 0 },
    followUpMetrics: { lostLeadNurtureEvents: 0, reactivationEvents: 1, appointmentReminderEvents: 4, estimateFollowUpEvents: 2, postJobFollowUpEvents: 1, leadsTouchedByAutomation: 10 },
    billingMetrics: {
      invoicedValue: 4800,
      invoicesIssued: 2,
      collectedValue: 1200,
      paymentsReceived: 3,
      reversedValue: 150,
      reversalCount: 1,
      outstandingValue: 3600,
      outstandingInvoices: 1,
      overdueValue: 0,
      overdueInvoices: 0,
      invoicesPaid: 1,
      averageDaysToPayment: 6,
    },
    dataQuality: {
      collectedRevenueUnavailable: overrides.collectedRevenueUnavailable ?? false,
      sourceAttributionLimited: true,
      stageHistoryUnavailable: true,
      aiTokenUsageUnavailable: true,
      notes: [],
    },
  };
}

const report = (summary: string, limitations: string[] = []) => ({ summary, insights: [], dataLimitations: limitations });

test("collected revenue citing the ledger's own figure is allowed now that the ledger exists", () => {
  const result = validateInsightsReport(report("Collected revenue was 1200 this period, net of 150 in reversals."), makeInput());
  assert.equal(result.ok, true, result.ok ? "" : result.error);
});

test("the exact sanctioned definition sentence is always allowed", () => {
  const result = validateInsightsReport(report(`${SANCTIONED_COLLECTED_REVENUE_DEFINITION} Lead volume increased from 10 to 12.`), makeInput());
  assert.equal(result.ok, true, result.ok ? "" : result.error);
});

test("calling an invoiced/contracted/quoted amount collected revenue is rejected even though the number is a real metric", () => {
  for (const text of ["Collected revenue was 4800 this period.", "Cash collected reached 7500.", "Revenue collected: 22000."]) {
    const result = validateInsightsReport(report(text), makeInput());
    assert.equal(result.ok, false, `should reject: ${text}`);
    assert.match(result.ok ? "" : result.error, /not a customer-payment ledger figure/);
  }
});

test("when the ledger could not be read, an affirmative collected-revenue claim is rejected and the negated form is still allowed", () => {
  const unavailable = makeInput({ collectedRevenueUnavailable: true });
  const affirmative = validateInsightsReport(report("Collected revenue was 1200 this period."), unavailable);
  assert.equal(affirmative.ok, false);
  assert.match(affirmative.ok ? "" : affirmative.error, /ledger was unavailable/);

  const negated = validateInsightsReport(report("Lead volume increased from 10 to 12.", ["Collected revenue is unavailable for this report because the payment ledger could not be read."]), unavailable);
  assert.equal(negated.ok, true, negated.ok ? "" : negated.error);
});

test("profit and income remain forbidden outright - nothing in the ledger measures either", () => {
  for (const text of ["Profit was 1200 this period.", "Income reached 1200."]) {
    const result = validateInsightsReport(report(text), makeInput());
    assert.equal(result.ok, false, `should reject: ${text}`);
    assert.match(result.ok ? "" : result.error, /profit\/income/);
  }
});

test("the previous-period comparison numbers for collected revenue are ledger figures and are allowed", () => {
  const result = validateInsightsReport(report("Collected revenue rose from 900 to 1200, a 33% increase."), makeInput());
  assert.equal(result.ok, true, result.ok ? "" : result.error);
});

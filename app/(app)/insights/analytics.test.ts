/**
 * Analytics (/insights) - the historical/performance destination:
 *
 *   1. panel order and grouping - one bordered panel per category, each
 *      figure once, every panel stating its time scope;
 *   2. the visual system - primary/secondary metric grids, breakdowns at
 *      full width, one gap, a phone-friendly range selector;
 *   3. labels that keep materially different metrics distinct.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/(app)/insights/analytics.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), "utf8").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const PAGE = read("app/(app)/insights/page.tsx");
const SECTIONS = read("app/(app)/insights/_components/business-metrics-sections.tsx");
const PANEL = read("app/(app)/insights/_components/metric-panel.tsx");
const OBSERVATIONS = read("app/(app)/insights/_components/observations.tsx");
const require = createRequire(import.meta.url);
const { ownerDataNotes }: typeof import("./_components/bi-format") = require(path.join(ROOT, "app/(app)/insights/_components/bi-format.ts"));
const { SANCTIONED_COLLECTED_REVENUE_DEFINITION }: typeof import("@/lib/bi/billing") = require(path.join(ROOT, "lib/bi/billing.ts"));

test("panels render in the approved order, with the activity timeline last", () => {
  const order = [
    "<RevenuePaymentsPanel",
    "<ObservationsPanel",
    "<LeadsConversionPanel",
    "<PipelineLeaksPanel",
    "<EstimatesJobsPanel",
    "<ResponseCommunicationPanel",
    "<SchedulingPanel",
    "<RetentionPanel",
    "<AutomationPanel",
    "<CalculationsPanel",
    'id="activity"',
  ].map((marker) => PAGE.indexOf(marker));
  assert.ok(order.every((index) => index > 0), `every panel is present: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(PAGE, /<div className="flex flex-col gap-6">/, "one even gap between panels");
});

test("removed: the at-a-glance strip, the activity overview counts and the automation-health metrics", () => {
  assert.doesNotMatch(PAGE + SECTIONS, /BusinessAtAGlance|ActivitySummaryCards|StatRow|StatCard/);
  assert.doesNotMatch(SECTIONS, /Workflow executions|automationMetrics|Success rate/, "automation health belongs to /automations");
  assert.match(SECTIONS, /href="\/automations"/, "...and is linked, not repeated");
  assert.ok(!fs.existsSync(path.join(ROOT, "app/(app)/insights/_components/activity-summary.tsx")));
});

test("the trend chart sits inside Leads & conversion, not Revenue", () => {
  assert.match(PAGE, /<LeadsConversionPanel\s+snapshot=\{snapshot\}\s+outcomes=\{outcomeMetrics\}\s+trend=\{<TrendSection/);
  assert.match(read("app/(app)/insights/_components/trend-section.tsx"), /<PanelBlock label="Leads, day by day"/);
});

test("every panel states its time scope - the period, 'As of today' or 'All time'", () => {
  assert.equal((SECTIONS.match(/scope=\{scopeLabel\(period\.label\)\}/g) ?? []).length, 6, "Leads, Estimates & jobs, Response, Scheduling, Retention, Automation");
  assert.match(SECTIONS, /const scope = scopeLabel\(period\.label\);[\s\S]*title="Revenue & payments" scope=\{scope\}/, "Revenue & payments, in both its states");
  assert.match(SECTIONS, /title="Pipeline & follow-up leaks" scope="As of today"/);
  assert.match(SECTIONS, /<PanelBlock label="Repeat customers" scope="All time">/);
  assert.match(SECTIONS, /· as of today/, "Outstanding/Overdue say they are balances as of today");
  assert.match(SECTIONS, /detail: `Leads created · \$\{periodScope\}`/, "Lost rate is period-scoped inside an as-of-today panel, and says so");
});

test("observations: moved from Today, labeled as the fixed last 30 days, generate preserved", () => {
  assert.match(PAGE, /getCachedBusinessInsights\(supabase, membership\.organizationId\)/);
  assert.match(OBSERVATIONS, /`Last 30 days · updated \$\{formatRelativeTime\(cached\.generatedAt\)\}/);
  assert.match(OBSERVATIONS, /<GenerateInsightsButton label="Refresh" \/>/);
  assert.match(OBSERVATIONS, /<GenerateInsightsButton label="Generate observations" \/>/);
  assert.match(read("app/(app)/dashboard/actions.ts"), /revalidatePath\("\/insights"\)/, "a new report shows where it now renders");
});

test("labels: materially different metrics never share a name", () => {
  assert.doesNotMatch(SECTIONS, /"Open opportunities"|"Pipeline value"|"Avg\. opportunity value"/);
  assert.match(SECTIONS, /label: "Open leads"/);
  assert.match(SECTIONS, /label: "Open lead value"/);
  for (const label of ["Collected", "Invoiced", "Leads", "Accepted estimate value", "Completed job value", "Lead → booking", "Estimate acceptance", "Estimate → job", "Job completion"]) {
    assert.equal((SECTIONS.match(new RegExp(`label: "${label}"`, "g")) ?? []).length, 1, `${label} appears once`);
  }
});

test("visual system: panel header, four-up primary row, six-up secondary grid, full-width breakdowns", () => {
  assert.match(PANEL, /rounded-lg border border-line bg-surface/);
  assert.match(PANEL, /border-b border-line px-4 py-3\.5 sm:px-5/);
  assert.match(PANEL, /text-\[15px\] font-semibold text-ink/);
  assert.match(PANEL, /grid grid-cols-2 gap-px bg-line/);
  assert.match(PANEL, /"md:grid-cols-4"/);
  assert.match(PANEL, /kpiValueClass/);
  assert.match(PANEL, /grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-6/);
  assert.match(PANEL, /grid grid-cols-1 gap-6 lg:grid-cols-2/);
  assert.doesNotMatch(SECTIONS, /max-w-md/);
  assert.doesNotMatch(PAGE + SECTIONS + PANEL, /primarySectionTitleClass|sectionLabelClass/);
  assert.match(read("app/(app)/insights/_components/bar-list.tsx"), /w-28 shrink-0/);
});

test("mobile: the range selector is one sideways-scrolling row, never wrapping", () => {
  const tabs = read("app/(app)/insights/_components/range-tabs.tsx");
  assert.match(tabs, /flex-nowrap gap-1\.5 overflow-x-auto/);
  assert.match(tabs, /shrink-0 whitespace-nowrap/);
});

test("Analytics calculates nothing itself and stays on the light token system", () => {
  assert.doesNotMatch(SECTIONS + PANEL + OBSERVATIONS, /supabase|\.from\(|\.rpc\(/);
  for (const source of [PAGE, SECTIONS, PANEL, OBSERVATIONS]) assert.doesNotMatch(source, /slate-|emerald-|bg-gradient|font-mono/);
});

// Internal names that must never reach the owner: field/table/event names,
// snake_case and camelCase identifiers, dotted paths, and provider names.
const INTERNAL_IDENTIFIER = /billingMetrics|collectedValue|pipelineValue|estimateValue|contractedJobValue|invoicedValue|leads\.source|sourceCounts|lead\.stage_changed|ai_interactions|\bn8n\b|\b[a-z]+_[a-z_]+\b|\b[a-z]+[A-Z][A-Za-z]*\b|\b[a-z]+\.[a-z][A-Za-z_]+\b/;

test("calculations footer: the period's data notes are owner-facing translations, never the snapshot's raw internal notes", () => {
  assert.doesNotMatch(SECTIONS, /dataQuality\.notes/, "the raw notes (read by the AI and agency code) are never rendered");
  assert.match(SECTIONS, /const dataNotes = ownerDataNotes\(snapshot\);/);
  for (const collectedRevenueUnavailable of [false, true]) {
    for (const stageHistoryUnavailable of [false, true]) {
      for (const aiTokenUsageUnavailable of [false, true]) {
        for (const [withHistory, inRange, withUsage, interactions] of [[3, 12, 4, 9], [1, 1, 1, 1], [0, 0, 0, 0]]) {
          const notes = ownerDataNotes({
            dataQuality: { collectedRevenueUnavailable, stageHistoryUnavailable, aiTokenUsageUnavailable, sourceAttributionLimited: true, notes: ["billingMetrics.collectedValue pipelineValue leads.source sourceCounts lead.stage_changed ai_interactions n8n"] },
            leadStageFunnel: { transitions: {} as never, timing: { leadsInRange: inRange, leadsWithRecordedHistory: withHistory, leadsWithQualifiedTiming: 0, averageTimeToQualifiedMs: null, medianTimeToQualifiedMs: null, leadsWithWonTiming: 0, averageTimeToWonMs: null, medianTimeToWonMs: null } },
            aiMetrics: { aiInteractions: interactions, customerAiInteractions: interactions, aiOutboundInteractions: 0, customerReplyAiInteractions: 0, aiNeedsHumanCount: 0, totalTokensUsed: null, averageTokensPerInteraction: null, interactionsWithUsageData: withUsage },
          });
          assert.equal(notes.length, 4);
          for (const note of notes) assert.doesNotMatch(note, INTERNAL_IDENTIFIER, note);
        }
      }
    }
  }
});

test("calculations footer: every static definition is plain English too", () => {
  const block = SECTIONS.slice(SECTIONS.indexOf("const DEFINITIONS"), SECTIONS.indexOf("];", SECTIONS.indexOf("const DEFINITIONS")));
  const definitions = [...block.matchAll(/(?:term|definition): (?:"([^"]*)"|`([^`]*)`)/g)].map((m) => (m[1] ?? m[2]).replace("${SANCTIONED_COLLECTED_REVENUE_DEFINITION}", SANCTIONED_COLLECTED_REVENUE_DEFINITION));
  assert.ok(definitions.length >= 30, `${definitions.length} terms and definitions found`);
  for (const text of definitions) assert.doesNotMatch(text, INTERNAL_IDENTIFIER, text);
  assert.match(block, /Estimate → job: accepted estimates that became a job\./);
});

test("Estimate → job is described as accepted estimates that became a job, and AI interactions shows the customer-facing count", () => {
  assert.match(SECTIONS, /label: "Estimate → job", value: formatRate\(estimateMetrics\.estimateToJobRate\), detail: "Accepted estimates that became a job"/);
  assert.match(SECTIONS, /label: "AI interactions", value: String\(aiMetrics\.customerAiInteractions\)/);
});

// ---------------------------------------------------------------------------
// Phase 2A: organization calendar, honest semantics, aging and leakage
// ---------------------------------------------------------------------------

test("Phase 2A: the page reads the organization timezone before its batch and passes it to every period-dependent read", () => {
  assert.match(PAGE, /const timeZone = \(await getOrganizationTimezone\(supabase, membership\.organizationId\)\) \?\? "UTC";[\s\S]*await Promise\.all\(\[/);
  assert.match(PAGE, /resolveDateRange\(range, now, timeZone\)/);
  assert.match(PAGE, /resolveDateRange\("last30Days", now, timeZone\)/);
  assert.match(PAGE, /getBusinessMetricsSnapshot\(supabase, membership\.organizationId, range, \{ timeZone, now \}\)/);
  assert.match(PAGE, /getLeadsCreatedPerDay\(supabase, membership\.organizationId, chartRange, timeZone\)/);
  assert.match(PAGE, /getActivityEntries\(supabase, membership\.organizationId, \{ query, entityType, from, to \}, limit, timeZone\)/);
  assert.match(PAGE, /timeZone=\{timeZone\}/, "the activity timeline gets it for headings and times");
});

test("Phase 2A: scheduling and leakage come from Analytics-only reads over the organization-calendar range", () => {
  assert.match(PAGE, /getAppointmentOccurrenceMetrics\(supabase, membership\.organizationId, resolvedRange\)/);
  assert.match(PAGE, /getOpportunityOutcomes\(supabase, membership\.organizationId, resolvedRange\)/);
  assert.match(PAGE, /<SchedulingPanel snapshot=\{snapshot\} occurrence=\{appointmentOccurrence\.metrics\} \/>/);
  assert.match(PAGE, /<PipelineLeaksPanel snapshot=\{snapshot\} outcomes=\{opportunityOutcomes\.groups\} \/>/);
  assert.match(PAGE, /appointmentOccurrence\.failed \|\| opportunityOutcomes\.failed/, "a failed new read is disclosed like any other");
  assert.match(SECTIONS, /const appointmentMetrics = occurrence;/);
  assert.match(SECTIONS, /Appointments by the day they take place, not the day they were booked\./);
});

test("Phase 2A: communication labels say exactly what is counted, with no duplicate", () => {
  assert.doesNotMatch(SECTIONS, /label: "Customer replies"|label: "Conversations opened"|label: "Conversations closed"|label: "Opted-out contacts"/);
  assert.match(SECTIONS, /label: "New conversations · still open"/);
  assert.match(SECTIONS, /label: "New conversations · now closed"/);
  assert.match(SECTIONS, /label: "New contacts who opted out"/);
});

test("Phase 2A: review and referral rates use the sent-request fields and show what was sent", () => {
  for (const field of ["reviewResponseRateOfSent", "reviewCompletionRateOfSent", "referralResponseRateOfSent", "referralConversionRateOfSent", "reviewsSent", "referralsSent"]) assert.match(SECTIONS, new RegExp(`reviewReferralMetrics\\.${field}`));
  assert.doesNotMatch(SECTIONS, /formatRate\(reviewReferralMetrics\.(reviewResponseRate|reviewCompletionRate|referralResponseRate|referralConversionRate)\)/);
});

test("Phase 2A: aging and leakage are surfaced with honest scopes - and nothing is called recovered", () => {
  assert.match(SECTIONS, /<PanelBlock label="Unpaid by age" scope="As of today">/);
  assert.match(SECTIONS, /<PanelBlock label="Estimates awaiting a decision" scope="By days since sent · as of today">/);
  assert.match(SECTIONS, /label: "Declined estimate value · All time", value: formatCurrency\(revenueOpportunity\.lostEstimateValue\)/);
  assert.match(SECTIONS, /<PanelBlock label=\{`Closed opportunities · \$\{periodScope\}`\}>/);
  assert.match(SECTIONS, /Dated when Trackpr noticed the change\./);
  assert.doesNotMatch(SECTIONS, /label: "[^"]*[Rr]ecovered[^"]*"/, "no metric claims money was recovered (Recoverable estimate value is a separate, pre-existing figure)");
});

test("Phase 2A guard: no caller outside Analytics passes a timezone or snapshot options - Agency, automation and dashboard behavior is unchanged", () => {
  const calls = (file: string, fn: string) => [...fs.readFileSync(path.join(ROOT, file), "utf8").matchAll(new RegExp(`${fn}\\(([^)]*)\\)`, "g"))].map((match) => match[1]);
  for (const file of ["lib/agency/usage.ts", "lib/agency/queries.ts", "lib/agency/revenue.ts", "lib/agency/cost-readiness.ts", "lib/agency/costs.ts", "lib/automation-health/health.ts", "lib/automation/queries.ts", "lib/dashboard/business-metrics.ts"]) {
    for (const args of calls(file, "resolveDateRange")) assert.ok(args.split(",").length <= 1, `${file}: resolveDateRange(${args}) must not pass a timezone`);
  }
  for (const [file, fn] of [["lib/dashboard/business-metrics.ts", "getBusinessMetricsSnapshot"], ["lib/agency/operations.ts", "getBusinessMetricsSnapshot"]] as const) {
    for (const args of calls(file, fn)) assert.equal(args.split(",").length, 3, `${file}: ${fn}(${args}) must not pass options`);
  }
  // The AI observations input never includes the new Analytics-only fields.
  const insights = read("lib/bi/insights.ts");
  assert.doesNotMatch(insights, /invoiceAging|estimateAging|reviewReferralMetrics/);
});

test("Phase 2B: jobs linked to a lead - one Analytics-only, all-time read in Estimates & jobs, with a plain-English definition", () => {
  assert.match(PAGE, /getJobLeadLinkage\(supabase, membership\.organizationId\)/);
  assert.match(PAGE, /jobLeadLinkage\.failed/, "a failed read is disclosed like any other");
  assert.match(PAGE, /<EstimatesJobsPanel snapshot=\{snapshot\} jobLeadLinkage=\{jobLeadLinkage\}/);
  assert.match(SECTIONS, /label: "Jobs linked to a lead", value: `\$\{jobLeadLinkage\.linked\} of \$\{jobLeadLinkage\.total\}`, detail: "All time"/);
  assert.match(SECTIONS, /term: "Jobs linked to a lead"/);
  // Analytics only: not in the AI input, Agency, Today/dashboard, or the snapshot.
  for (const file of ["lib/bi/insights.ts", "lib/bi/queries.ts", "lib/bi/types.ts", "lib/dashboard/business-metrics.ts", "lib/agency/operations.ts", "lib/agency/queries.ts"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, file), "utf8"), /getJobLeadLinkage|jobLeadLinkage/, file);
  }
  const users = execFileSync("git", ["grep", "-l", "getJobLeadLinkage"], { cwd: ROOT, encoding: "utf8" }).trim().split("\n").sort();
  assert.deepEqual(users.filter((file) => !file.endsWith(".test.ts")), ["app/(app)/insights/page.tsx", "lib/bi/metrics.ts"]);
});

test("Phase 2C: revenue by source and lead → job - one Analytics-only read over the organization-calendar range, inside Estimates & jobs", () => {
  assert.match(PAGE, /getRevenueAttribution\(supabase, membership\.organizationId, resolvedRange\)/);
  assert.match(PAGE, /revenueAttribution\.failed/, "a failed or over-ceiling read is disclosed");
  assert.match(PAGE, /<EstimatesJobsPanel snapshot=\{snapshot\} jobLeadLinkage=\{jobLeadLinkage\} attribution=\{revenueAttribution\}/);
  assert.match(SECTIONS, /<PanelBlock label="Revenue by source" scope=\{periodScope\}>/);
  assert.match(SECTIONS, /<PanelBlock label="Lead → job" scope=\{`Leads created · \$\{periodScope\}`\}>/);
  for (const header of ["Source", "Leads", "Jobs", "Completed", "Completed value"]) assert.match(SECTIONS, new RegExp(`>${header}</th>`));
  assert.match(SECTIONS, /overflow-x-auto/, "the table scrolls sideways on phones, never the page");
  assert.match(SECTIONS, /term: "Revenue by source"/);
  assert.match(SECTIONS, /term: "Lead → job"/);
  assert.doesNotMatch(SECTIONS, /label: "[^"]*[Rr]evenue[^"]*"/, "contracted job value is never labeled revenue as a figure");
  // Analytics only: not in the AI input, Agency, Today/dashboard, or the snapshot.
  for (const file of ["lib/bi/insights.ts", "lib/bi/queries.ts", "lib/bi/types.ts", "lib/bi/metrics.ts", "lib/dashboard/business-metrics.ts", "lib/agency/operations.ts", "lib/agency/queries.ts"]) {
    // Phase 2G: metrics.ts imports only the shared pager from revenue-attribution - never attribution data.
    const source = fs.readFileSync(path.join(ROOT, file), "utf8").replace('import { readAllPages } from "./revenue-attribution";', "");
    assert.doesNotMatch(source, /getRevenueAttribution|revenueAttribution|revenue-attribution/, file);
  }
});

test("Phase 2D: completed job value, estimate acceptance and lead → booking come from the Analytics-only outcome read; job completion stays creation-dated and says so", () => {
  assert.match(PAGE, /getOutcomeMetrics\(supabase, membership\.organizationId, resolvedRange\)/);
  assert.match(PAGE, /outcomeMetrics\.failed/, "a failed read is disclosed");
  assert.match(PAGE, /<EstimatesJobsPanel snapshot=\{snapshot\} jobLeadLinkage=\{jobLeadLinkage\} attribution=\{revenueAttribution\} outcomes=\{outcomeMetrics\}/);
  assert.match(SECTIONS, /label: "Completed job value", value: formatCurrency\(outcomes\.completedJobValue\)/);
  assert.match(SECTIONS, /label: "Lead → booking", value: formatRate\(outcomes\.leadToBookingRate\)/);
  assert.match(SECTIONS, /label: "Estimate acceptance", value: formatRate\(outcomes\.estimateAcceptanceRate\)/);
  assert.match(SECTIONS, /label: "Job completion", value: formatRate\(jobMetrics\.jobCompletionRate\), detail: "Jobs created in the period · completed vs\. completed \+ cancelled"/);
  assert.doesNotMatch(SECTIONS, /jobMetrics\.completedContractedJobValue|leadMetrics\.leadToBookingRate|estimateMetrics\.estimateAcceptanceRate/, "the creation-dated snapshot versions are no longer shown");
  assert.match(SECTIONS, /<PanelBlock label="Job status" scope="Created in the period">/);
  assert.match(SECTIONS, /<PanelBlock label="Estimate status" scope="Created in the period">/);
  assert.match(SECTIONS, /term: "Completed job value", definition: "Jobs marked complete in the selected period, by the date they were completed/);
  assert.match(SECTIONS, /Job completion: of the jobs created in the selected period[^"]*by creation date, because a cancellation date isn't recorded/);
  assert.match(SECTIONS, /Lead → booking: of the leads created in the selected period, those with at least one appointment that wasn't cancelled and wasn't a no-show/);
});

test("Phase 2D guard: the outcome read is Analytics-only - the snapshot, AI input, Agency and Today keep their own semantics", () => {
  for (const file of ["lib/bi/insights.ts", "lib/bi/queries.ts", "lib/bi/types.ts", "lib/bi/metrics.ts", "lib/dashboard/business-metrics.ts", "lib/agency/operations.ts", "lib/agency/queries.ts"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, file), "utf8"), /getOutcomeMetrics|outcome-metrics/, file);
  }
  const users = execFileSync("git", ["grep", "-l", "--untracked", "getOutcomeMetrics"], { cwd: ROOT, encoding: "utf8" }).trim().split("\n").sort();
  assert.deepEqual(users.filter((file) => !file.endsWith(".test.ts")), ["app/(app)/insights/page.tsx", "lib/bi/outcome-metrics.ts"]);
});

test("Phase 2E: Collected in Revenue by source - one Analytics-only read over the organization-calendar range, reconciled with Revenue & payments", () => {
  assert.match(PAGE, /getCashAttribution\(supabase, membership\.organizationId, resolvedRange\)/);
  assert.match(PAGE, /cashAttribution\.failed/, "a failed or over-ceiling read is disclosed");
  assert.match(PAGE, /<EstimatesJobsPanel snapshot=\{snapshot\} jobLeadLinkage=\{jobLeadLinkage\} attribution=\{revenueAttribution\} outcomes=\{outcomeMetrics\} cash=\{cashAttribution\} \/>/);
  for (const header of ["Source", "Leads", "Jobs", "Completed", "Completed value", "Collected"]) assert.match(SECTIONS, new RegExp(`>${header}</th>`));
  assert.match(SECTIONS, /withCollected\(attribution, cash\)/);
  assert.match(SECTIONS, /cash\.failed \? "-" : formatMoney\(value\)/, "a failed read shows no Collected figure, never a partial one");
  assert.match(SECTIONS, /Collected could not be read for this period\. Nothing is estimated in its place\./);
  assert.match(SECTIONS, /The Collected total is the same amount as Collected under Revenue & payments\./);
  assert.match(SECTIONS, /term: "Lead sources", definition: "Free text, not standardized - shown for visibility only, never ranked by performance\." \}/, "the ranking wording is unchanged");
  // Analytics only: not in the AI input, Agency, Today/dashboard, or the snapshot.
  for (const file of ["lib/bi/insights.ts", "lib/bi/queries.ts", "lib/bi/types.ts", "lib/bi/metrics.ts", "lib/dashboard/business-metrics.ts", "lib/agency/operations.ts", "lib/agency/queries.ts"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, file), "utf8"), /getCashAttribution|cashAttribution|cash-attribution/, file);
  }
  const users = execFileSync("git", ["grep", "-l", "--untracked", "getCashAttribution"], { cwd: ROOT, encoding: "utf8" }).trim().split("\n").sort();
  assert.deepEqual(users.filter((file) => !file.endsWith(".test.ts")), ["app/(app)/insights/page.tsx", "lib/bi/cash-attribution.ts"]);
});

test("Phase 2F: response-time and stage figures that couldn't be read show as unavailable, never as zeros; the AI is told not to cite an unavailable comparison", () => {
  // Response time: one "could not be read" line in place of its figures, no Contacted tile, no buckets - the message counts still show.
  assert.match(SECTIONS, /const unavailable = funnelUnavailable\.responseTime;/);
  assert.match(SECTIONS, /Response times could not be read for this period\. Nothing is estimated in its place\./);
  assert.match(SECTIONS, /const hasAnyResponse = !unavailable && responseTime\.leadsContacted > 0;/);
  assert.match(SECTIONS, /\.\.\.\(unavailable \? \[\] : \[\{ key: "contacted"/);
  // Stage transitions and timing: each tile unavailable on its own read's failure.
  assert.match(SECTIONS, /const unreadable = \{ value: "-", detail: "Couldn't be read for this period" \};/);
  for (const [flag, key] of [["stageTransitions", "to-qualified"], ["stageTransitions", "to-won"], ["stageTiming", "time-to-qualified"], ["stageTiming", "time-to-won"]]) {
    assert.match(SECTIONS, new RegExp(`funnelUnavailable\\.${flag}\\s*\\? \\{ key: "${key}", label: "[^"]+", \\.\\.\\.unreadable \\}`), key);
  }
  // An unavailable comparison never renders a badge.
  const { formatComparisonBadge }: typeof import("./_components/bi-format") = require(path.join(ROOT, "app/(app)/insights/_components/bi-format.ts"));
  assert.equal(formatComparisonBadge({ unavailable: true, current: null, previous: null, change: null, percentageChange: null }), null);
  // Owner note: unread history is never described as "no stage changes recorded".
  const timing = { leadsInRange: 5, leadsWithRecordedHistory: 0, leadsWithQualifiedTiming: 0, averageTimeToQualifiedMs: null, medianTimeToQualifiedMs: null, leadsWithWonTiming: 0, averageTimeToWonMs: null, medianTimeToWonMs: null };
  const notes = ownerDataNotes({
    dataQuality: { collectedRevenueUnavailable: false, stageHistoryUnavailable: true, aiTokenUsageUnavailable: true, sourceAttributionLimited: true, notes: [] },
    leadStageFunnel: { transitions: {} as never, timing },
    aiMetrics: { aiInteractions: 0, customerAiInteractions: 0, aiOutboundInteractions: 0, customerReplyAiInteractions: 0, aiNeedsHumanCount: 0, totalTokensUsed: null, averageTokensPerInteraction: null, interactionsWithUsageData: 0 },
    funnelUnavailable: { responseTime: false, stageTransitions: true, stageTiming: true },
  });
  assert.ok(notes.includes("Lead stage history couldn't be read for this period, so stage changes and timing show as unavailable rather than zero."));
  for (const note of notes) assert.doesNotMatch(note, INTERNAL_IDENTIFIER, note);
  // The AI prompt's rule for unavailable comparisons.
  assert.match(read("lib/bi/insights.ts"), /9b\. A comparison with "unavailable": true \(every figure in it null\) could not be read for this report\. Never cite it, describe a change from it, or treat it as zero\./);
  // Agency's partialData inputs are unchanged - funnelUnavailable never feeds it.
  assert.match(read("lib/bi/metrics.ts"), /const partialDataSourceCount = \[leadFailed, estimatesFailed, jobsFailed, appointmentsFailed, aiFailed, sharedLeadsFailed, transitionMetrics\.failed, timingMetrics\.failed, responseTimeMetrics\.failed, billingRows\.failed\]/);
});

test("Phase 2G: a leak figure whose read failed shows as unavailable - never 0 or $0 - on its own, turns on the banner and never feeds the Today link", () => {
  assert.match(SECTIONS, /revenueOpportunityUnavailable: unavailable/);
  assert.match(SECTIONS, /const unreadable = \{ value: "-", detail: "Couldn't be read for this period" \};/);
  for (const [flag, key] of [["estimates", "recoverable"], ["qualifiedNoAppointment", "qualified-no-appt"], ["visitsNoEstimate", "completed-no-estimate"], ["estimates", "declined-value"]]) {
    assert.match(SECTIONS, new RegExp(`unavailable\\.${flag}\\s*\\? \\{ key: "${key}", label: "[^"]+", \\.\\.\\.unreadable \\}`), key);
  }
  assert.match(SECTIONS, /\{unavailable\.estimates \? \(\s*<p className=\{metaClass\}>Estimates awaiting a decision could not be read for this period\. Nothing is estimated in its place\.<\/p>/);
  // The Review in Today link only counts figures that were read.
  assert.match(SECTIONS, /\(!unavailable\.qualifiedNoAppointment && revenueOpportunity\.qualifiedLeadsWithoutAppointment > 0\) \|\|\s*\(!unavailable\.visitsNoEstimate && revenueOpportunity\.completedAppointmentsWithoutEstimate > 0\) \|\|\s*\(!unavailable\.estimates && revenueOpportunity\.recoverableEstimateValue > 0\)/);
  // Any unavailable group turns on the page's existing banner.
  assert.match(PAGE, /snapshot\.partialData \|\| Object\.values\(snapshot\.revenueOpportunityUnavailable\)\.some\(Boolean\) \|\|/);
  // partialData's inputs (Agency's contract) are byte-identical to main, and the AI input never carries the new flags.
  const partialData = (source: string) => source.slice(source.indexOf("const partialDataSourceCount"), source.indexOf(".length;", source.indexOf("const partialDataSourceCount")));
  assert.equal(partialData(read("lib/bi/metrics.ts")), partialData(execFileSync("git", ["show", "87b47343a39695184992e2b5624e29639f95c5bb:lib/bi/metrics.ts"], { cwd: ROOT, encoding: "utf8" }).replace(/\/\/.*$/gm, "")));
  assert.doesNotMatch(read("lib/bi/insights.ts"), /revenueOpportunityUnavailable/);
  // The leak reads are paged, with no lead id list and no capped read left in them.
  const metrics = read("lib/bi/metrics.ts");
  // Phase 2-8 (M9): "Qualified, no appointment" and "Visits, no estimate" are read by countOpenOpportunities (Today's open rows).
  for (const fn of ["getLeadBookingCrossReference", "getEstimateOpportunityValues", "countOpenOpportunities"]) {
    const start = metrics.indexOf(`async function ${fn}(`);
    const body = metrics.slice(start, metrics.indexOf("\n}\n", start));
    assert.match(body, /readAllPages</, fn);
    assert.doesNotMatch(body, /\.limit\(|\.in\("lead_id"|\[\.\.\.leadIds\]\)/, fn);
  }
});

test("Phase 2I: a failed lead-source read shows the Lead sources block as unavailable - never an empty or partial list - and turns on the banner; lead and pipeline tiles keep the existing banner semantics", () => {
  assert.match(SECTIONS, /\{snapshot\.sourceCountsUnavailable \? \(/);
  assert.match(SECTIONS, /<SecondaryMetrics metrics=\{\[\{ key: "lead-sources", label: "By source", \.\.\.unreadable \}\]\} \/>/);
  assert.match(PAGE, /Object\.values\(snapshot\.revenueOpportunityUnavailable\)\.some\(Boolean\) \|\| snapshot\.sourceCountsUnavailable \|\|/);
  // No per-tile unavailable state for Leads, Open leads, Open lead value or Avg. open lead value in this phase.
  assert.match(SECTIONS, /\{ key: "open-leads", label: "Open leads", value: String\(pipelineMetrics\.openOpportunityCount\) \}/);
  assert.match(SECTIONS, /\{ key: "leads", label: "Leads", value: String\(comparisons\.leadCount\.current\), \.\.\.compared\(comparisons\.leadCount\) \}/);
  // The flag never reaches the AI input.
  assert.doesNotMatch(read("lib/bi/insights.ts"), /sourceCountsUnavailable/);
});

test("Phase 2J: message, conversation and opt-out figures whose read failed show as unavailable - never 0 - and turn on the banner; response times stay independent", () => {
  assert.match(SECTIONS, /const communicationValue = \(value: number\) => \(communicationUnavailable \? \{ value: "-", detail: "Couldn't be read for this period" \} : \{ value: String\(value\) \}\);/);
  for (const [key, field] of [["inbound", "inboundMessages"], ["outbound", "outboundMessages"], ["new-open", "conversationsOpened"], ["new-closed", "conversationsClosed"], ["opt-outs", "optOutCount"]]) {
    assert.match(SECTIONS, new RegExp(`\\{ key: "${key}", label: "[^"]+", \\.\\.\\.communicationValue\\(communicationMetrics\\.${field}\\) \\}`), key);
  }
  assert.match(SECTIONS, /\{communicationUnavailable \? \(\s*<p className=\{metaClass\}>Outbound messages could not be read for this period\. Nothing is estimated in its place\.<\/p>/);
  assert.match(SECTIONS, /const unavailable = funnelUnavailable\.responseTime;/, "the 2F response-time state is separate");
  assert.match(PAGE, /snapshot\.sourceCountsUnavailable \|\| snapshot\.communicationUnavailable \|\|/);
  assert.doesNotMatch(read("lib/bi/insights.ts"), /communicationUnavailable/, "the AI is told through a dataQuality note, not a new field");
});

test("Phase 2K: follow-up figures whose automation read failed show as unavailable - never 0 - and turn on the banner; Agency's detail shows the execution rows as Unavailable", () => {
  assert.match(SECTIONS, /const followUpValue = \(value: number\) => \(automationUnavailable \? \{ value: "-", detail: "Couldn't be read for this period" \} : \{ value: String\(value\) \}\);/);
  for (const [key, field] of [["lost-nurture", "lostLeadNurtureEvents"], ["reactivation", "reactivationEvents"], ["appointment-reminders", "appointmentReminderEvents"], ["estimate-followups", "estimateFollowUpEvents"], ["job-followups", "postJobFollowUpEvents"], ["leads-touched", "leadsTouchedByAutomation"]]) {
    assert.match(SECTIONS, new RegExp(`\\{ key: "${key}", label: "[^"]+", \\.\\.\\.followUpValue\\(followUpMetrics\\.${field}\\) \\}`), key);
  }
  // The AI-handled tiles come from ai_interactions, not the automation reads - unchanged.
  assert.match(SECTIONS, /\{ key: "interactions", label: "AI interactions", value: String\(aiMetrics\.customerAiInteractions\) \}/);
  assert.match(PAGE, /snapshot\.communicationUnavailable \|\| snapshot\.automationUnavailable \|\|/);
  assert.doesNotMatch(read("lib/bi/insights.ts"), /automationUnavailable/, "the AI is told through a dataQuality note, not a new field");
  const detail = read("app/agency/organizations/[id]/page.tsx");
  assert.match(detail, /\{org\.automationFailed \? \(\s*<>\s*\{\["Executions", "Completed", "Failed", "Running"\]\.map\(\(label\) => \(\s*<Row key=\{label\} label=\{label\} value="Unavailable" tone="warning" \/>/);
  assert.match(detail, /\{org\.automationFailed \? <Row label="Success rate" value="Unavailable" tone="warning" \/> :/);
  assert.match(detail, /<Row label="Stuck" value=\{formatCount\(orgHealth\.stuckExecutionCount\)\}/, "Stuck has its own read and stays real");
});

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
  assert.match(PAGE, /<LeadsConversionPanel\s+snapshot=\{snapshot\}\s+trend=\{<TrendSection/);
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

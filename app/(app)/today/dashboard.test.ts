/**
 * Trackpr 2.0 (step 2E) - Dashboard 2.0:
 *
 *   1. the wording model (greeting, attention line, briefing, Trackpr
 *      handled, today so far, pipeline stages) - composed only from values
 *      the page already loads;
 *   2. the page structure: section order, the unchanged data batch, no
 *      hardcoded figures, real actions, vertical behavior, mobile targets.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/(app)/today/dashboard.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const model: typeof import("./_components/dashboard-model") = require("./_components/dashboard-model.ts");

const ROOT = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), "utf8").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const PAGE = read("app/(app)/today/page.tsx");
const SECTIONS = read("app/(app)/today/_components/dashboard-sections.tsx");
const ROW = read("lib/ui/queue-row.tsx");

// ---------------------------------------------------------------------------
// 1. Wording model
// ---------------------------------------------------------------------------

test("greeting follows the hour, and the hour is read in the organization's timezone", () => {
  assert.equal(model.greetingForHour(0), "Good morning");
  assert.equal(model.greetingForHour(11), "Good morning");
  assert.equal(model.greetingForHour(12), "Good afternoon");
  assert.equal(model.greetingForHour(17), "Good afternoon");
  assert.equal(model.greetingForHour(18), "Good evening");
  const noonUtc = new Date("2026-09-29T12:00:00Z");
  assert.equal(model.hourInTimeZone(noonUtc, "UTC"), 12);
  assert.equal(model.hourInTimeZone(noonUtc, "America/Los_Angeles"), 5);
  assert.equal(model.hourInTimeZone(noonUtc, null), 12);
  assert.equal(model.hourInTimeZone(noonUtc, "Not/AZone"), 12, "an invalid zone falls back to UTC, never throws");
});

test("the attention line counts what needs the owner, and says so plainly when nothing does", () => {
  assert.equal(model.attentionLine(0), "Nothing needs you right now.");
  assert.equal(model.attentionLine(1), "1 thing needs your attention today.");
  assert.equal(model.attentionLine(7), "7 things need your attention today.");
});

const QUIET = { leadsReceivedToday: 0, appointmentsToday: 0, quotesOutCount: 0, quotesOutValue: "$0", readyToScheduleCount: 0, overdueCount: 0, overdueValue: "$0.00", conversationsWaiting: 0 };

test("briefing: a quiet day says only the true thing - no zero-count sentences", () => {
  assert.deepEqual(model.briefingLines(QUIET), ["No new leads have come in yet today."]);
});

test("briefing: every non-zero figure becomes one sentence, most useful first, with correct plurals", () => {
  assert.deepEqual(
    model.briefingLines({ leadsReceivedToday: 3, appointmentsToday: 1, quotesOutCount: 2, quotesOutValue: "$18,400", readyToScheduleCount: 1, overdueCount: 2, overdueValue: "$950.00", conversationsWaiting: 1 }),
    [
      "3 new leads came in today.",
      "You have 1 appointment today.",
      "1 conversation is waiting on your reply.",
      "2 estimates worth $18,400 are waiting on a decision.",
      "1 accepted estimate hasn't been scheduled yet.",
      "2 invoices ($950.00) are past due.",
    ],
  );
  assert.deepEqual(model.briefingLines({ ...QUIET, leadsReceivedToday: 1, quotesOutCount: 1, quotesOutValue: "$500" }), ["1 new lead came in today.", "1 estimate worth $500 is waiting on a decision."]);
});

test("briefing sentences carry no AI branding or technical wording", () => {
  const lines = model.briefingLines({ leadsReceivedToday: 3, appointmentsToday: 2, quotesOutCount: 2, quotesOutValue: "$1", readyToScheduleCount: 2, overdueCount: 1, overdueValue: "$1", conversationsWaiting: 2 });
  for (const line of lines) assert.doesNotMatch(line, /\bAI\b|automation incident|workflow|n8n|webhook/i, line);
});

test("Trackpr handled: nothing is claimed on a day with no activity; 'recommended', never 'sent'", () => {
  assert.deepEqual(model.handledItems({ aiInteractions: 0, customerReplyAiInteractions: 0, aiOutboundInteractions: 0, aiNeedsHumanCount: 0 }), []);
  const items = model.handledItems({ aiInteractions: 5, customerReplyAiInteractions: 3, aiOutboundInteractions: 2, aiNeedsHumanCount: 1 });
  assert.deepEqual(items.map((i) => [i.label, i.value, i.tone]), [
    ["Conversations handled", 5, "neutral"],
    ["Customer replies answered", 3, "neutral"],
    ["Messages recommended", 2, "neutral"],
    ["Handed to you", 1, "attention"],
  ]);
  assert.ok(!items.some((i) => /sent/i.test(i.label)), "aiOutboundInteractions counts recommendations before the outbound gate - never 'sent'");
  assert.equal(model.handledItems({ aiInteractions: 2, customerReplyAiInteractions: 1, aiOutboundInteractions: 1, aiNeedsHumanCount: 0 }).length, 3, "'Handed to you' only appears when something was");
});

test("today so far lists the end-of-day counts in business order", () => {
  assert.deepEqual(model.activityItems({ leadsReceived: 4, appointmentsBooked: 2, estimatesSent: 1, jobsWonOrCompleted: 3 }), [
    { label: "Leads received", value: 4 },
    { label: "Appointments booked", value: 2 },
    { label: "Estimates sent", value: 1 },
    { label: "Jobs won or completed", value: 3 },
  ]);
});

test("pipeline stages: five current-state stages, each linking to the page and filter that owns it", () => {
  const stages = model.pipelineStages(
    { hot_lead_count: 2, quotes_out_count: 3, ready_to_schedule_count: 1, won_not_finished_count: 4, outstanding_count: 1 },
    { openLeads: "$10", quotesOut: "$20", readyToSchedule: "$30", inProgress: "$40", outstanding: "$50.00" },
  );
  assert.deepEqual(stages.map((s) => [s.label, s.value, s.detail, s.href]), [
    ["Leads", "$10", "2 hot", "/people?temperature=hot"],
    ["Quoted", "$20", "3 estimates", "/estimates?status=sent"],
    ["Accepted", "$30", "1 to book", "/estimates?status=accepted"],
    ["In progress", "$40", "4 jobs", "/jobs?status=in_progress"],
    ["Unpaid", "$50.00", "1 invoice", "/money?browse=invoices&status=sent"],
  ]);
});

// ---------------------------------------------------------------------------
// 2. Page structure
// ---------------------------------------------------------------------------

test("hierarchy: needs attention, then revenue beside the briefing, then Trackpr handled and the pipeline, then today so far and insights", () => {
  const order = ["id=\"needs-attention\"", "id=\"revenue\"", "id=\"briefing\"", "id=\"handled\"", "id=\"pipeline\"", "id=\"activity\"", "id=\"insights\""].map((marker) => PAGE.indexOf(marker));
  assert.ok(order.every((index) => index > 0), `every section is present: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "sections appear in the approved order (also the mobile stacking order)");
  assert.match(PAGE, /<h1 className=\{pageTitleClass\}>\{greeting\}<\/h1>/);
});

test("data: the same single batch of reads - nothing added, the opportunity sync still scheduled inside it", () => {
  const batch = PAGE.slice(PAGE.indexOf("await Promise.all(["), PAGE.indexOf("]);", PAGE.indexOf("await Promise.all([")));
  const calls = [
    "getDashboardSqlData(supabase, membership.organizationId)",
    "getDashboardSummary(supabase, membership.organizationId)",
    "getCachedBusinessInsights(supabase, membership.organizationId)",
    "getContacts(supabase, membership.organizationId)",
    "getDashboardAiHandled(supabase, membership.organizationId)",
    "getOwnerDailyBriefing(supabase, membership.organizationId, briefingNow, { source: \"sql\" })",
    "getEndOfDaySummary(supabase, membership.organizationId, briefingNow, { source: \"sql\" })",
    "getOpenOpportunitiesResult(supabase, membership.organizationId)",
    "getPrioritizedOpportunities(supabase, membership.organizationId)",
    "getOrganizationTimezone(supabase, membership.organizationId)",
    "scheduleOpportunitySync(supabase, membership.organizationId)",
  ];
  for (const call of calls) assert.ok(batch.includes(call), `batch still contains ${call}`);
  assert.equal((batch.match(/\(supabase, membership\.organizationId/g) ?? []).length, calls.length, "no read was added to the batch");
  assert.equal((PAGE.match(/await /g) ?? []).length, 4, "only searchParams, the request client, the membership and the one batch are awaited");
  assert.doesNotMatch(PAGE, /\.from\(|\.rpc\(|getOrganizationHealth|getBusinessMetricsSnapshot/);
});

test("system health is not duplicated on the Dashboard - the top bar is its one home", () => {
  assert.doesNotMatch(PAGE, /SystemStatus|getOrganizationHealth|All systems/);
});

test("no hardcoded business figures anywhere in the Dashboard's presentation", () => {
  for (const [name, source] of [["page", PAGE], ["sections", SECTIONS], ["model", read("app/(app)/today/_components/dashboard-model.ts")]] as const) {
    assert.doesNotMatch(source, /["'`>]\s*\$\d/, `${name} contains a literal dollar figure`);
    assert.doesNotMatch(source, /Samuel|Johnson|Sarah|Mike/, `${name} contains an example name`);
  }
});

test("every money figure comes from the loaded summary through its existing formatter", () => {
  assert.match(PAGE, /value: formatMoney\(invoiceSummary\.collected\)/);
  assert.match(PAGE, /value: formatMoney\(invoiceSummary\.outstanding\)/);
  assert.match(PAGE, /value: formatMoney\(invoiceSummary\.invoiced\)/);
  assert.match(PAGE, /value: formatCurrency\(money\.knownOpportunityValue\)/);
  assert.match(PAGE, /quotesOutValue: formatCurrency\(summary\.data\.quotes_out_value\)/);
});

test("actions: every attention row, revenue figure and pipeline stage is a real link with a specific label", () => {
  assert.match(PAGE, /secondaryLabel=\{entry\.secondaryLabel\}/);
  assert.match(PAGE, /secondaryLabel="Review"/);
  assert.match(PAGE, /secondaryLabel: kind === "awaiting_reply" \? "Open conversation" : "View"/);
  assert.match(SECTIONS, /<Link\s+key=\{figure\.key\}\s+href=\{figure\.href\}/);
  assert.match(SECTIONS, /href=\{stage\.href\}/);
  assert.doesNotMatch(PAGE + SECTIONS, /Learn more/);
  assert.match(PAGE, /<ShowAllLink href="\/today\?all=1" count=\{totalNeedingAttention\} \/>/);
});

test("the Opportunities view (/today?view=by-type) still renders the full grouped list", () => {
  assert.match(PAGE, /return value === "by-type" \? "by-type" : "priority";/);
  assert.match(PAGE, /<OpportunitiesList opportunities=\{openOpportunities\} failed=\{opportunitiesResult\.failed\} \/>/);
});

test("vertical: the estimates/jobs/invoices pipeline only renders for a contractor organization", () => {
  assert.match(PAGE, /const showPipeline = membership\.vertical === "contractor";/);
  assert.match(PAGE, /\{showPipeline \? \(\s*<DashboardSection id="pipeline"/);
});

test("no AI branding in section headings - the business, not the technology", () => {
  const headings = [...PAGE.matchAll(/title="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(headings.length >= 5);
  for (const heading of headings) assert.doesNotMatch(heading, /\bAI\b/, heading);
});

test("mobile: rows, tabs, section links and revenue/pipeline cells keep a 44px touch target below sm", () => {
  assert.match(read("app/(app)/today/_components/today-view-tabs.tsx"), /min-h-11[^"]*sm:min-h-7/);
  assert.match(SECTIONS, /const LINK_CLASS =\s*"inline-flex min-h-11/);
  assert.match(SECTIONS, /group flex min-h-11 flex-col/);
  assert.match(SECTIONS, /flex min-h-11 items-center justify-between gap-3 px-4 py-3/);
  assert.match(ROW, /secondaryButtonSmallClass/, "the row's action uses the small tier, which is 44px below sm");
  assert.match(ROW, /className="-my-3 truncate py-3 [^"]*sm:my-0 sm:py-0"/, "the name link's tap area is 44px below sm (20px text + py-3)");
  assert.match(read("lib/ui/form.ts"), /const SIZE_SM = "min-h-11/);
});

test("the attention row states its tone in words beside a dot, never color alone", () => {
  assert.match(ROW, /<StatusDot tone=\{DOT_TONE\[tone\]\} \/>\s*\{problemLabel\}/);
  assert.match(ROW, /aria-label=\{`Call \$\{personName\}`\}/);
});

test("the Dashboard sits at the shared content width, on the light token system", () => {
  assert.match(PAGE, /<PageContainer>/);
  for (const source of [PAGE, SECTIONS, ROW]) assert.doesNotMatch(source, /slate-|emerald-|bg-gradient|font-mono/);
});

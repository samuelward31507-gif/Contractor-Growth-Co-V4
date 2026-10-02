/**
 * Today - the "right now" page:
 *
 *   1. the wording model (greeting, attention line, today's figures,
 *      conversations waiting, Trackpr handled, where the work stands) -
 *      composed only from values the page already loads;
 *   2. the page structure: section order, the data batch, no historical
 *      figures, no hardcoded figures, real actions, vertical behavior,
 *      mobile targets.
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

test("conversations waiting: counts the awaiting_reply attention items only, and discloses the attention read's cap", () => {
  const items = (kinds: string[]) => kinds.map((kind) => ({ kind }));
  assert.deepEqual(model.conversationsWaitingCount(items([])), { count: 0, capped: false });
  assert.deepEqual(model.conversationsWaitingCount(items(["awaiting_reply", "abandoned_conversation", "human_escalation", "awaiting_reply"])), { count: 2, capped: false }, "only conversations whose last message is the customer's count - not escalations or stalled outreach");
  assert.deepEqual(model.conversationsWaitingCount(items(Array(5).fill("awaiting_reply"))), { count: 5, capped: true });
  assert.equal(model.CONVERSATION_ATTENTION_CAP, 5, "matches dashboard_conversation_attention's own rn <= 5");
});

test("today figures: new leads, appointments and conversations waiting - each linking to where it is handled", () => {
  const quiet = model.todayFigures({ leadsReceivedToday: 0, appointmentsToday: 0, conversationsWaiting: { count: 0, capped: false } });
  assert.deepEqual(quiet.map((f) => [f.label, f.value, f.detail, f.href, f.tone]), [
    ["New leads", "0", "None yet today", "/people", undefined],
    ["Appointments", "0", "Nothing booked today", "/schedule", undefined],
    ["Waiting on your reply", "0", "No customer is waiting", "/conversations", undefined],
  ]);
  const busy = model.todayFigures({ leadsReceivedToday: 3, appointmentsToday: 1, conversationsWaiting: { count: 1, capped: false } });
  assert.deepEqual(busy.map((f) => [f.value, f.detail]), [["3", "Came in today"], ["1", "On the calendar today"], ["1", "1 conversation"]]);
  assert.equal(busy[2].tone, "attention");
  const capped = model.todayFigures({ leadsReceivedToday: 0, appointmentsToday: 0, conversationsWaiting: { count: 5, capped: true } });
  assert.deepEqual([capped[2].value, capped[2].detail], ["5+", "5 or more conversations"], "a capped count is never shown as an exact 5");
});

test("Trackpr handled: one line from the customer-facing AI count, nothing claimed on a quiet day, 'handled' never 'sent'", () => {
  assert.equal(model.handledLine({ customerAiInteractions: 0, aiNeedsHumanCount: 0 }), "Trackpr hasn't handled any conversations yet today.");
  assert.equal(model.handledLine({ customerAiInteractions: 1, aiNeedsHumanCount: 0 }), "Trackpr handled 1 conversation today.");
  assert.equal(model.handledLine({ customerAiInteractions: 5, aiNeedsHumanCount: 2 }), "Trackpr handled 5 conversations today · handed 2 to you.");
  assert.doesNotMatch(model.handledLine({ customerAiInteractions: 5, aiNeedsHumanCount: 2 }), /sent/i);
  assert.match(read("app/(app)/today/_components/dashboard-model.ts"), /Pick<BiAiMetrics, "customerAiInteractions" \| "aiNeedsHumanCount">/, "never the all-interactions count, which includes the owner's observations reports");
});

const SUMMARY = { hot_lead_count: 2, quotes_out_count: 3, ready_to_schedule_count: 1, won_not_finished_count: 4, outstanding_count: 1, not_yet_invoiced_count: 2, not_yet_invoiced_unknown_count: 0 };
const VALUES = { openLeads: "$10", quotesOut: "$20", readyToSchedule: "$30", inProgress: "$40", readyToInvoice: "$45.00", outstanding: "$50.00" };

test("where the work stands: six current-state stages, each linking to the page and filter that owns it", () => {
  const stages = model.pipelineStages(SUMMARY, VALUES, { count: 0, value: "$0.00" });
  assert.deepEqual(stages.map((s) => [s.label, s.value, s.detail, s.href, s.tone]), [
    ["Leads", "$10", "2 hot", "/people?temperature=hot", undefined],
    ["Quoted", "$20", "3 estimates", "/estimates?status=sent", undefined],
    ["Accepted", "$30", "1 to book", "/estimates?status=accepted", undefined],
    ["In progress", "$40", "4 jobs", "/jobs?status=in_progress", undefined],
    ["Ready to invoice", "$45.00", "2 completed jobs", "/money?browse=jobs&status=completed", undefined],
    ["Unpaid", "$50.00", "1 invoice", "/money?browse=invoices&status=sent", undefined],
  ]);
  const unknown = model.pipelineStages({ ...SUMMARY, not_yet_invoiced_unknown_count: 1 }, VALUES, { count: 0, value: "$0.00" });
  assert.equal(unknown[4].detail, "2 completed jobs · 1 with no amount", "jobs with no amount are disclosed, not silently left out of the value");
});

test("Unpaid is the one money-owed figure; anything past due is its secondary detail and links to the overdue filter", () => {
  const unpaid = model.pipelineStages(SUMMARY, VALUES, { count: 2, value: "$950.00" })[5];
  assert.deepEqual([unpaid.label, unpaid.value, unpaid.detail, unpaid.href, unpaid.tone], ["Unpaid", "$50.00", "$950.00 past due · 2 invoices", "/money?browse=invoices&status=overdue", "attention"]);
});

// ---------------------------------------------------------------------------
// 2. Page structure
// ---------------------------------------------------------------------------

test("hierarchy: the three acts - what happened, what needs attention, what opportunity exists (opportunities, then where the work stands) - nothing historical", () => {
  const order = ["id=\"today\"", "id=\"needs-attention\"", "id=\"opportunities\"", "id=\"pipeline\""].map((marker) => PAGE.indexOf(marker));
  assert.ok(order.every((index) => index > 0), `every section is present: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "sections appear in the approved order (also the mobile stacking order)");
  assert.match(PAGE, /<h1 className=\{pageTitleClass\}>\{greeting\}<\/h1>/);
  for (const removed of ["id=\"revenue\"", "id=\"briefing\"", "id=\"handled\"", "id=\"activity\"", "id=\"insights\""]) assert.ok(!PAGE.includes(removed), `${removed} is gone from Today`);
});

test("historical figures live on Analytics, not Today: no all-time Collected/Invoiced, no opportunity total, no cached observations", () => {
  assert.doesNotMatch(PAGE + SECTIONS, /invoiceSummary\.collected|invoiceSummary\.invoiced\b|knownOpportunityValue|dashboardMoneyCounts/);
  assert.doesNotMatch(PAGE + SECTIONS, /getCachedBusinessInsights|InsightsBody|GenerateInsightsButton|RevenuePanel|activityItems/);
  assert.doesNotMatch(PAGE, /"Open opportunities"|label: "Collected"|label: "Invoiced"/);
});

test("conversations waiting come from the awaiting_reply attention items, not the AI-off escalation count", () => {
  assert.match(PAGE, /conversationsWaiting: conversationsWaitingCount\(data\.attentionItems\)/);
  assert.doesNotMatch(PAGE, /aiEscalationsCount/);
});

test("data: the organization timezone first, then one batch of reads sharing the organization's day - nothing else added, the opportunity sync still scheduled inside it", () => {
  const batch = PAGE.slice(PAGE.indexOf("await Promise.all(["), PAGE.indexOf("]);", PAGE.indexOf("await Promise.all([")));
  const calls = [
    "getDashboardSqlData(supabase, membership.organizationId)",
    "getDashboardSummary(supabase, membership.organizationId, briefingNow, dayBounds)",
    "getContacts(supabase, membership.organizationId)",
    "getDashboardAiHandled(supabase, membership.organizationId, dayBounds)",
    "getOwnerDailyBriefing(supabase, membership.organizationId, briefingNow, { source: \"sql\", dayBounds })",
    "getEndOfDaySummary(supabase, membership.organizationId, briefingNow, { source: \"sql\", dayBounds })",
    "getOpenOpportunitiesResult(supabase, membership.organizationId)",
    "getPrioritizedOpportunities(supabase, membership.organizationId)",
    "scheduleOpportunitySync(supabase, membership.organizationId)",
  ];
  for (const call of calls) assert.ok(batch.includes(call), `batch still contains ${call}`);
  assert.equal((batch.match(/\(supabase, membership\.organizationId/g) ?? []).length, calls.length, "no read was added to the batch");
  assert.match(PAGE, /const timeZone = await getOrganizationTimezone\(supabase, membership\.organizationId\);[\s\S]*const dayBounds = organizationDayBounds\(briefingNow, timeZone \?\? "UTC"\);[\s\S]*await Promise\.all\(\[/, "the timezone is read before the batch so every day-scoped read uses the organization's day");
  assert.equal((PAGE.match(/await /g) ?? []).length, 5, "only searchParams, the request client, the membership, the timezone and the one batch are awaited");
  assert.doesNotMatch(PAGE, /\.from\(|\.rpc\(|getOrganizationHealth|getBusinessMetricsSnapshot/);
});

test("system health is not duplicated on Today - the top bar is its one home", () => {
  assert.doesNotMatch(PAGE, /SystemStatus|getOrganizationHealth|All systems/);
});

test("no hardcoded business figures anywhere in Today's presentation", () => {
  for (const [name, source] of [["page", PAGE], ["sections", SECTIONS], ["model", read("app/(app)/today/_components/dashboard-model.ts")]] as const) {
    assert.doesNotMatch(source, /["'`>]\s*\$\d/, `${name} contains a literal dollar figure`);
    assert.doesNotMatch(source, /Samuel|Johnson|Sarah|Mike/, `${name} contains an example name`);
  }
});

test("every money figure comes from the loaded summary through its existing formatter", () => {
  assert.match(PAGE, /outstanding: formatMoney\(invoiceSummary\.outstanding\)/);
  assert.match(PAGE, /readyToInvoice: formatMoney\(invoiceSummary\.notYetInvoicedKnownValue\)/);
  assert.match(PAGE, /\{ count: invoiceSummary\.overdueCount, value: formatMoney\(invoiceSummary\.overdue\) \}/);
  assert.match(PAGE, /quotesOut: formatCurrency\(summary\.data\.quotes_out_value\)/);
});

test("actions: every attention row, today figure and pipeline stage is a real link with a specific label", () => {
  assert.match(PAGE, /secondaryLabel=\{entry\.secondaryLabel\}/);
  assert.match(PAGE, /secondaryLabel="Review"/);
  assert.match(PAGE, /secondaryLabel: kind === "awaiting_reply" \? "Open conversation" : "View"/);
  assert.match(SECTIONS, /<Link\s+key=\{figure\.key\}\s+href=\{figure\.href\}/);
  assert.match(SECTIONS, /href=\{stage\.href\}/);
  assert.match(PAGE, /<SectionLink href="\/money">Open Money<\/SectionLink>/, "the money-owed figure keeps its way into Money");
  assert.doesNotMatch(PAGE + SECTIONS, /Learn more/);
  assert.match(PAGE, /<ShowAllLink href="\/today\?all=1" count=\{totalNeedingAttention\} \/>/);
});

test("attention and opportunity split the existing priority order by tier - nothing re-detected - and one attention count drives the header, Act II and \"You're all caught up\"", () => {
  assert.match(PAGE, /const OPPORTUNITY_TIERS: ReadonlySet<PriorityTier> = new Set\(\["recoverable", "growth"\]\);/);
  assert.match(PAGE, /const queue: QueueEntry\[\] = priorityQueue\.filter\(\(item\) => !OPPORTUNITY_TIERS\.has\(item\.tier\)\)\.map\(priorityItemToQueueEntry\);/);
  assert.match(PAGE, /const opportunityQueue: QueueEntry\[\] = priorityQueue\.filter\(\(item\) => OPPORTUNITY_TIERS\.has\(item\.tier\)\)\.map\(priorityItemToQueueEntry\);/);
  assert.match(PAGE, /const totalNeedingAttention = operationalExceptions\.length \+ queue\.length;/);
  assert.match(PAGE, /attentionLine\(totalNeedingAttention\)/);
  assert.match(PAGE, /\{totalNeedingAttention === 0 \? \(\s*<div className="px-5 py-10 text-center">\s*<p className="text-sm font-medium text-ink">You&apos;re all caught up\.<\/p>/);
  assert.equal((PAGE.match(/You&apos;re all caught up/g) ?? []).length, 1, "one caught-up state, in Act II");
  const attention = PAGE.slice(PAGE.indexOf('id="needs-attention"'), PAGE.indexOf('id="opportunities"'));
  assert.doesNotMatch(attention, /TodayViewTabs|OpportunitiesList/, "the attention act has no tabs to hunt through");
});

test("the Opportunities view (/today?view=by-type#opportunities) still renders the full grouped list, inside the third act", () => {
  assert.match(PAGE, /<DashboardSection id="opportunities" title="Opportunities" action=\{<TodayViewTabs active=\{view\} opportunityCount=\{openOpportunities\.length\} \/>\}>/);
  assert.match(read("app/(app)/today/_components/today-view-tabs.tsx"), /href: "\/today#opportunities"[\s\S]*href: "\/today\?view=by-type#opportunities"/);
  assert.match(PAGE, /<ShowAllLink href="\/today\?view=by-type#opportunities" count=\{openOpportunities\.length\} \/>/);
  assert.match(PAGE, /return value === "by-type" \? "by-type" : "priority";/);
  assert.match(PAGE, /<OpportunitiesList opportunities=\{openOpportunities\} failed=\{opportunitiesResult\.failed\} \/>/);
});

test("vertical: the estimates/jobs/invoices pipeline only renders for a contractor organization", () => {
  assert.match(PAGE, /const showPipeline = membership\.vertical === "contractor";/);
  assert.match(PAGE, /\{showPipeline \? \(\s*<DashboardSection id="pipeline"/);
});

test("no AI branding in section headings - the business, not the technology", () => {
  const headings = [...PAGE.matchAll(/title="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(headings.length >= 2, "Today and Where the work stands carry static titles");
  for (const heading of headings) assert.doesNotMatch(heading, /\bAI\b/, heading);
});

test("mobile: rows, tabs, section links and today/pipeline cells keep a 44px touch target below sm", () => {
  assert.match(read("app/(app)/today/_components/today-view-tabs.tsx"), /min-h-11[^"]*sm:min-h-7/);
  assert.match(SECTIONS, /const LINK_CLASS =\s*"inline-flex min-h-11/);
  assert.match(SECTIONS, /flex min-h-11 items-center justify-between gap-3 bg-surface px-4 py-3/, "today figures");
  assert.match(SECTIONS, /flex min-h-11 items-center justify-between gap-3 px-4 py-3 transition/, "pipeline stages");
  assert.match(ROW, /secondaryButtonSmallClass/, "the row's action uses the small tier, which is 44px below sm");
  assert.match(ROW, /className="-my-3 truncate py-3 [^"]*sm:my-0 sm:py-0"/, "the name link's tap area is 44px below sm (20px text + py-3)");
  assert.match(read("lib/ui/form.ts"), /const SIZE_SM = "min-h-11/);
});

test("the attention row states its tone in words beside a dot, never color alone", () => {
  assert.match(ROW, /<StatusDot tone=\{DOT_TONE\[tone\]\} \/>\s*\{problemLabel\}/);
  assert.match(ROW, /aria-label=\{`Call \$\{personName\}`\}/);
});

test("Today sits at the shared content width, on the light token system", () => {
  assert.match(PAGE, /<PageContainer>/);
  for (const source of [PAGE, SECTIONS, ROW]) assert.doesNotMatch(source, /slate-|emerald-|bg-gradient|font-mono/);
});

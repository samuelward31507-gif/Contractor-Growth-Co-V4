/**
 * Founder Intelligence wiring - verified against source (no DOM test
 * environment here); the engine's behavior is in lib/founder/intelligence.test.ts.
 * Covers: the engine is read-only and model-free, the home page is built from
 * one owner-scoped briefing with each record in one place, the calendar
 * deep link only opens the founder's own loaded items, and the review
 * summary reads only what the records confirm.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test app/founder/intelligence.structural.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8");
const ENGINE = read("lib/founder/intelligence.ts");
// Code only: the header comment explains (in words) why no model is used.
const ENGINE_CODE = ENGINE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const HOME = read("app/founder/page.tsx");
const REVIEW = read("app/founder/review/page.tsx");
const CAL_PAGE = read("app/founder/calendar/page.tsx");
const CAL_VIEW = read("app/founder/_components/calendar-view.tsx");
const RECS = read("app/founder/_components/recommendations.tsx");

test("the engine is pure: no database, no network, no model, no writes, no clock of its own", () => {
  assert.ok(ENGINE_CODE.includes("export function buildFounderBriefing"));
  assert.doesNotMatch(ENGINE_CODE, /supabase|\.from\(|\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(/);
  assert.doesNotMatch(ENGINE_CODE, /fetch\(|anthropic|openai|process\.env/i);
  assert.doesNotMatch(ENGINE_CODE, /"use server"|"use client"/);
  assert.doesNotMatch(ENGINE_CODE, /new Date\(\)|Date\.now\(\)/, "time comes in as `now` / `generatedAt` so output is deterministic");
  assert.doesNotMatch(ENGINE_CODE, /Math\.random/);
});

test("home: one briefing from the founder's own data decides every section", () => {
  assert.match(HOME, /await requireFounderPage\(\)/);
  for (const q of ["getFounderItems(supabase, userId, since)", "getFounderDeals(supabase, userId)", "getFounderMrrEntries(supabase, userId)", "getFounderFocus(supabase, userId, todayKey, todayKey)", "getFounderDealActivities(supabase, userId)", "getFounderHandoffs(supabase, userId)"]) assert.ok(HOME.includes(q), q);
  assert.match(HOME, /buildFounderBriefing\(\{ items, deals, focus, now, timeZone, todayKey, prioritiesAvailable: focusResult\.ok && focusResult\.data\.available, generatedAt: now\.toISOString\(\), salesHistory, handoffs \}\)/);
  assert.doesNotMatch(HOME, /plan\.attention|buildDailyPlan/, "attention comes only from the briefing (already de-duplicated)");
  assert.match(HOME, /const otherRecommendations = briefing\.recommended_actions\.slice\(1\);/, "the best next action isn't repeated in the list");
  assert.match(HOME, /briefing\.needs_attention\.filter/);
  assert.doesNotMatch(HOME, /from "\.\/actions"|from "@\/app\/founder\/actions"/, "the page itself never writes");
});

test("home: layout order - greeting and workload, next best action, then priorities first in the grid", () => {
  assert.match(HOME, /<PageHeader eyebrow=\{formatDateKey\(todayKey\)\} title=\{briefing\.greeting\} description=\{itemsResult\.ok \? briefing\.workload\.summary/);
  const order = ["<NextBestAction", 'aria-label="Quick actions"', 'aria-label="Summary"', 'id="priorities"', 'title="Today"', 'title="Recommended next"', 'title="Needs attention"', 'title="Worth checking"', 'title="Coming up"'];
  const positions = order.map((s) => HOME.indexOf(s));
  positions.forEach((p, i) => assert.ok(p > 0, `${order[i]} present`));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), "sections appear in briefing order (and on a phone)");
});

test("home: loading, error and empty states are honest", () => {
  assert.ok(fs.existsSync(path.join(process.cwd(), "app/founder/loading.tsx")));
  assert.ok(fs.existsSync(path.join(process.cwd(), "app/founder/error.tsx")));
  assert.match(HOME, /<LoadFailed what="Your tasks and events" \/>/);
  assert.match(HOME, /<LoadFailed what="Your deals" \/>/);
  assert.match(HOME, /const briefingReady = itemsResult\.ok && dealsResult\.ok;/);
  assert.match(HOME, /\{briefingReady \? <NextBestAction action=\{briefing\.best_next_action\} coverage=\{coverage\} \/> : null\}/, "no 'nothing pressing' claim when data failed to load");
  assert.match(HOME, /!briefingReady \? null : briefing\.needs_attention\.length === 0/);
  assert.match(RECS, /Nothing is pressing: \{coverage\.checked\}\./, "the all-clear names only what was checked");
  assert.doesNotMatch(RECS, /every open deal has a next step\./, "no fixed all-clear sentence");
});

test("home: sales history and handoffs are named when they fail, and say what wasn't checked otherwise", () => {
  assert.match(HOME, /<LoadFailed what="Your sales history" \/>/);
  assert.match(HOME, /<LoadFailed what="Your client handoffs" \/>/);
  assert.match(HOME, /if \(!result\.ok\) return \{ status: "failed" \};\s*return result\.data\.available \? \{ status: "loaded", data: pick\(result\.data\) \} : \{ status: "unavailable" \};/, "a missing table is 'unavailable', an error is 'failed' - neither is an empty list");
  assert.match(HOME, /const coverage = coverageStatement\(briefing\.coverage\);/);
  assert.match(HOME, /coverage\.notChecked\.length \? ` Not checked: \$\{coverage\.notChecked\.join\("; "\)\}\.` : null/);
  assert.match(RECS, /Not checked: \{coverage\.notChecked\.join\("; "\)\}\./);
});

test("home stays read-only and apart from Finance: no finance reads, no writes, no new data paths", () => {
  assert.doesNotMatch(HOME, /finance|stripe|\.rpc\(|\.from\(/i, "Finance signals aren't part of this phase; reads go through lib/founder/queries");
  assert.doesNotMatch(ENGINE_CODE, /finance/i);
  const queries = read("lib/founder/queries.ts");
  assert.match(queries, /from\("founder_deal_activities"\)\.select\(ACTIVITY_COLUMNS\)\.eq\("owner_id", ownerId\)/, "the founder's own history only");
  assert.match(queries, /from\("agency_client_handoffs"\)\.select\(HANDOFF_COLUMNS\)\.eq\("founder_owner_id", ownerId\)/, "the founder's own handoffs only");
});

test("recommendations: a server component of links; the suggestion is always labelled", () => {
  assert.doesNotMatch(RECS, /"use client"|actions/);
  assert.match(RECS, /<span className="font-medium text-ink-2">Suggestion:<\/span> \{text\}/);
  assert.match(RECS, /<Link href=\{action\.href\}/);
  assert.match(RECS, /<Link href=\{rec\.href\}/);
});

test("calendar ?item= opens only an item among the founder's own loaded items", () => {
  assert.match(CAL_PAGE, /const requestedItem = typeof params\.item === "string" \? params\.item : null;/);
  assert.match(CAL_PAGE, /itemsResult\.ok && requestedItem && \[\.\.\.itemsResult\.data\.inRange, \.\.\.itemsResult\.data\.unscheduled\]\.some\(\(item\) => item\.id === requestedItem\) \? requestedItem : null/);
  assert.match(CAL_PAGE, /initialItemId=\{openItemId\}/);
  assert.match(CAL_PAGE, /key=\{openItemId \?\? "calendar"\}/, "a new deep link re-opens even when the view stays mounted");
  assert.match(CAL_VIEW, /useState<FounderItem \| null>\(\(\) => \(initialItemId \? \(\[\.\.\.items, \.\.\.unscheduled\]\.find/);
});

test("review: a factual day summary, shown only when everything it counts has loaded", () => {
  assert.match(REVIEW, /buildEndOfDaySummary\(\{ items, deals, focus: focusResult\.ok \? focusResult\.data\.focus : \[\], dayKey: requested, timeZone \}\)/);
  assert.match(REVIEW, /\{itemsResult\.ok && dealsResult\.ok && focusResult\.ok \? \(/);
  assert.match(REVIEW, /\{summary\.sentence\}/);
});

test("no delivery channels or 'viewed' writes were added", () => {
  for (const src of [ENGINE_CODE, HOME, REVIEW, RECS]) {
    assert.doesNotMatch(src, /sendEmail|sendSms|twilio|resend|webpush|notification/i);
    assert.doesNotMatch(src, /viewed_at|last_viewed|markViewed/i);
  }
});

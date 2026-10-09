/**
 * Founder sales OS wiring - verified against source (no DOM test environment
 * here). Behavior is in lib/founder/sales.test.ts and app/founder/actions.test.ts;
 * the database rules (append-only history, stage guard, owner scoping,
 * stale/duplicate handling, rollback) in
 * supabase/pending/scratch/validate-founder-sales-os.mjs.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test app/founder/sales.structural.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8");
const PAGE = read("app/founder/deals/page.tsx");
const QUERIES = read("lib/founder/queries.ts");
const SALES = read("lib/founder/sales.ts");
const DIALOGS = read("app/founder/_components/sales-dialogs.tsx");
const DEAL_DIALOG = read("app/founder/_components/deal-dialog.tsx");
const CONTROLS = read("app/founder/_components/deal-controls.tsx");
const PANELS = read("app/founder/_components/sales-panels.tsx");
const TIMELINE = read("app/founder/_components/activity-timeline.tsx");
const MIGRATION = read("supabase/pending/founder_sales_os.sql");
const ROLLBACK = read("supabase/pending/founder_sales_os_rollback.sql");

test("deals page: founder-gated, owner-scoped, bounded reads; history failure shown as an error, not as 'nothing recorded'", () => {
  assert.match(PAGE, /await requireFounderPage\(\)/);
  assert.match(PAGE, /getFounderDealActivities\(supabase, userId\)/);
  assert.match(QUERIES, /from\("founder_deal_activities"\)\.select\(ACTIVITY_COLUMNS\)\.eq\("owner_id", ownerId\)/);
  assert.match(QUERIES, /\.limit\(limit \+ 1\)/);
  assert.match(QUERIES, /export const MAX_ACTIVITIES = 5000;/);
  assert.match(PAGE, /<LoadFailed what="Your sales history" \/>/);
  assert.match(PAGE, /\{focused \|\| !activitiesResult\.ok \? null : <SalesMetricsPanel/, "no metrics are shown from a failed read");
});

test("sales logic is pure and evidence-only: no I/O, no clock of its own, no payment data", () => {
  const code = SALES.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /supabase|fetch\(|process\.env|new Date\(\)|Date\.now\(\)|Math\.random/);
  assert.doesNotMatch(code, /revenue_events|stripe|invoice|customer_payments/i, "won terms are contracted; collected money is a separate domain");
  assert.doesNotMatch(code, /"paid"|payment_received/);
});

test("dialogs: one request id per open form, the loaded version sent, wins labelled as contracted (not paid)", () => {
  for (const src of [DIALOGS]) {
    assert.match(src, /const \[requestId\] = useState\(\(\) => crypto\.randomUUID\(\)\);/);
    assert.match(src, /expectedUpdatedAt: deal\.updatedAt/);
  }
  assert.match(DIALOGS, /This is contracted revenue, not a payment - nothing here marks money as received\./);
  assert.match(DIALOGS, /name="wonOn" type="date" required max=\{todayKey\}/);
  assert.match(DIALOGS, /name="occurredAt" type="datetime-local" required max=\{nowLocal\}/, "the form itself won't offer a future time");
  assert.match(DIALOGS, /Also move the deal to \{DEAL_STAGE_LABELS\[suggestion\]\}/, "the stage move is visible and optional");
  assert.match(DEAL_DIALOG, /const \[clientId\] = useState\(\(\) => crypto\.randomUUID\(\)\);/);
  assert.match(DEAL_DIALOG, /updateFounderDeal\(deal\.id, \{ \.\.\.fields, expectedUpdatedAt: deal\.updatedAt \}\)/);
  assert.match(DEAL_DIALOG, /\{deal \? null : \(/, "the stage is only chosen when creating");
  assert.doesNotMatch(DEAL_DIALOG, /wonSetupFee|wonAmount|lostReason/, "outcomes are never edited in the details form");
});

test("controls: won, lost and reopening always go through a dialog; open moves carry a fresh request id and the version", () => {
  assert.match(CONTROLS, /if \(next === "won" \|\| next === "lost" \|\| !isOpenDeal\(deal\)\) setChangingTo\(next\);/);
  assert.match(CONTROLS, /changeFounderDealStage\(deal\.id, \{ toStage: next, requestId: crypto\.randomUUID\(\), expectedUpdatedAt: deal\.updatedAt \}\)/);
  assert.match(CONTROLS, /disabled=\{isPending\}/, "no second move while one is saving");
});

test("timeline and metrics: voids are reasoned and visible; snapshot kept apart from measured conversion", () => {
  assert.match(TIMELINE, /!voided && !isStageKind\(a\.kind\)/, "stage history can't be voided from the UI");
  assert.match(TIMELINE, /disabled=\{isPending \|\| !reason\.trim\(\)\}/);
  assert.match(TIMELINE, /Voided: \{a\.voidReason\}/);
  assert.match(PANELS, /Pipeline now \(snapshot\)/);
  assert.match(PANELS, /Where every deal sits today - not a measure of how deals moved\./);
  assert.match(PANELS, /Conversion \(measured\)/);
  assert.match(PANELS, /Not measured yet - conversion starts with the first activity you log\./);
  assert.match(PANELS, /Agreed terms \(contracted\), not payments received\./);
});

test("migration and rollback: TEST-only pending SQL; rollback keeps history, data and columns", () => {
  assert.match(MIGRATION, /STATUS: PENDING/);
  assert.match(MIGRATION, /revoke all on public\.founder_deal_activities from public, anon, authenticated;\ngrant select on public\.founder_deal_activities to authenticated;/);
  const rollbackCode = ROLLBACK.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
  assert.doesNotMatch(rollbackCode, /drop table|drop column|delete from|truncate|update public\./i, "the default rollback destroys and rewrites nothing");
  assert.match(ROLLBACK, /NOT RUN BY DEFAULT - each needs explicit authorization/);
});

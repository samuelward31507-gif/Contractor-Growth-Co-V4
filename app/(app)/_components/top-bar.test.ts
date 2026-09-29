/**
 * Trackpr 2.0 (step 2D) - the top bar and its system status:
 *
 *   1. the status model (healthy / attention / critical / paused / payment)
 *      and its business-language issue sentences;
 *   2. no infrastructure wording can reach the contractor UI;
 *   3. the status control's accessibility and popover behavior (structural -
 *      this repo has no DOM test runner, so the component source is checked);
 *   4. one merged header on mobile - no second brand bar stacked on top.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/(app)/_components/top-bar.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { describeSystemStatus, describeIssues }: typeof import("./system-status-model") = require("./system-status-model.ts");
const { INCIDENT_SENTENCE, INCIDENT_LABEL, GENERIC_INCIDENT_SENTENCE, GENERIC_INCIDENT_LABEL }: typeof import("../../../lib/ui/incident-language") = require("../../../lib/ui/incident-language.ts");

const ROOT = process.cwd();
const exists = (relative: string) => fs.existsSync(path.join(ROOT, relative));
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

type Health = Parameters<typeof describeSystemStatus>[0];
const HEALTHY: Health = { status: "healthy", activeIncidentCount: 0, stuckExecutionCount: 0, smsDeliveryFailureCount: 0, staleScheduledAutomationCount: 0 };

// ---------------------------------------------------------------------------
// 1. Status model
// ---------------------------------------------------------------------------

test("healthy: a quiet 'All systems operational' with the pine (healthy) tone and no issues", () => {
  const view = describeSystemStatus(HEALTHY);
  assert.equal(view.tone, "healthy");
  assert.equal(view.label, "All systems operational");
  assert.equal(view.headline, "Everything is running normally");
  assert.deepEqual(view.issues, []);
});

test("attention: a degraded status counts its issues and uses the attention tone", () => {
  const view = describeSystemStatus({ ...HEALTHY, status: "degraded", activeIncidentCount: 1 });
  assert.equal(view.tone, "attention");
  assert.equal(view.label, "1 issue needs attention");
  assert.equal(view.shortLabel, "1 issue");
  assert.deepEqual(view.issues, ["1 item needs a look."]);
});

test("critical: an unhealthy status uses the critical tone and pluralizes", () => {
  const view = describeSystemStatus({ ...HEALTHY, status: "unhealthy", activeIncidentCount: 3, smsDeliveryFailureCount: 2 });
  assert.equal(view.tone, "critical");
  assert.equal(view.label, "3 issues need attention");
  assert.equal(view.shortLabel, "3 issues");
  assert.deepEqual(view.issues, ["2 customer messages couldn't be delivered.", "1 other item needs a look."]);
});

test("a stale scheduled task alone is counted and explained, matching what makes the status degraded", () => {
  const view = describeSystemStatus({ ...HEALTHY, status: "degraded", staleScheduledAutomationCount: 1 });
  assert.equal(view.label, "1 issue needs attention");
  assert.deepEqual(view.issues, ["A scheduled task may not have run on time."]);
});

test("specific counts are described specifically; the remainder gets a neutral line that guesses no cause (incidents are not always automations)", () => {
  assert.deepEqual(describeIssues({ ...HEALTHY, activeIncidentCount: 4, stuckExecutionCount: 1, smsDeliveryFailureCount: 1 }), [
    "A customer message couldn't be delivered.",
    "An automated task is running late.",
    "2 other items need a look.",
  ]);
  assert.deepEqual(describeIssues({ ...HEALTHY, activeIncidentCount: 2, stuckExecutionCount: 2 }), ["2 automated tasks are running late."]);
  assert.deepEqual(describeIssues({ ...HEALTHY, activeIncidentCount: 9 }), ["9 items need a look."]);
});

test("paused and payment-blocked are never shown as healthy or as a random failure", () => {
  const paused = describeSystemStatus({ ...HEALTHY, status: "paused" });
  assert.equal(paused.tone, "neutral");
  assert.equal(paused.label, "Automations paused");
  const blocked = describeSystemStatus({ ...HEALTHY, status: "payment_blocked" });
  assert.equal(blocked.tone, "critical");
  assert.equal(blocked.label, "Payment needed");
  assert.match(blocked.body, /paused until payment is resolved/);
});

test("a degraded status whose counts disagree still says something true, never '0 issues'", () => {
  const view = describeSystemStatus({ ...HEALTHY, status: "degraded" });
  assert.equal(view.label, "1 issue needs attention");
  assert.equal(view.issues.length, 1);
});

test("every status links its details to /automations", () => {
  for (const status of ["healthy", "degraded", "unhealthy", "paused", "payment_blocked"] as const) {
    assert.equal(describeSystemStatus({ ...HEALTHY, status, activeIncidentCount: 1 }).detailsHref, "/automations");
  }
});

// ---------------------------------------------------------------------------
// 2. No technical wording reaches the contractor
// ---------------------------------------------------------------------------

const JARGON = /n8n|webhook|dispatch|callback|execution|workflow|http|\b[45]\d\d\b|_id\b|\bsms\b|api\b|stack|cron|incident/i;

test("no status text, in any state or combination, contains infrastructure wording", () => {
  const combos: Health[] = [];
  for (const status of ["healthy", "degraded", "unhealthy", "paused", "payment_blocked"] as const) {
    for (const [active, stuck, sms, stale] of [[0, 0, 0, 0], [1, 1, 0, 0], [1, 0, 1, 0], [0, 0, 0, 2], [5, 2, 2, 1]]) {
      combos.push({ status, activeIncidentCount: active, stuckExecutionCount: stuck, smsDeliveryFailureCount: sms, staleScheduledAutomationCount: stale });
    }
  }
  for (const health of combos) {
    const view = describeSystemStatus(health);
    for (const text of [view.label, view.shortLabel, view.headline, view.body, ...view.issues]) {
      assert.doesNotMatch(text, JARGON, `"${text}" (${JSON.stringify(health)})`);
    }
  }
});

test("every incident category has a contractor-language sentence and label, free of infrastructure wording", () => {
  const categories = Object.keys(INCIDENT_SENTENCE);
  assert.deepEqual(Object.keys(INCIDENT_LABEL).sort(), categories.sort());
  for (const text of [...Object.values(INCIDENT_SENTENCE), ...Object.values(INCIDENT_LABEL), GENERIC_INCIDENT_SENTENCE, GENERIC_INCIDENT_LABEL]) {
    assert.doesNotMatch(text, JARGON, text);
  }
});

test("the Automations incident rows use the shared contractor-language labels, not raw category names", () => {
  const source = read("app/(app)/automations/_components/incident-list.tsx");
  assert.match(source, /const CATEGORY_LABEL = INCIDENT_LABEL;/);
  assert.match(source, /\{CATEGORY_LABEL\[incident\.category\] \?\? GENERIC_INCIDENT_LABEL\}/, "a category the map doesn't know gets a neutral label, never an empty one");
  assert.doesNotMatch(source, /n8n|Execution stuck|SMS (send|delivery) failed/);
});

// ---------------------------------------------------------------------------
// 3. Status control: accessibility and popover behavior
// ---------------------------------------------------------------------------

const STATUS = read("app/(app)/_components/system-status.tsx");

test("the status is a real button with a meaningful accessible name and popover state", () => {
  assert.match(STATUS, /<button[\s\S]*?type="button"/);
  assert.match(STATUS, /aria-haspopup="dialog"/);
  assert.match(STATUS, /aria-expanded=\{open\}/);
  assert.match(STATUS, /aria-label=\{`System status: \$\{view\.label\}`\}/);
  assert.match(STATUS, /group-focus-visible:ring-2/);
});

test("status is never color alone - the dot always sits beside words", () => {
  assert.match(STATUS, /<StatusDot tone=\{view\.tone\} \/>\s*<span className="sm:hidden">\{view\.shortLabel\}<\/span>\s*<span className="hidden sm:inline">\{view\.label\}<\/span>/);
  assert.match(read("lib/ui/status-dot.tsx"), /aria-hidden/);
});

test("the control and the details link meet the 44px touch floor below sm", () => {
  const buttonClass = STATUS.match(/<button[\s\S]*?className=(?:"([^"]*)"|\{`([^`]*)`\})/)?.slice(1).find(Boolean) ?? "";
  assert.match(buttonClass, /\bmin-h-11\b/);
  assert.match(buttonClass, /\bsm:min-h-8\b/);
  assert.match(STATUS, /View details[\s\S]*?<\/Link>/);
  assert.match(STATUS, /<Link[\s\S]*?className="[^"]*\bmin-h-11\b[^"]*"/);
});

test("popover: labelled dialog, focus moves in on open, Escape closes and returns focus, outside click closes", () => {
  assert.match(STATUS, /role="dialog"/);
  assert.match(STATUS, /aria-labelledby=\{headingId\}/);
  assert.match(STATUS, /panelRef\.current\?\.focus\(\)/);
  assert.match(STATUS, /if \(event\.key !== "Escape"\) return;\s*setOpen\(false\);\s*buttonRef\.current\?\.focus\(\);/);
  assert.match(STATUS, /addEventListener\("pointerdown", onPointerDown\)/);
  assert.match(STATUS, /if \(!wrapperRef\.current\?\.contains\(event\.target as Node\)\) setOpen\(false\);/);
  assert.match(STATUS, /removeEventListener\("keydown", onKeyDown\)/);
});

test("popover never overflows a narrow viewport - its width is capped at the viewport minus the gutters", () => {
  assert.match(STATUS, /w-\[min\(20rem,calc\(100vw-2rem\)\)\]/);
  assert.match(STATUS, /absolute right-0 top-full/);
});

// ---------------------------------------------------------------------------
// 4. One merged header
// ---------------------------------------------------------------------------

test("mobile: the separate brand bar is gone - the shell renders exactly one header above the content", () => {
  const layout = read("app/(app)/layout.tsx");
  assert.ok(!exists("app/(app)/_components/mobile-nav.tsx"), "the stacked mobile brand bar component is removed");
  assert.doesNotMatch(layout, /MobileNav\b/);
  assert.equal((layout.match(/<TopBar\b/g) ?? []).length, 1);
});

test("the merged header carries brand, page and workspace below lg, and the breadcrumb at lg+", () => {
  const topBar = read("app/(app)/_components/top-bar.tsx");
  assert.match(topBar, /<div className="flex min-w-0 items-center gap-2\.5 lg:hidden">\s*<BrandMark \/>[\s\S]*?<MobilePageTitle \/>[\s\S]*?\{organizationName\}/);
  assert.match(topBar, /<div className="hidden min-w-0 lg:block">\s*<Breadcrumb \/>/);
  assert.match(topBar, /<header className="flex h-12 shrink-0/);
  assert.equal((topBar.match(/<header\b/g) ?? []).length, 1);
});

test("the top bar is on the light token system - no dark surface, no emerald or slate literals", () => {
  for (const file of ["app/(app)/_components/top-bar.tsx", "app/(app)/_components/system-status.tsx"]) {
    const source = read(file);
    assert.doesNotMatch(source, /emerald-|slate-|#0a120f|bg-gradient|radial-gradient/, file);
  }
  assert.match(read("app/(app)/_components/top-bar.tsx"), /border-b border-line bg-surface/);
});

test("the status reuses the request-cached health read - no new query path in the top bar", () => {
  const topBar = read("app/(app)/_components/top-bar.tsx");
  assert.match(topBar, /await getOrganizationHealth\(supabase, organizationId\)\.catch\(\(\) => null\)/);
  assert.doesNotMatch(topBar, /\.from\(|\.rpc\(/);
});

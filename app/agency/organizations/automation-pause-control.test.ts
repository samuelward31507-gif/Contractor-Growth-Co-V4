/**
 * Structural tests for Launch Blocker #5's Agency Command Center UI - no
 * component-rendering infrastructure exists in this repo (no jsdom/
 * @testing-library), so verified against the real source, the same
 * convention used for every other "renders" claim in this codebase's test
 * suite (e.g. app/(marketing)/legal-pages.test.ts).
 *
 * Deliberately placed here (app/agency/organizations/), NOT inside
 * app/agency/organizations/[id]/ where the component/page it tests
 * actually live - Node's test runner interprets "[id]" in a file path as a
 * glob character class, not a literal directory name, so a test file
 * placed inside that directory is silently never discovered (0 tests run,
 * no error). fs.readFileSync is unaffected by this - only the test
 * runner's own file-selection glob is - so the source is still read from
 * its real path below, just from a test file living one level up.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/agency/organizations/automation-pause-control.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const CONTROL_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "app/agency/organizations/[id]/_components/automation-pause-control.tsx"), "utf8");
const PAGE_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "app/agency/organizations/[id]/page.tsx"), "utf8");

test("1. the control clearly renders 'Automation: ON' when not paused, and 'Automation: PAUSED' (warning tone) when paused", () => {
  assert.match(CONTROL_SOURCE, /Automation: ON/);
  assert.match(CONTROL_SOURCE, /Automation: PAUSED/);
  assert.match(CONTROL_SOURCE, /<Badge tone="warning">Automation: PAUSED<\/Badge>/);
  assert.match(CONTROL_SOURCE, /<Badge tone="success">Automation: ON<\/Badge>/);
});

test("2. pausing requires confirmation via the shared Dialog primitive before the form can submit - resuming does not (matches 'if appropriate')", () => {
  assert.match(CONTROL_SOURCE, /import \{ Dialog, DialogTitle, DialogDescription, DialogFooter \} from "@\/lib\/ui\/dialog";/);
  assert.match(CONTROL_SOURCE, /Pause automation for this client\?/);
  // The Resume form has no confirmOpen gate around it - it's rendered directly.
  const resumeFormIndex = CONTROL_SOURCE.indexOf('<form action={resumeFormAction}>');
  const dialogIndex = CONTROL_SOURCE.indexOf("{dialogOpen ? (");
  assert.ok(resumeFormIndex !== -1 && dialogIndex !== -1 && resumeFormIndex < dialogIndex, "the resume form must be unconditional, outside the confirm-dialog gate");
});

test("3. both the pause and resume forms submit organizationId and paused as hidden fields - the server independently re-verifies both, never trusting them merely because they're present", () => {
  const hiddenFieldOccurrences = (CONTROL_SOURCE.match(/name="organizationId" value={organizationId}/g) ?? []).length;
  assert.equal(hiddenFieldOccurrences, 2, "expected the hidden organizationId field in both the pause and resume forms");
  assert.match(CONTROL_SOURCE, /name="paused" value="true"/);
  assert.match(CONTROL_SOURCE, /name="paused" value="false"/);
});

test("4. the control reflects the isPaused prop passed in from the server - it never derives paused/unpaused from any local optimistic state", () => {
  assert.match(CONTROL_SOURCE, /export function AutomationPauseControl\(\{ organizationId, isPaused \}: \{ organizationId: string; isPaused: boolean \}\)/);
  assert.match(CONTROL_SOURCE, /\{isPaused \? \(/);
});

test("5. the org detail page fails closed on a read error - an organization whose pause state couldn't be confirmed is treated as paused, never as running", () => {
  assert.match(PAGE_SOURCE, /const isAutomationPaused = automationPauseRow\.error \? true : Boolean\(automationPauseRow\.data\?\.automation_paused\);/);
});

test("6. the page reads automation_paused scoped to the same already-authorized organization id used by every other read on this page - no new authorization path", () => {
  const fetchIndex = PAGE_SOURCE.indexOf('.from("organizations").select("automation_paused")');
  const authGuardIndex = PAGE_SOURCE.indexOf("if (!org || !orgHealth || !automations.ok)");
  assert.ok(fetchIndex !== -1 && authGuardIndex !== -1 && authGuardIndex < fetchIndex, "the automation_paused read must happen after the existing authorization guard, on the same already-verified id");
  assert.match(PAGE_SOURCE, /service\.from\("organizations"\)\.select\("automation_paused"\)\.eq\("id", id\)/);
});

test("7. the control is actually wired into the page with the real organization id and the real persisted state, not a placeholder", () => {
  assert.match(PAGE_SOURCE, /<AutomationPauseControl organizationId={id} isPaused={isAutomationPaused} \/>/);
});

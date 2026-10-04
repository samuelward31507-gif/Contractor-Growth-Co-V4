/**
 * Phase 3 (W4): "Run now" / dry run are offered for exactly the automations
 * the server actions allow (one shared list), and a run that stops on an
 * incomplete candidate read reports it plainly instead of throwing.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/manual-run.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const { MANUAL_RUN_AUTOMATION_IDS }: typeof import("./manual-run") = require(path.join(ROOT, "lib/automation/manual-run.ts"));
const { AUTOMATION_CATALOG }: typeof import("./catalog") = require(path.join(ROOT, "lib/automation/catalog.ts"));
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

test("the manual-run list: appointment reminders and estimate follow-up (its scheduled check-ins are composed and sent by Trackpr)", () => {
  assert.deepEqual([...MANUAL_RUN_AUTOMATION_IDS].sort(), ["appointment-reminders", "estimate-followup"]);
  for (const id of MANUAL_RUN_AUTOMATION_IDS) assert.ok(AUTOMATION_CATALOG.some((a) => a.id === id), `${id} is a real automation`);
});

test("the page and the server actions read the same list - the page no longer hides estimate follow-up's controls", () => {
  const page = read("app/(app)/automations/[automationId]/page.tsx");
  assert.match(page, /const supportsManualRun = MANUAL_RUN_AUTOMATION_IDS\.has\(definition\.id\);/);
  assert.doesNotMatch(page, /supportsManualRun = definition\.dispatch === "trackpr"/);
  const actions = read("app/(app)/automations/actions.ts");
  assert.match(actions, /import \{ MANUAL_RUN_AUTOMATION_IDS \} from "@\/lib\/automation\/manual-run";/);
  assert.doesNotMatch(actions, /const MANUAL_RUN_AUTOMATION_IDS = new Set/, "no second, drifting copy");
});

test("Run now catches a scan that stops on an incomplete read and returns a plain error", () => {
  const actions = read("app/(app)/automations/actions.ts");
  const run = actions.slice(actions.indexOf("export async function runAutomationNow"));
  assert.match(run.slice(0, 2500), /try \{\n\s+result =[\s\S]*?\} catch \(error\) \{[\s\S]*?return \{ error: "The run couldn't read every candidate, so nothing was processed\. Please try again in a moment\." \};/);
});

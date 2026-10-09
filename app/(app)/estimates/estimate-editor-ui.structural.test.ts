/**
 * Estimate editor wiring (no DOM test environment here, so verified against
 * source like the app's other UI tests): Scope of Work / Terms on the Create
 * and Edit Estimate dialog, a new estimate opening in its editor, and the
 * routes into the editor from a lead and from Money.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/(app)/estimates/estimate-editor-ui.structural.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8");
const DIALOG = read("app/(app)/estimates/_components/estimate-dialog.tsx");

test("Create and Edit Estimate carry customer-facing Scope of Work and Terms, kept apart from internal notes", () => {
  assert.match(DIALOG, /name="scopeOfWork"[\s\S]*?defaultValue=\{quoteText\?\.scopeOfWork \?\? ""\}/);
  assert.match(DIALOG, /name="terms"[\s\S]*?defaultValue=\{quoteText\?\.terms \?\? ""\}/);
  assert.match(DIALOG, /maxLength=\{QUOTE_TEXT_MAX\}/);
  assert.match(DIALOG, /Notes below stay internal\./);
  // Create always offers them; edit only when the estimate page could read the saved values.
  assert.match(DIALOG, /const showQuoteText = mode === "create" \|\| quoteText != null;/);
  const PAGE = read("app/(app)/estimates/[id]/page.tsx");
  assert.match(PAGE, /quoteText=\{details\.textFieldsAvailable \? \{ scopeOfWork: details\.scopeOfWork, terms: details\.terms \} : null\}/);
  assert.match(read("app/(app)/estimates/[id]/_components/estimate-actions.tsx"), /quoteText=\{quoteText\}/);
});

test("a new estimate opens as a draft in its editor; a partial save is reported, never swallowed", () => {
  assert.match(DIALOG, /if \(mode === "create" && state\.id\) \{[\s\S]*?router\.push\(`\/estimates\/\$\{state\.id\}`\);/);
  assert.match(DIALOG, /if \(!state\.success \|\| closedRef\.current \|\| state\.warning\) return;/);
  assert.match(DIALOG, /\{state\.success && state\.warning \? \(/);
});

test("only drafts are editable from the estimate page", () => {
  const ACTIONS = read("app/(app)/estimates/[id]/_components/estimate-actions.tsx");
  assert.match(ACTIONS, /\{estimate\.status === "draft" \? \([\s\S]{0,120}setEditOpen\(true\)/);
  assert.match(read("app/(app)/estimates/[id]/page.tsx"), /editable=\{estimate\.status === "draft"\}/);
});

test("from a lead: its estimates link to the editor, and New estimate opens Create Estimate for that lead", () => {
  const LEAD = read("app/(app)/leads/[id]/page.tsx");
  assert.match(LEAD, /href=\{`\/estimates\/\$\{estimate\.id\}`\}/);
  assert.match(LEAD, /href=\{`\/money\?browse=estimates&new=estimate&contactId=\$\{encodeURIComponent\(lead\.contact_id\)\}&leadId=\$\{encodeURIComponent\(lead\.id\)\}`\}/);
  const BUTTON = read("app/(app)/estimates/_components/add-estimate-button.tsx");
  assert.match(BUTTON, /const defaultLeadId = searchParams\.get\("leadId"\) \?\? undefined;/);
  assert.match(BUTTON, /defaultLeadId=\{defaultLeadId\}/);
  assert.match(BUTTON, /rest\.delete\("leadId"\);/);
});

test("from Money: the Estimates view lists every estimate (drafts included) linking to its editor, with New Estimate", () => {
  const MONEY = read("app/(app)/money/page.tsx");
  assert.match(MONEY, /<EstimatesTable/);
  assert.match(MONEY, /<AddEstimateButton/);
  assert.match(read("app/(app)/estimates/_components/estimates-table.tsx"), /href=\{`\/estimates\/\$\{estimate\.id\}`\}/);
});

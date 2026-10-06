/**
 * Phase 3G-2a: per-automation default enablement. An organization with no
 * automation_settings row gets the catalog entry's defaultEnabled - true for
 * every existing automation (unchanged behavior), false only for an entry
 * that opts out. Every place that used to assume "missing row = enabled"
 * now asks the catalog instead.
 *
 * Offline: a fake client for the settings read. No network, no database.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/default-enabled.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const catalog: typeof import("./catalog") = require(path.join(ROOT, "lib/automation/catalog.ts"));
const { getAutomationEnabled }: typeof import("./settings") = require(path.join(ROOT, "lib/automation/settings.ts"));
const { AUTOMATION_CATALOG, getAutomationDefaultEnabled } = catalog;

function fakeSettings(row: { enabled: boolean } | null) {
  return {
    from() {
      const builder: Record<string, unknown> = {};
      for (const name of ["select", "eq"]) builder[name] = () => builder;
      builder.maybeSingle = async () => ({ data: row, error: null });
      return builder;
    },
  } as unknown as SupabaseClient;
}

test("every existing automation still defaults ON - only invoice-reminders (Phase 3G-2b) and lead-followup-sequence (P0 A4) opt out; unknown ids default ON", () => {
  const optOut = new Set(["invoice-reminders", "lead-followup-sequence"]);
  for (const definition of AUTOMATION_CATALOG) assert.equal(getAutomationDefaultEnabled(definition.id), !optOut.has(definition.id), definition.id);
  assert.deepEqual(AUTOMATION_CATALOG.filter((d) => d.defaultEnabled === false).map((d) => d.id), ["invoice-reminders", "lead-followup-sequence"]);
  assert.equal(getAutomationDefaultEnabled("not-a-real-automation"), true);
});

test("getAutomationEnabled: no row -> the catalog default (ON for existing automations); an explicit row always wins", async () => {
  assert.equal(await getAutomationEnabled(fakeSettings(null), "org-1", "appointment-reminders"), true);
  assert.equal(await getAutomationEnabled(fakeSettings({ enabled: false }), "org-1", "appointment-reminders"), false);
  assert.equal(await getAutomationEnabled(fakeSettings({ enabled: true }), "org-1", "appointment-reminders"), true);
});

test("an entry with defaultEnabled: false is OFF with no row and ON only after an explicit opt-in row", async () => {
  const optIn = { ...AUTOMATION_CATALOG[0], id: "test-opt-in-automation", defaultEnabled: false };
  AUTOMATION_CATALOG.push(optIn);
  try {
    assert.equal(getAutomationDefaultEnabled("test-opt-in-automation"), false);
    assert.equal(await getAutomationEnabled(fakeSettings(null), "org-1", "test-opt-in-automation"), false);
    assert.equal(await getAutomationEnabled(fakeSettings({ enabled: true }), "org-1", "test-opt-in-automation"), true);
    assert.equal(getAutomationDefaultEnabled("appointment-reminders"), true, "other automations unaffected");
  } finally {
    AUTOMATION_CATALOG.splice(AUTOMATION_CATALOG.indexOf(optIn), 1);
  }
});

test("every former 'missing row = enabled' consumer now uses the catalog default - no hard-coded '?? true' left", () => {
  const files: [string, RegExp][] = [
    ["lib/automation/settings.ts", /\?\? getAutomationDefaultEnabled\(automationId\)/],
    ["lib/automation/queries.ts", /enabledByAutomationId\.get\(definition\.id\) \?\? getAutomationDefaultEnabled\(definition\.id\)/],
    ["lib/opportunities/intelligence.ts", /automationEnabledMap\.get\(automationId\) \?\? getAutomationDefaultEnabled\(automationId\)/],
    ["app/(app)/automations/actions.ts", /existingRow\?\.enabled as boolean \| undefined\) \?\? getAutomationDefaultEnabled\(automationId\)/],
  ];
  for (const [file, pattern] of files) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.match(source, pattern, file);
    assert.doesNotMatch(source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""), /\.enabled as boolean \| undefined\) \?\? true|\.get\([^)]*\) \?\? true/, `${file}: no hard-coded default`);
  }
});

/**
 * Unit tests for getAutomationEnabled() against a mocked Supabase client -
 * no real database, no production fixtures. Run with:
 *
 *   node --test lib/automation/settings.test.ts
 *
 * See lib/automation/authorization.test.ts for why this repo uses node:test
 * directly (no committed test framework) and why the module under test is
 * loaded via require() with an explicit .ts path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { getAutomationEnabled, shouldAuditEnableToggle }: typeof import("./settings") = require("./settings.ts");

const ORG_ID = "11111111-1111-1111-1111-111111111111";

/** Maps automation_id -> stored `enabled` value; an id absent from the map means "no row". */
function createMockSupabase(rows: Record<string, boolean>) {
  const queries: { organizationId: string; automationId: string }[] = [];

  const client = {
    from(table: string) {
      if (table !== "automation_settings") {
        throw new Error(`unexpected table: ${table}`);
      }
      let organizationId = "";
      return {
        select: () => ({
          eq: (col: string, value: string) => {
            if (col === "organization_id") organizationId = value;
            return {
              eq: (col2: string, automationId: string) => {
                if (col2 !== "automation_id") throw new Error(`unexpected second .eq column: ${col2}`);
                queries.push({ organizationId, automationId });
                return {
                  maybeSingle: async () => ({
                    data: automationId in rows ? { enabled: rows[automationId] } : null,
                  }),
                };
              },
            };
          },
        }),
      };
    },
  } as unknown as SupabaseClient;

  return { client, queries };
}

test("A: missing automation_settings row -> enabled", async () => {
  const { client } = createMockSupabase({});

  const result = await getAutomationEnabled(client, ORG_ID, "instant-lead-followup");

  assert.equal(result, true);
});

test("B: explicit enabled=true -> enabled", async () => {
  const { client } = createMockSupabase({ "instant-lead-followup": true });

  const result = await getAutomationEnabled(client, ORG_ID, "instant-lead-followup");

  assert.equal(result, true);
});

test("C: explicit enabled=false -> disabled", async () => {
  const { client } = createMockSupabase({ "instant-lead-followup": false });

  const result = await getAutomationEnabled(client, ORG_ID, "instant-lead-followup");

  assert.equal(result, false);
});

test("L: disabling one automation does not affect another automation in the same organization", async () => {
  const { client, queries } = createMockSupabase({ "instant-lead-followup": false, "job-lifecycle": true });

  const disabled = await getAutomationEnabled(client, ORG_ID, "instant-lead-followup");
  const enabled = await getAutomationEnabled(client, ORG_ID, "job-lifecycle");
  const untouched = await getAutomationEnabled(client, ORG_ID, "estimate-followup"); // no row for this one

  assert.equal(disabled, false);
  assert.equal(enabled, true);
  assert.equal(untouched, true);
  assert.deepEqual(
    queries.map((q) => q.automationId),
    ["instant-lead-followup", "job-lifecycle", "estimate-followup"],
    "each automation must be looked up by its own automation_id, independently",
  );
});

test("Phase H: enabling a previously-disabled automation produces an automation_enabled audit plan", () => {
  const plan = shouldAuditEnableToggle(false, true);

  assert.ok(plan);
  assert.equal(plan!.action, "automation_enabled");
  assert.deepEqual(plan!.metadata, { previous_enabled: false, new_enabled: true });
});

test("Phase H: disabling a previously-enabled automation produces an automation_disabled audit plan", () => {
  const plan = shouldAuditEnableToggle(true, false);

  assert.ok(plan);
  assert.equal(plan!.action, "automation_disabled");
  assert.deepEqual(plan!.metadata, { previous_enabled: true, new_enabled: false });
});

test("Phase H: a no-op toggle (already enabled -> enabled, or already disabled -> disabled) produces no audit plan", () => {
  assert.equal(shouldAuditEnableToggle(true, true), null);
  assert.equal(shouldAuditEnableToggle(false, false), null);
});

test("Phase H: enable-toggle audit metadata never contains anything beyond the two boolean fields", () => {
  const plan = shouldAuditEnableToggle(false, true)!;
  assert.deepEqual(Object.keys(plan.metadata).sort(), ["new_enabled", "previous_enabled"]);
});

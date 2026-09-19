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
const {
  getAutomationEnabled,
  shouldAuditEnableToggle,
  readAppointmentReminderConfig,
  validateAppointmentReminderConfig,
  readEstimateFollowupConfig,
  validateEstimateFollowupConfig,
  shouldAuditConfigUpdate,
  getAutomationConfig,
  getAutomationConfigByOrganization,
}: typeof import("./settings") = require("./settings.ts");

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

// ============================================================================
// Automation Configuration V1
// ============================================================================

test("Config 1: a missing/null config falls back to defaults for both automations - reminder stays 24h, follow-ups stay 24h/72h", () => {
  assert.deepEqual(readAppointmentReminderConfig(null), { reminder_lead_time_hours: 24 });
  assert.deepEqual(readAppointmentReminderConfig(undefined), { reminder_lead_time_hours: 24 });
  assert.deepEqual(readEstimateFollowupConfig(null), { followup_1_hours: 24, followup_2_hours: 72 });
});

test("Config 1b: an empty stored config object ('{}', the migration's column default) also falls back to defaults - no organization's behavior changes from the migration alone", () => {
  assert.deepEqual(readAppointmentReminderConfig({}), { reminder_lead_time_hours: 24 });
  assert.deepEqual(readEstimateFollowupConfig({}), { followup_1_hours: 24, followup_2_hours: 72 });
});

test("Config 2: a valid appointment-reminders config is accepted", () => {
  const result = validateAppointmentReminderConfig({ reminder_lead_time_hours: 48 });
  assert.deepEqual(result, { ok: true, value: { reminder_lead_time_hours: 48 } });
});

test("Config 3: a valid estimate-followup config is accepted", () => {
  const result = validateEstimateFollowupConfig({ followup_1_hours: 48, followup_2_hours: 96 });
  assert.deepEqual(result, { ok: true, value: { followup_1_hours: 48, followup_2_hours: 96 } });
});

test("Config 4: invalid appointment-reminders values are rejected, never silently coerced", () => {
  assert.equal(validateAppointmentReminderConfig({ reminder_lead_time_hours: -1 }).ok, false, "negative");
  assert.equal(validateAppointmentReminderConfig({ reminder_lead_time_hours: 0 }).ok, false, "zero");
  assert.equal(validateAppointmentReminderConfig({ reminder_lead_time_hours: NaN }).ok, false, "NaN");
  assert.equal(validateAppointmentReminderConfig({ reminder_lead_time_hours: Infinity }).ok, false, "Infinity");
  assert.equal(validateAppointmentReminderConfig({ reminder_lead_time_hours: "24" }).ok, false, "string instead of number");
  assert.equal(validateAppointmentReminderConfig({ reminder_lead_time_hours: 24.5 }).ok, false, "non-integer");
  assert.equal(validateAppointmentReminderConfig({ reminder_lead_time_hours: 24, admin_override: true }).ok, false, "unlisted extra field");
  assert.equal(validateAppointmentReminderConfig({ reminder_lead_time_hours: 169 }).ok, false, "above max bound");
  assert.equal(validateAppointmentReminderConfig(null).ok, false, "null input");
});

test("Config 4b: invalid estimate-followup values are rejected, never silently coerced", () => {
  assert.equal(validateEstimateFollowupConfig({ followup_1_hours: -1, followup_2_hours: 72 }).ok, false, "negative");
  assert.equal(validateEstimateFollowupConfig({ followup_1_hours: 0, followup_2_hours: 72 }).ok, false, "zero");
  assert.equal(validateEstimateFollowupConfig({ followup_1_hours: NaN, followup_2_hours: 72 }).ok, false, "NaN");
  assert.equal(validateEstimateFollowupConfig({ followup_1_hours: 24, followup_2_hours: Infinity }).ok, false, "Infinity");
  assert.equal(validateEstimateFollowupConfig({ followup_1_hours: "24", followup_2_hours: 72 }).ok, false, "string instead of number");
  assert.equal(validateEstimateFollowupConfig({ followup_1_hours: 24, followup_2_hours: 24 }).ok, false, "second must be later than first");
  assert.equal(validateEstimateFollowupConfig({ followup_1_hours: 72, followup_2_hours: 24 }).ok, false, "second before first");
  assert.equal(validateEstimateFollowupConfig({ followup_1_hours: 24, followup_2_hours: 72, message_body: "hi" }).ok, false, "unlisted extra field");
});

test("Config 5: saving an identical config produces no audit plan (no-op save)", () => {
  assert.equal(shouldAuditConfigUpdate({ reminder_lead_time_hours: 24 }, { reminder_lead_time_hours: 24 }), null);
});

test("Config 6: saving a changed config produces an automation_config_updated plan with only the before/after values", () => {
  const plan = shouldAuditConfigUpdate({ reminder_lead_time_hours: 24 }, { reminder_lead_time_hours: 48 });
  assert.deepEqual(plan, {
    action: "automation_config_updated",
    metadata: { previous_config: { reminder_lead_time_hours: 24 }, new_config: { reminder_lead_time_hours: 48 } },
  });
});

test("Config 6b: the estimate-followup audit metadata shape matches the two-field config exactly", () => {
  const plan = shouldAuditConfigUpdate({ followup_1_hours: 24, followup_2_hours: 72 }, { followup_1_hours: 48, followup_2_hours: 96 });
  assert.deepEqual(plan, {
    action: "automation_config_updated",
    metadata: {
      previous_config: { followup_1_hours: 24, followup_2_hours: 72 },
      new_config: { followup_1_hours: 48, followup_2_hours: 96 },
    },
  });
});

test("Config 7: organization isolation - getAutomationConfigByOrganization keys strictly by organization_id, one organization's config never leaks into another's lookup", async () => {
  const ORG_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const ORG_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const rows = [
    { organization_id: ORG_A, config: { reminder_lead_time_hours: 48 } },
    { organization_id: ORG_B, config: { reminder_lead_time_hours: 6 } },
  ];
  const client = {
    from: (table: string) => {
      assert.equal(table, "automation_settings");
      return { select: () => ({ eq: async () => ({ data: rows }) }) };
    },
  } as unknown as SupabaseClient;

  const map = await getAutomationConfigByOrganization(client, "appointment-reminders");

  assert.deepEqual(readAppointmentReminderConfig(map.get(ORG_A)), { reminder_lead_time_hours: 48 });
  assert.deepEqual(readAppointmentReminderConfig(map.get(ORG_B)), { reminder_lead_time_hours: 6 });
  assert.deepEqual(readAppointmentReminderConfig(map.get("no-such-org")), { reminder_lead_time_hours: 24 }, "an org with no row still gets the default");
});

test("Config 7b: getAutomationConfig scopes its lookup to exactly one organization_id and one automation_id", async () => {
  const seen: { organizationId?: string; automationId?: string } = {};
  const client = {
    from: () => ({
      select: () => ({
        eq: (col: string, value: string) => {
          if (col === "organization_id") seen.organizationId = value;
          if (col === "automation_id") seen.automationId = value;
          return {
            eq: (col2: string, value2: string) => {
              if (col2 === "automation_id") seen.automationId = value2;
              return { maybeSingle: async () => ({ data: { config: { reminder_lead_time_hours: 12 } } }) };
            },
          };
        },
      }),
    }),
  } as unknown as SupabaseClient;

  const raw = await getAutomationConfig(client, "org-1", "appointment-reminders");

  assert.equal(seen.organizationId, "org-1");
  assert.equal(seen.automationId, "appointment-reminders");
  assert.deepEqual(raw, { reminder_lead_time_hours: 12 });
});

test("Config 11: defaults preserve the exact pre-configuration behavior - 24h reminder, 24h/72h follow-ups", () => {
  assert.equal(readAppointmentReminderConfig(null).reminder_lead_time_hours, 24);
  assert.equal(readEstimateFollowupConfig(null).followup_1_hours, 24);
  assert.equal(readEstimateFollowupConfig(null).followup_2_hours, 72);
});

test("Config: a malformed stored followup config (second <= first) falls back entirely to defaults rather than reading a broken partial state", () => {
  assert.deepEqual(readEstimateFollowupConfig({ followup_1_hours: 72, followup_2_hours: 24 }), { followup_1_hours: 24, followup_2_hours: 72 });
});

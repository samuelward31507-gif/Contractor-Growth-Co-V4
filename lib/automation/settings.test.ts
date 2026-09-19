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
  readInboundCustomerReplyConfig,
  validateInboundCustomerReplyConfig,
  readInstantLeadFollowupConfig,
  validateInstantLeadFollowupConfig,
  readLostLeadNurtureConfig,
  validateLostLeadNurtureConfig,
  readLeadReactivationConfig,
  validateLeadReactivationConfig,
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

// ============================================================================
// Automation Configuration V2.1 - inbound-customer-reply.recent_message_window
// (V2.2 added a second field, respect_business_hours - see the V2.2 section
// below for tests specific to that field.)
// ============================================================================

test("V2.1: default is 10 messages, respect_business_hours defaults to false", () => {
  assert.deepEqual(readInboundCustomerReplyConfig(null), { recent_message_window: 10, respect_business_hours: false });
  assert.deepEqual(readInboundCustomerReplyConfig(undefined), { recent_message_window: 10, respect_business_hours: false });
  assert.deepEqual(readInboundCustomerReplyConfig({}), { recent_message_window: 10, respect_business_hours: false });
});

test("V2.1: valid values 1, 10, and 50 are accepted", () => {
  assert.deepEqual(validateInboundCustomerReplyConfig({ recent_message_window: 1, respect_business_hours: false }), {
    ok: true,
    value: { recent_message_window: 1, respect_business_hours: false },
  });
  assert.deepEqual(validateInboundCustomerReplyConfig({ recent_message_window: 10, respect_business_hours: false }), {
    ok: true,
    value: { recent_message_window: 10, respect_business_hours: false },
  });
  assert.deepEqual(validateInboundCustomerReplyConfig({ recent_message_window: 50, respect_business_hours: true }), {
    ok: true,
    value: { recent_message_window: 50, respect_business_hours: true },
  });
});

test("V2.1: invalid values are rejected, never silently coerced", () => {
  const base = { respect_business_hours: false };
  assert.equal(validateInboundCustomerReplyConfig({ ...base, recent_message_window: 0 }).ok, false, "zero");
  assert.equal(validateInboundCustomerReplyConfig({ ...base, recent_message_window: -1 }).ok, false, "negative");
  assert.equal(validateInboundCustomerReplyConfig({ ...base, recent_message_window: 51 }).ok, false, "above max");
  assert.equal(validateInboundCustomerReplyConfig({ ...base, recent_message_window: 10.5 }).ok, false, "decimal");
  assert.equal(validateInboundCustomerReplyConfig({ ...base, recent_message_window: NaN }).ok, false, "NaN");
  assert.equal(validateInboundCustomerReplyConfig({ ...base, recent_message_window: Infinity }).ok, false, "Infinity");
  assert.equal(validateInboundCustomerReplyConfig({ ...base, recent_message_window: "10" }).ok, false, "string");
  assert.equal(validateInboundCustomerReplyConfig({ ...base, recent_message_window: null }).ok, false, "null value");
  assert.equal(validateInboundCustomerReplyConfig(null).ok, false, "null input");
  assert.equal(validateInboundCustomerReplyConfig([10]).ok, false, "array input");
  assert.equal(validateInboundCustomerReplyConfig({ recent_message_window: 10, respect_business_hours: false, extra_field: "x" }).ok, false, "unknown property");
  assert.equal(validateInboundCustomerReplyConfig({ recent_message_window: 10 }).ok, false, "missing respect_business_hours");
});

test("V2.1: a malformed stored config (out of range, wrong type, or an array) safely falls back to the default of 10, independently of respect_business_hours", () => {
  assert.deepEqual(readInboundCustomerReplyConfig({ recent_message_window: 0 }), { recent_message_window: 10, respect_business_hours: false });
  assert.deepEqual(readInboundCustomerReplyConfig({ recent_message_window: -5 }), { recent_message_window: 10, respect_business_hours: false });
  assert.deepEqual(readInboundCustomerReplyConfig({ recent_message_window: 51 }), { recent_message_window: 10, respect_business_hours: false });
  assert.deepEqual(readInboundCustomerReplyConfig({ recent_message_window: 10.5 }), { recent_message_window: 10, respect_business_hours: false });
  assert.deepEqual(readInboundCustomerReplyConfig({ recent_message_window: "10" }), { recent_message_window: 10, respect_business_hours: false });
  assert.deepEqual(readInboundCustomerReplyConfig([10]), { recent_message_window: 10, respect_business_hours: false });
  assert.deepEqual(readInboundCustomerReplyConfig("not an object"), { recent_message_window: 10, respect_business_hours: false });
  // A V2.1-era stored config (saved before respect_business_hours existed)
  // must keep reading its window correctly, with the new field defaulting.
  assert.deepEqual(readInboundCustomerReplyConfig({ recent_message_window: 25 }), { recent_message_window: 25, respect_business_hours: false });
});

test("V2.1: saving an identical config produces no audit plan (no-op save)", () => {
  const config = { recent_message_window: 10, respect_business_hours: false };
  assert.equal(shouldAuditConfigUpdate(config, { ...config }), null);
});

test("V2.1: saving a changed config produces exactly one automation_config_updated plan with only the before/after values", () => {
  const plan = shouldAuditConfigUpdate(
    { recent_message_window: 10, respect_business_hours: false },
    { recent_message_window: 25, respect_business_hours: false },
  );
  assert.deepEqual(plan, {
    action: "automation_config_updated",
    metadata: {
      previous_config: { recent_message_window: 10, respect_business_hours: false },
      new_config: { recent_message_window: 25, respect_business_hours: false },
    },
  });
});

test("V2.1: organization isolation - getAutomationConfigByOrganization keys strictly by organization_id for inbound-customer-reply, one organization's window never leaks into another's lookup", async () => {
  const ORG_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const ORG_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const rows = [
    { organization_id: ORG_A, config: { recent_message_window: 25, respect_business_hours: true } },
    { organization_id: ORG_B, config: { recent_message_window: 3, respect_business_hours: false } },
  ];
  const client = {
    from: (table: string) => {
      assert.equal(table, "automation_settings");
      return { select: () => ({ eq: async () => ({ data: rows }) }) };
    },
  } as unknown as SupabaseClient;

  const map = await getAutomationConfigByOrganization(client, "inbound-customer-reply");

  assert.deepEqual(readInboundCustomerReplyConfig(map.get(ORG_A)), { recent_message_window: 25, respect_business_hours: true });
  assert.deepEqual(readInboundCustomerReplyConfig(map.get(ORG_B)), { recent_message_window: 3, respect_business_hours: false });
  assert.deepEqual(
    readInboundCustomerReplyConfig(map.get("no-such-org")),
    { recent_message_window: 10, respect_business_hours: false },
    "an org with no row still gets the default",
  );
});

// Note on authorization/organization-isolation-at-the-mutation-layer,
// unauthenticated-caller, and non-admin-member scenarios for
// updateInboundCustomerReplyConfig (app/(app)/automations/actions.ts):
// that Server Action reuses requireOrgAdminSession/assertOrgAdmin
// completely unchanged (no new authorization logic was written for V2.1),
// and organizationId is always derived from the verified session, never
// accepted as a parameter from the caller. Those guarantees are already
// directly unit-tested against assertOrgAdmin itself in
// lib/automation/authorization.test.ts (tests A, B, D, E) - a Server Action
// cannot be unit tested in this repo (createClient() depends on
// next/headers, which requires a real request context - see this
// repository's established convention, e.g. retry.test.ts/settings.test.ts's
// own comments), so re-asserting the identical, unmodified authorization
// chain here would not exercise any code this phase actually changed.
// Likewise, updateInboundCustomerReplyConfig's upsert payload is
// `{ organization_id, automation_id: "inbound-customer-reply", config }`
// only - it never includes `enabled` - verified by direct code inspection,
// matching the exact established shape of updateAppointmentReminderConfig/
// updateEstimateFollowupConfig above it in that same file.

// ============================================================================
// Automation Configuration V2.2 - instant-lead-followup.respect_business_hours
// ============================================================================

test("V2.2: default respect_business_hours is false", () => {
  assert.deepEqual(readInstantLeadFollowupConfig(null), { respect_business_hours: false });
  assert.deepEqual(readInstantLeadFollowupConfig(undefined), { respect_business_hours: false });
  assert.deepEqual(readInstantLeadFollowupConfig({}), { respect_business_hours: false });
});

test("V2.2: true and false are both accepted", () => {
  assert.deepEqual(validateInstantLeadFollowupConfig({ respect_business_hours: true }), { ok: true, value: { respect_business_hours: true } });
  assert.deepEqual(validateInstantLeadFollowupConfig({ respect_business_hours: false }), { ok: true, value: { respect_business_hours: false } });
});

test("V2.2: invalid values are rejected, never silently coerced", () => {
  assert.equal(validateInstantLeadFollowupConfig({ respect_business_hours: "true" }).ok, false, "string");
  assert.equal(validateInstantLeadFollowupConfig({ respect_business_hours: 1 }).ok, false, "number");
  assert.equal(validateInstantLeadFollowupConfig({ respect_business_hours: null }).ok, false, "null value");
  assert.equal(validateInstantLeadFollowupConfig(null).ok, false, "null input");
  assert.equal(validateInstantLeadFollowupConfig([true]).ok, false, "array input");
  assert.equal(validateInstantLeadFollowupConfig({}).ok, false, "missing field");
  assert.equal(validateInstantLeadFollowupConfig({ respect_business_hours: true, extra_field: "x" }).ok, false, "unknown property");
});

test("V2.2: a malformed stored config (wrong type, or an array) safely falls back to the default of false", () => {
  assert.deepEqual(readInstantLeadFollowupConfig({ respect_business_hours: "true" }), { respect_business_hours: false });
  assert.deepEqual(readInstantLeadFollowupConfig({ respect_business_hours: 1 }), { respect_business_hours: false });
  assert.deepEqual(readInstantLeadFollowupConfig([true]), { respect_business_hours: false });
  assert.deepEqual(readInstantLeadFollowupConfig("not an object"), { respect_business_hours: false });
});

test("V2.2: saving an identical config produces no audit plan (no-op save)", () => {
  assert.equal(shouldAuditConfigUpdate({ respect_business_hours: false }, { respect_business_hours: false }), null);
});

test("V2.2: saving a changed config produces exactly one automation_config_updated plan with only the before/after values", () => {
  const plan = shouldAuditConfigUpdate({ respect_business_hours: false }, { respect_business_hours: true });
  assert.deepEqual(plan, {
    action: "automation_config_updated",
    metadata: { previous_config: { respect_business_hours: false }, new_config: { respect_business_hours: true } },
  });
});

test("V2.2: organization isolation - getAutomationConfigByOrganization keys strictly by organization_id for instant-lead-followup", async () => {
  const ORG_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const ORG_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const rows = [
    { organization_id: ORG_A, config: { respect_business_hours: true } },
    { organization_id: ORG_B, config: { respect_business_hours: false } },
  ];
  const client = {
    from: (table: string) => {
      assert.equal(table, "automation_settings");
      return { select: () => ({ eq: async () => ({ data: rows }) }) };
    },
  } as unknown as SupabaseClient;

  const map = await getAutomationConfigByOrganization(client, "instant-lead-followup");

  assert.deepEqual(readInstantLeadFollowupConfig(map.get(ORG_A)), { respect_business_hours: true });
  assert.deepEqual(readInstantLeadFollowupConfig(map.get(ORG_B)), { respect_business_hours: false });
  assert.deepEqual(readInstantLeadFollowupConfig(map.get("no-such-org")), { respect_business_hours: false }, "an org with no row still gets the default");
});

// Note on authorization/unauthenticated/non-admin-member scenarios and the
// "enabled cannot be changed" guarantee for updateInstantLeadFollowupConfig:
// identical rationale as the note above for updateInboundCustomerReplyConfig
// - it reuses requireOrgAdminSession/assertOrgAdmin unchanged, and its
// upsert payload is `{ organization_id, automation_id: "instant-lead-followup", config }`
// only.

// ============================================================================
// Automation Configuration V3 - lost-lead-nurture.touch_1_days / touch_2_days
// ============================================================================

test("V3: defaults are 3 and 14 days", () => {
  assert.deepEqual(readLostLeadNurtureConfig(null), { touch_1_days: 3, touch_2_days: 14 });
  assert.deepEqual(readLostLeadNurtureConfig(undefined), { touch_1_days: 3, touch_2_days: 14 });
  assert.deepEqual(readLostLeadNurtureConfig({}), { touch_1_days: 3, touch_2_days: 14 });
});

test("V3: valid values are accepted", () => {
  assert.deepEqual(validateLostLeadNurtureConfig({ touch_1_days: 1, touch_2_days: 2 }), { ok: true, value: { touch_1_days: 1, touch_2_days: 2 } });
  assert.deepEqual(validateLostLeadNurtureConfig({ touch_1_days: 3, touch_2_days: 14 }), { ok: true, value: { touch_1_days: 3, touch_2_days: 14 } });
  assert.deepEqual(validateLostLeadNurtureConfig({ touch_1_days: 5, touch_2_days: 20 }), { ok: true, value: { touch_1_days: 5, touch_2_days: 20 } });
});

test("V3: minimum bound (1) is accepted, below-minimum (0) is rejected", () => {
  assert.equal(validateLostLeadNurtureConfig({ touch_1_days: 1, touch_2_days: 90 }).ok, true, "1 is the minimum, valid");
  assert.equal(validateLostLeadNurtureConfig({ touch_1_days: 0, touch_2_days: 90 }).ok, false, "0 is below minimum");
  assert.equal(validateLostLeadNurtureConfig({ touch_1_days: 1, touch_2_days: 0 }).ok, false, "0 is below minimum for touch_2 too");
});

test("V3: maximum bound (90) is accepted, above-maximum (91) is rejected", () => {
  assert.equal(validateLostLeadNurtureConfig({ touch_1_days: 1, touch_2_days: 90 }).ok, true, "90 is the maximum, valid");
  assert.equal(validateLostLeadNurtureConfig({ touch_1_days: 91, touch_2_days: 92 }).ok, false, "91 is above maximum");
  assert.equal(validateLostLeadNurtureConfig({ touch_1_days: 1, touch_2_days: 91 }).ok, false, "91 is above maximum for touch_2 too");
});

test("V3: invalid values are rejected, never silently coerced", () => {
  const base = { touch_1_days: 3, touch_2_days: 14 };
  assert.equal(validateLostLeadNurtureConfig({ ...base, touch_1_days: 3.5 }).ok, false, "decimal");
  assert.equal(validateLostLeadNurtureConfig({ ...base, touch_1_days: "3" }).ok, false, "string");
  assert.equal(validateLostLeadNurtureConfig({ ...base, touch_1_days: null }).ok, false, "null value");
  assert.equal(validateLostLeadNurtureConfig(null).ok, false, "null input");
  assert.equal(validateLostLeadNurtureConfig([3, 14]).ok, false, "array input");
  assert.equal(validateLostLeadNurtureConfig({ ...base, touch_1_days: NaN }).ok, false, "NaN");
  assert.equal(validateLostLeadNurtureConfig({ ...base, touch_1_days: Infinity }).ok, false, "Infinity");
  assert.equal(validateLostLeadNurtureConfig({ ...base, touch_2_days: Infinity }).ok, false, "Infinity for touch_2");
  assert.equal(validateLostLeadNurtureConfig({ touch_1_days: 3, touch_2_days: 14, extra_field: "x" }).ok, false, "unknown property");
  assert.equal(validateLostLeadNurtureConfig({ touch_1_days: 3 }).ok, false, "missing touch_2_days");
});

test("V3: touch_2_days <= touch_1_days is rejected", () => {
  assert.equal(validateLostLeadNurtureConfig({ touch_1_days: 14, touch_2_days: 14 }).ok, false, "equal");
  assert.equal(validateLostLeadNurtureConfig({ touch_1_days: 14, touch_2_days: 3 }).ok, false, "second before first");
});

test("V3: a malformed stored config (out of range, wrong type, an array, or touch_2<=touch_1) safely falls back to the defaults of 3/14", () => {
  assert.deepEqual(readLostLeadNurtureConfig({ touch_1_days: 0, touch_2_days: 14 }), { touch_1_days: 3, touch_2_days: 14 });
  assert.deepEqual(readLostLeadNurtureConfig({ touch_1_days: 91, touch_2_days: 92 }), { touch_1_days: 3, touch_2_days: 14 });
  assert.deepEqual(readLostLeadNurtureConfig({ touch_1_days: "3", touch_2_days: 14 }), { touch_1_days: 3, touch_2_days: 14 });
  assert.deepEqual(readLostLeadNurtureConfig([3, 14]), { touch_1_days: 3, touch_2_days: 14 });
  assert.deepEqual(readLostLeadNurtureConfig("not an object"), { touch_1_days: 3, touch_2_days: 14 });
  assert.deepEqual(readLostLeadNurtureConfig({ touch_1_days: 14, touch_2_days: 3 }), { touch_1_days: 3, touch_2_days: 14 }, "touch_2 <= touch_1 falls back entirely");
});

test("V3: saving an identical config produces no audit plan (no-op save)", () => {
  const config = { touch_1_days: 3, touch_2_days: 14 };
  assert.equal(shouldAuditConfigUpdate(config, { ...config }), null);
});

test("V3: saving a changed config produces exactly one automation_config_updated plan with only the before/after values", () => {
  const plan = shouldAuditConfigUpdate({ touch_1_days: 3, touch_2_days: 14 }, { touch_1_days: 5, touch_2_days: 20 });
  assert.deepEqual(plan, {
    action: "automation_config_updated",
    metadata: {
      previous_config: { touch_1_days: 3, touch_2_days: 14 },
      new_config: { touch_1_days: 5, touch_2_days: 20 },
    },
  });
});

test("V3: organization isolation - getAutomationConfigByOrganization keys strictly by organization_id for lost-lead-nurture", async () => {
  const ORG_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const ORG_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const rows = [
    { organization_id: ORG_A, config: { touch_1_days: 5, touch_2_days: 20 } },
    { organization_id: ORG_B, config: { touch_1_days: 2, touch_2_days: 7 } },
  ];
  const client = {
    from: (table: string) => {
      assert.equal(table, "automation_settings");
      return { select: () => ({ eq: async () => ({ data: rows }) }) };
    },
  } as unknown as SupabaseClient;

  const map = await getAutomationConfigByOrganization(client, "lost-lead-nurture");

  assert.deepEqual(readLostLeadNurtureConfig(map.get(ORG_A)), { touch_1_days: 5, touch_2_days: 20 });
  assert.deepEqual(readLostLeadNurtureConfig(map.get(ORG_B)), { touch_1_days: 2, touch_2_days: 7 });
  assert.deepEqual(
    readLostLeadNurtureConfig(map.get("no-such-org")),
    { touch_1_days: 3, touch_2_days: 14 },
    "an org with no row still gets the default",
  );
});

// Note on authorization/unauthenticated/non-admin-member scenarios and the
// "enabled cannot be changed" guarantee for updateLostLeadNurtureConfig:
// identical rationale as the notes above for updateInboundCustomerReplyConfig/
// updateInstantLeadFollowupConfig - it reuses requireOrgAdminSession/
// assertOrgAdmin unchanged (no new authorization code was written for V3),
// and its upsert payload is
// `{ organization_id, automation_id: "lost-lead-nurture", config }` only -
// it never includes `enabled`. Those guarantees are already directly
// unit-tested against assertOrgAdmin itself in
// lib/automation/authorization.test.ts (tests A, B, D, E) - a Server Action
// cannot be unit tested in this repo (createClient() depends on
// next/headers, which requires a real request context), so re-asserting the
// identical, unmodified authorization chain here would not exercise any
// code this phase actually changed.

// ============================================================================
// Automation Configuration V4 - lead-reactivation.touch_1_days / touch_2_days
// ============================================================================

test("V4: defaults are 7 and 21 days", () => {
  assert.deepEqual(readLeadReactivationConfig(null), { touch_1_days: 7, touch_2_days: 21 });
  assert.deepEqual(readLeadReactivationConfig(undefined), { touch_1_days: 7, touch_2_days: 21 });
  assert.deepEqual(readLeadReactivationConfig({}), { touch_1_days: 7, touch_2_days: 21 });
});

test("V4: valid values are accepted", () => {
  assert.deepEqual(validateLeadReactivationConfig({ touch_1_days: 1, touch_2_days: 2 }), { ok: true, value: { touch_1_days: 1, touch_2_days: 2 } });
  assert.deepEqual(validateLeadReactivationConfig({ touch_1_days: 7, touch_2_days: 21 }), { ok: true, value: { touch_1_days: 7, touch_2_days: 21 } });
  assert.deepEqual(validateLeadReactivationConfig({ touch_1_days: 10, touch_2_days: 30 }), { ok: true, value: { touch_1_days: 10, touch_2_days: 30 } });
});

test("V4: minimum bound (1) is accepted, below-minimum (0) is rejected", () => {
  assert.equal(validateLeadReactivationConfig({ touch_1_days: 1, touch_2_days: 90 }).ok, true, "1 is the minimum, valid");
  assert.equal(validateLeadReactivationConfig({ touch_1_days: 0, touch_2_days: 90 }).ok, false, "0 is below minimum");
  assert.equal(validateLeadReactivationConfig({ touch_1_days: 1, touch_2_days: 0 }).ok, false, "0 is below minimum for touch_2 too");
});

test("V4: maximum bound (90) is accepted, above-maximum (91) is rejected", () => {
  assert.equal(validateLeadReactivationConfig({ touch_1_days: 1, touch_2_days: 90 }).ok, true, "90 is the maximum, valid");
  assert.equal(validateLeadReactivationConfig({ touch_1_days: 91, touch_2_days: 92 }).ok, false, "91 is above maximum");
  assert.equal(validateLeadReactivationConfig({ touch_1_days: 1, touch_2_days: 91 }).ok, false, "91 is above maximum for touch_2 too");
});

test("V4: invalid values are rejected, never silently coerced", () => {
  const base = { touch_1_days: 7, touch_2_days: 21 };
  assert.equal(validateLeadReactivationConfig({ ...base, touch_1_days: 7.5 }).ok, false, "decimal");
  assert.equal(validateLeadReactivationConfig({ ...base, touch_1_days: "7" }).ok, false, "string");
  assert.equal(validateLeadReactivationConfig({ ...base, touch_1_days: null }).ok, false, "null value");
  assert.equal(validateLeadReactivationConfig(null).ok, false, "null input");
  assert.equal(validateLeadReactivationConfig([7, 21]).ok, false, "array input");
  assert.equal(validateLeadReactivationConfig({ ...base, touch_1_days: NaN }).ok, false, "NaN");
  assert.equal(validateLeadReactivationConfig({ ...base, touch_1_days: Infinity }).ok, false, "Infinity");
  assert.equal(validateLeadReactivationConfig({ ...base, touch_2_days: Infinity }).ok, false, "Infinity for touch_2");
  assert.equal(validateLeadReactivationConfig({ touch_1_days: 7, touch_2_days: 21, extra_field: "x" }).ok, false, "unknown property");
  assert.equal(validateLeadReactivationConfig({ touch_1_days: 7 }).ok, false, "missing touch_2_days");
});

test("V4: touch_2_days <= touch_1_days is rejected", () => {
  assert.equal(validateLeadReactivationConfig({ touch_1_days: 21, touch_2_days: 21 }).ok, false, "equal");
  assert.equal(validateLeadReactivationConfig({ touch_1_days: 21, touch_2_days: 7 }).ok, false, "second before first");
});

test("V4: a malformed stored config (out of range, wrong type, an array, or touch_2<=touch_1) safely falls back to the defaults of 7/21", () => {
  assert.deepEqual(readLeadReactivationConfig({ touch_1_days: 0, touch_2_days: 21 }), { touch_1_days: 7, touch_2_days: 21 });
  assert.deepEqual(readLeadReactivationConfig({ touch_1_days: 91, touch_2_days: 92 }), { touch_1_days: 7, touch_2_days: 21 });
  assert.deepEqual(readLeadReactivationConfig({ touch_1_days: "7", touch_2_days: 21 }), { touch_1_days: 7, touch_2_days: 21 });
  assert.deepEqual(readLeadReactivationConfig([7, 21]), { touch_1_days: 7, touch_2_days: 21 });
  assert.deepEqual(readLeadReactivationConfig("not an object"), { touch_1_days: 7, touch_2_days: 21 });
  assert.deepEqual(readLeadReactivationConfig({ touch_1_days: 21, touch_2_days: 7 }), { touch_1_days: 7, touch_2_days: 21 }, "touch_2 <= touch_1 falls back entirely");
});

test("V4: saving an identical config produces no audit plan (no-op save)", () => {
  const config = { touch_1_days: 7, touch_2_days: 21 };
  assert.equal(shouldAuditConfigUpdate(config, { ...config }), null);
});

test("V4: saving a changed config produces exactly one automation_config_updated plan with only the before/after values", () => {
  const plan = shouldAuditConfigUpdate({ touch_1_days: 7, touch_2_days: 21 }, { touch_1_days: 10, touch_2_days: 30 });
  assert.deepEqual(plan, {
    action: "automation_config_updated",
    metadata: {
      previous_config: { touch_1_days: 7, touch_2_days: 21 },
      new_config: { touch_1_days: 10, touch_2_days: 30 },
    },
  });
});

test("V4: organization isolation - getAutomationConfigByOrganization keys strictly by organization_id for lead-reactivation", async () => {
  const ORG_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const ORG_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const rows = [
    { organization_id: ORG_A, config: { touch_1_days: 10, touch_2_days: 30 } },
    { organization_id: ORG_B, config: { touch_1_days: 3, touch_2_days: 9 } },
  ];
  const client = {
    from: (table: string) => {
      assert.equal(table, "automation_settings");
      return { select: () => ({ eq: async () => ({ data: rows }) }) };
    },
  } as unknown as SupabaseClient;

  const map = await getAutomationConfigByOrganization(client, "lead-reactivation");

  assert.deepEqual(readLeadReactivationConfig(map.get(ORG_A)), { touch_1_days: 10, touch_2_days: 30 });
  assert.deepEqual(readLeadReactivationConfig(map.get(ORG_B)), { touch_1_days: 3, touch_2_days: 9 });
  assert.deepEqual(
    readLeadReactivationConfig(map.get("no-such-org")),
    { touch_1_days: 7, touch_2_days: 21 },
    "an org with no row still gets the default",
  );
});

// Note on authorization/unauthenticated/non-admin-member scenarios and the
// "enabled cannot be changed" guarantee for updateLeadReactivationConfig:
// identical rationale as the notes above for updateLostLeadNurtureConfig/
// updateInstantLeadFollowupConfig - it reuses requireOrgAdminSession/
// assertOrgAdmin unchanged (no new authorization code was written for V4),
// and its upsert payload is
// `{ organization_id, automation_id: "lead-reactivation", config }` only -
// it never includes `enabled`. Those guarantees are already directly
// unit-tested against assertOrgAdmin itself in
// lib/automation/authorization.test.ts (tests A, B, D, E) - a Server Action
// cannot be unit tested in this repo (createClient() depends on
// next/headers, which requires a real request context), so re-asserting the
// identical, unmodified authorization chain here would not exercise any
// code this phase actually changed.

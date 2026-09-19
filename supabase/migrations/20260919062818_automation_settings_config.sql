-- Automation Configuration V1 - adds a config column to automation_settings.
--
-- Purely additive: one new nullable-by-default (but NOT NULL with a
-- default) jsonb column on an existing table. No table is created, no
-- existing column/constraint/policy/trigger is touched. organization_id,
-- automation_id, enabled, the unique(organization_id, automation_id)
-- constraint, updated_at's existing trigger, and every RLS policy from
-- Phase A (automation_settings_select/insert/update) are all unchanged.
--
-- Backwards compatible by construction: every existing row gets config =
-- '{}' via the column default, and every automation's own config reader
-- (lib/automation/settings.ts's readAppointmentReminderConfig/
-- readEstimateFollowupConfig) treats an empty object exactly like a
-- missing key - falling back to the same hardcoded default the automation
-- used before this column existed. No organization's behavior changes as
-- a result of this migration alone.
alter table public.automation_settings
  add column config jsonb not null default '{}'::jsonb;

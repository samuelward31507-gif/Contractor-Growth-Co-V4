-- Phase 3G-1 (Owner Digest): the owner's own on/off setting for the weekly
-- owner digest SMS.
--
-- STATUS: PENDING - not applied anywhere. See supabase/pending/README.md.
-- Apply BEFORE deploying the 3G-1 application code: the Settings form saves
-- this column, and that save fails until it exists. (Reads are tolerant -
-- getNotificationSettings falls back to the default when the column is
-- missing - so notifications keep working either way.)
--
-- Follows notify_on_automation_degraded's exact pattern
-- (supabase/migrations/20260926000000_automation_degraded_alert.sql): one
-- additive boolean, NOT NULL, default true, so every existing organization
-- gets the digest until its owner turns it off. No policy or grant changes -
-- the existing notification_settings row policies and table grants cover the
-- new column.
--
-- Idempotent. Rollback: owner_digest_notification_setting_rollback.sql.

alter table public.notification_settings
  add column if not exists notify_on_owner_digest boolean not null default true;

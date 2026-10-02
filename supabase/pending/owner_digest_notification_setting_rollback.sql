-- Rollback for owner_digest_notification_setting.sql. Revert the 3G-1
-- application code FIRST (the Settings form writes this column), then run
-- this. Drops only the one column the forward script added.

alter table public.notification_settings
  drop column if exists notify_on_owner_digest;

-- Rollback for lead_sms_consent.sql. Deploy code that no longer reads
-- leads.sms_consent BEFORE running this. Idempotent.
alter table public.leads drop constraint if exists leads_sms_consent_check;
alter table public.leads drop column if exists sms_consent;

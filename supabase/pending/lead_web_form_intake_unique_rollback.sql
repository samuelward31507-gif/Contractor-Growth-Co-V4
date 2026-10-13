-- Rollback for lead_web_form_intake_unique.sql. Run by a person (contains
-- DROP). The application keeps working without the column (it falls back to
-- inserting without the marker); concurrent web-form duplicates are then
-- possible again. Idempotent.

begin;

drop index if exists public.leads_one_new_web_form_intake_per_contact;
alter table public.leads drop constraint if exists leads_intake_channel_check;
alter table public.leads drop column if exists intake_channel;

commit;

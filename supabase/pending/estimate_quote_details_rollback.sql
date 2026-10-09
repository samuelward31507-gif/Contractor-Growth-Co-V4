-- Rollback for estimate_quote_details.sql. Deploy code that no longer reads
-- these first (the current code tolerates their absence). Drops the line
-- items, quote numbers, scope of work and terms - run by a person, it
-- contains DROP. Idempotent.
begin;
drop table if exists public.estimate_line_items;
drop function if exists public.estimate_line_items_guard();
drop trigger if exists estimates_number_immutable on public.estimates;
drop function if exists public.estimates_number_immutable();
drop trigger if exists estimates_assign_number on public.estimates;
drop function if exists public.estimates_assign_number();
alter table public.estimates drop constraint if exists estimates_org_number_unique;
alter table public.estimates drop constraint if exists estimates_number_positive;
alter table public.estimates drop column if exists number;
alter table public.estimates drop constraint if exists estimates_terms_length;
alter table public.estimates drop constraint if exists estimates_scope_of_work_length;
alter table public.estimates drop column if exists terms;
alter table public.estimates drop column if exists scope_of_work;
commit;

-- Rollback for founder_daily_focus.sql. The application tolerates the
-- columns being absent (priorities show as unavailable). Removes every
-- daily-priority marking - the items themselves are kept. Idempotent.
begin;
drop trigger if exists founder_items_focus_guard on public.founder_items;
drop function if exists public.founder_items_focus_guard();
drop index if exists public.idx_founder_items_owner_focus;
alter table public.founder_items drop constraint if exists founder_items_focus_pair;
alter table public.founder_items drop column if exists focus_rank;
alter table public.founder_items drop column if exists focus_date;
commit;

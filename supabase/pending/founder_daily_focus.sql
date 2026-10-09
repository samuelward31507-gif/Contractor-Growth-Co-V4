-- Founder daily priorities: mark up to three founder_items as the day's most
-- important outcomes, in order.
--
-- STATUS: PENDING - not applied anywhere. Apply with the procedure in
-- supabase/pending/README.md; validate first with
-- supabase/pending/scratch/validate-founder-daily-focus.mjs.
-- Until it is applied, /founder shows the priorities section as unavailable
-- and everything else works (the columns are read in a separate query).
--
-- Why a schema change: nothing on founder_items says "this is one of my
-- three outcomes for <day>, in position N". `priority` (high/medium/low) is
-- an attribute many tasks share with no day or order; `due_at` is when work
-- is due, not which day it is a top outcome; founder_reviews.priorities_next
-- is free text that can't be completed or linked. So a priority stays an
-- ordinary item (no second task system) with two nullable columns:
--   focus_date - the local calendar day it is a priority for
--   focus_rank - its position that day, 1..3
-- A trigger keeps at most three per founder per day (serialized per day
-- with an advisory lock) and refuses events and meetings, which aren't
-- outcomes. The existing founder_items_founder_only RLS policy, grants, and
-- the same-owner deal guard cover the new columns unchanged.
--
-- Idempotent. Rollback: founder_daily_focus_rollback.sql.

begin;

alter table public.founder_items
  add column if not exists focus_date date,
  add column if not exists focus_rank smallint;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'founder_items_focus_pair') then
    alter table public.founder_items add constraint founder_items_focus_pair
      check ((focus_date is null and focus_rank is null) or (focus_date is not null and focus_rank is not null and focus_rank between 1 and 3));
  end if;
end $$;

create index if not exists idx_founder_items_owner_focus on public.founder_items (owner_id, focus_date) where focus_date is not null;

comment on column public.founder_items.focus_date is 'The local day this item is one of the founder''s top outcomes for (null = not a daily priority).';
comment on column public.founder_items.focus_rank is 'Its position among that day''s priorities, 1..3.';

create or replace function public.founder_items_focus_guard()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_count integer;
begin
  if new.focus_date is null then
    return new;
  end if;
  if new.kind in ('event', 'meeting') then
    raise exception 'events and meetings cannot be daily priorities';
  end if;
  if tg_op = 'UPDATE' and old.focus_date is not distinct from new.focus_date then
    return new; -- reordering or editing within the same day
  end if;
  perform pg_advisory_xact_lock(hashtextextended(new.owner_id::text || ':' || new.focus_date::text, 0));
  select count(*) into v_count from public.founder_items
    where owner_id = new.owner_id and focus_date = new.focus_date and id <> new.id;
  if v_count >= 3 then
    raise exception 'a day can have at most three priorities';
  end if;
  return new;
end;
$$;

create or replace trigger founder_items_focus_guard
  before insert or update of focus_date, focus_rank, kind on public.founder_items
  for each row execute function public.founder_items_focus_guard();

commit;

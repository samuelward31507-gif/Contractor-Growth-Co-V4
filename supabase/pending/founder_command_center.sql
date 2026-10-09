-- Founder Command Center: a private workspace for the founder - tasks and
-- events, a sales pipeline, manually entered MRR, and a daily review.
--
-- STATUS: PENDING - not applied anywhere. Apply with the procedure in
-- supabase/pending/README.md; validate first with
-- supabase/pending/scratch/validate-founder-command-center.mjs.
-- Until it is applied (and a founder row granted), /founder returns 404 for
-- everyone - the application treats a missing is_founder() as "not a founder".
--
-- Access model (strict, enforced in the database, not by navigation):
--   * public.founder_users is an allow-list. Like agency_admins it has no
--     INSERT/UPDATE/DELETE policy: granting founder access is an out-of-band
--     operation by a person with database access:
--       insert into public.founder_users (user_id) values ('<auth user id>');
--     It is deliberately separate from agency_admins - an agency admin is
--     NOT a founder unless granted here too.
--   * public.is_founder() - security definer, true only for the caller.
--   * Every founder_* table carries owner_id (defaulting to auth.uid()) and
--     every RLS policy requires owner_id = auth.uid() AND is_founder(): a
--     founder sees only their own rows, and anyone removed from the
--     allow-list loses access to everything at once. anon has no grants.
--   * None of this is organization data and none of it mixes with contractor
--     revenue: founder_mrr_entries are the founder's own numbers, entered by
--     hand (source = 'manual' is the only allowed value - nothing syncs).
--
-- Idempotent. Rollback: founder_command_center_rollback.sql.

begin;

create table if not exists public.founder_users (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  timezone text not null default 'America/Denver' check (char_length(timezone) between 1 and 64),
  created_at timestamp with time zone not null default now()
);
alter table public.founder_users enable row level security;

create or replace function public.is_founder()
returns boolean
language sql
stable
security definer
set search_path = 'public'
as $$
  select exists (select 1 from public.founder_users where user_id = auth.uid());
$$;

revoke all on function public.is_founder() from public, anon;
grant execute on function public.is_founder() to authenticated, service_role;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'founder_users' and policyname = 'founder_users_select_self') then
    create policy founder_users_select_self on public.founder_users for select to authenticated using (user_id = auth.uid());
  end if;
end $$;
revoke all on public.founder_users from anon;
grant select on public.founder_users to authenticated;
grant all on public.founder_users to service_role;

-- Deals ---------------------------------------------------------------------

create table if not exists public.founder_deals (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  contact_name text check (contact_name is null or char_length(contact_name) <= 200),
  contact_email text check (contact_email is null or char_length(contact_email) <= 320),
  stage text not null default 'lead' check (stage in ('lead', 'contacted', 'meeting_booked', 'demo_proposal', 'negotiation', 'won', 'lost')),
  expected_mrr numeric(12, 2) check (expected_mrr is null or expected_mrr >= 0),
  next_action text check (next_action is null or char_length(next_action) <= 500),
  next_action_at timestamp with time zone,
  won_amount numeric(12, 2) check (won_amount is null or won_amount >= 0),
  won_on date,
  lost_reason text check (lost_reason is null or char_length(lost_reason) <= 500),
  notes text check (notes is null or char_length(notes) <= 5000),
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint founder_deals_won_complete check (stage <> 'won' or (won_amount is not null and won_on is not null))
);
create index if not exists idx_founder_deals_owner_stage on public.founder_deals (owner_id, stage);
create index if not exists idx_founder_deals_owner_next on public.founder_deals (owner_id, next_action_at);

-- Tasks and events ----------------------------------------------------------

create table if not exists public.founder_items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null default 'task' check (kind in ('task', 'follow_up', 'deadline', 'event', 'meeting')),
  title text not null check (char_length(btrim(title)) between 1 and 300),
  notes text check (notes is null or char_length(notes) <= 5000),
  priority text not null default 'medium' check (priority in ('high', 'medium', 'low')),
  due_at timestamp with time zone,
  starts_at timestamp with time zone,
  ends_at timestamp with time zone,
  completed_at timestamp with time zone,
  deal_id uuid references public.founder_deals(id) on delete set null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint founder_items_event_has_start check (kind not in ('event', 'meeting') or starts_at is not null),
  constraint founder_items_end_after_start check (ends_at is null or (starts_at is not null and ends_at >= starts_at))
);
create index if not exists idx_founder_items_owner_open on public.founder_items (owner_id, completed_at, due_at);
create index if not exists idx_founder_items_owner_starts on public.founder_items (owner_id, starts_at);

-- A linked deal must belong to the same founder.
create or replace function public.founder_items_guard()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  if new.deal_id is not null and not exists (select 1 from public.founder_deals where id = new.deal_id and owner_id = new.owner_id) then
    raise exception 'linked deal must belong to the same founder';
  end if;
  if tg_op = 'UPDATE' and new.owner_id <> old.owner_id then
    raise exception 'owner_id is immutable';
  end if;
  return new;
end;
$$;
create or replace trigger founder_items_guard before insert or update on public.founder_items for each row execute function public.founder_items_guard();

-- MRR (manual) --------------------------------------------------------------

create table if not exists public.founder_mrr_entries (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  month date not null check (extract(day from month) = 1),
  kind text not null check (kind in ('starting', 'new', 'expansion', 'contraction', 'churn', 'one_time')),
  amount numeric(12, 2) not null check (amount >= 0),
  is_forecast boolean not null default false,
  customer text check (customer is null or char_length(customer) <= 200),
  description text check (description is null or char_length(description) <= 500),
  source text not null default 'manual' check (source = 'manual'),
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);
create index if not exists idx_founder_mrr_owner_month on public.founder_mrr_entries (owner_id, month);

-- Daily review --------------------------------------------------------------

create table if not exists public.founder_reviews (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  review_date date not null,
  wins text check (wins is null or char_length(wins) <= 5000),
  blockers text check (blockers is null or char_length(blockers) <= 5000),
  priorities_next text check (priorities_next is null or char_length(priorities_next) <= 5000),
  notes text check (notes is null or char_length(notes) <= 5000),
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint founder_reviews_owner_date unique (owner_id, review_date)
);

-- Shared: updated_at, owner immutability, RLS, grants -------------------------

create or replace function public.founder_owner_immutable()
returns trigger
language plpgsql
set search_path = 'public'
as $$
begin
  if new.owner_id <> old.owner_id then
    raise exception 'owner_id is immutable';
  end if;
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['founder_deals', 'founder_items', 'founder_mrr_entries', 'founder_reviews'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create or replace trigger %I before update on public.%I for each row execute function set_updated_at()', t || '_updated_at', t);
    if t <> 'founder_items' then
      execute format('create or replace trigger %I before update on public.%I for each row execute function public.founder_owner_immutable()', t || '_owner_immutable', t);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_founder_only') then
      execute format(
        'create policy %I on public.%I for all to authenticated using (owner_id = auth.uid() and public.is_founder()) with check (owner_id = auth.uid() and public.is_founder())',
        t || '_founder_only', t
      );
    end if;
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

commit;

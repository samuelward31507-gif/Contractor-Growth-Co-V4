-- Founder sales operating system (Phase 1): the ten-stage pipeline, separate
-- setup/monthly terms (expected and won, with currency), and an append-only
-- activity history that every stage change is recorded in.
--
-- STATUS: PENDING. Requires founder_command_center.sql. Validate first with
-- supabase/pending/scratch/validate-founder-sales-os.mjs; apply to TEST only.
--
-- Why a schema change: founder_deals records where a deal is now, not how it
-- got there. Nothing says when outreach went out, whether the prospect
-- replied, whether a booked meeting happened, or when a stage changed - so
-- follow-ups, stalls, cold prospects and conversion could only be guessed
-- from updated_at. And a win was a single amount, mixing the one-time setup
-- fee with the monthly fee.
--
-- What it adds:
--  * founder_deals: stages identified -> qualified -> outreach -> replied ->
--    meeting_booked -> meeting_held -> proposal_sent -> negotiation ->
--    won | lost (legacy values map 1:1: lead->identified,
--    contacted->outreach, demo_proposal->proposal_sent); prospect fields
--    (source, trade, location, website, phone, fit); currency; expected and
--    won setup and monthly fees (expected_mrr is the expected monthly fee);
--    lost_on; entered_stage / stage_changed_at / last_activity_at.
--  * founder_deal_activities: what was recorded as happening on a deal -
--    outreach, replies, meetings booked/held/no-show, demos, audits,
--    proposals, notes - plus every stage change, win (with the agreed
--    terms), loss (with the reason) and reopening. Source is 'manual' only:
--    nothing here is synced from email, a calendar or a payment provider.
--
-- Integrity:
--  * Append-only. Authenticated users can only SELECT their own rows (RLS:
--    owner_id = auth.uid() and is_founder()). Rows are written only by the
--    SECURITY DEFINER functions below, which check is_founder() and deal
--    ownership themselves. A trigger refuses every UPDATE except a one-time
--    void of a non-stage entry (with a reason), and refuses DELETE while the
--    deal still exists - so recorded history can't be rewritten or removed.
--  * Stage, outcome and history fields on founder_deals change only through
--    founder_change_deal_stage / founder_log_deal_activity (a guard trigger
--    refuses direct writes), so a stage change and its activity are saved
--    together or not at all.
--  * Each call carries a client request id (the activity's id): a retried
--    request returns 'duplicate' and writes nothing. Calls that change a
--    stage carry the deal's updated_at and are refused if it changed.
--  * A win needs setup fee, monthly fee, currency and date; a loss needs a
--    reason; won/lost deals reopen to an open stage (recorded) before
--    changing outcome. A deal with recorded activity can't be deleted.
--
-- Idempotent. Aborts (changes nothing) if a legacy won deal has no split
-- terms or a lost deal has no reason - those need a person to fill them in.
-- Rollback (non-destructive): founder_sales_os_rollback.sql.

begin;

-- The guard trigger (section 3) lets this migration's own data steps through
-- on re-runs; the setting is local to this transaction.
select set_config('founder.sales_write', 'on', true);

-- 1. Deal columns ----------------------------------------------------------------

alter table public.founder_deals
  add column if not exists source text,
  add column if not exists trade text,
  add column if not exists location text,
  add column if not exists website text,
  add column if not exists contact_phone text,
  add column if not exists fit text,
  add column if not exists currency text not null default 'USD',
  add column if not exists expected_setup_fee numeric(12, 2),
  add column if not exists won_setup_fee numeric(12, 2),
  add column if not exists won_monthly_fee numeric(12, 2),
  add column if not exists lost_on date,
  add column if not exists entered_stage text,
  add column if not exists stage_changed_at timestamp with time zone,
  add column if not exists last_activity_at timestamp with time zone;

comment on column public.founder_deals.expected_mrr is 'Expected monthly fee (recurring), before the deal is won. Not collected revenue.';
comment on column public.founder_deals.expected_setup_fee is 'Expected one-time setup fee, before the deal is won. Not collected revenue.';
comment on column public.founder_deals.won_setup_fee is 'Agreed one-time setup fee when won (contracted, not collected).';
comment on column public.founder_deals.won_monthly_fee is 'Agreed monthly fee when won (contracted, not collected).';
comment on column public.founder_deals.won_amount is 'Legacy single won amount (before setup/monthly were separate). Not written by the app any more.';
comment on column public.founder_deals.entered_stage is 'The stage the deal was created at - a snapshot, not evidence it passed earlier stages.';
comment on column public.founder_deals.last_activity_at is 'When the latest recorded (non-voided at the time) activity happened.';

-- Legacy rows that can't be carried over honestly stop the migration.
do $$
begin
  if exists (select 1 from public.founder_deals where stage = 'won' and (won_setup_fee is null or won_monthly_fee is null)) then
    raise exception 'founder_sales_os: % won deal(s) have no separate setup and monthly terms; enter them before applying', (select count(*) from public.founder_deals where stage = 'won' and (won_setup_fee is null or won_monthly_fee is null));
  end if;
  if exists (select 1 from public.founder_deals where stage = 'lost' and (lost_reason is null or btrim(lost_reason) = '')) then
    raise exception 'founder_sales_os: lost deal(s) have no reason; enter one before applying';
  end if;
end $$;

alter table public.founder_deals drop constraint if exists founder_deals_stage_check;
alter table public.founder_deals drop constraint if exists founder_deals_won_complete;
alter table public.founder_deals drop constraint if exists founder_deals_won_complete_compat;

-- 1:1 legacy mapping (reversible); then the snapshot fields for existing rows.
update public.founder_deals set stage = case stage when 'lead' then 'identified' when 'contacted' then 'outreach' when 'demo_proposal' then 'proposal_sent' else stage end
  where stage in ('lead', 'contacted', 'demo_proposal');
update public.founder_deals set entered_stage = stage where entered_stage is null;
update public.founder_deals set stage_changed_at = updated_at where stage_changed_at is null;
update public.founder_deals set lost_on = (updated_at at time zone 'UTC')::date where stage = 'lost' and lost_on is null;

alter table public.founder_deals alter column stage set default 'identified';

do $$
declare
  c record;
begin
  for c in select * from (values
    ('founder_deals_stage_check', 'check (stage in (''identified'', ''qualified'', ''outreach'', ''replied'', ''meeting_booked'', ''meeting_held'', ''proposal_sent'', ''negotiation'', ''won'', ''lost''))'),
    ('founder_deals_entered_stage_check', 'check (entered_stage is null or entered_stage in (''identified'', ''qualified'', ''outreach'', ''replied'', ''meeting_booked'', ''meeting_held'', ''proposal_sent'', ''negotiation'', ''won'', ''lost''))'),
    ('founder_deals_won_terms', 'check (stage <> ''won'' or (won_setup_fee is not null and won_monthly_fee is not null and won_on is not null))'),
    ('founder_deals_lost_reason_required', 'check (stage <> ''lost'' or (lost_reason is not null and btrim(lost_reason) <> ''''))'),
    ('founder_deals_source_check', 'check (source is null or source in (''outbound'', ''referral'', ''inbound'', ''network'', ''event'', ''partner'', ''other''))'),
    ('founder_deals_fit_check', 'check (fit is null or fit in (''strong'', ''possible'', ''poor''))'),
    ('founder_deals_currency_check', 'check (currency ~ ''^[A-Z]{3}$'')'),
    ('founder_deals_fees_check', 'check ((expected_setup_fee is null or expected_setup_fee >= 0) and (won_setup_fee is null or won_setup_fee >= 0) and (won_monthly_fee is null or won_monthly_fee >= 0))'),
    ('founder_deals_profile_lengths', 'check ((trade is null or char_length(trade) <= 100) and (location is null or char_length(location) <= 200) and (website is null or char_length(website) <= 300) and (contact_phone is null or char_length(contact_phone) <= 40))')
  ) as t(name, def) loop
    if not exists (select 1 from pg_constraint where conrelid = 'public.founder_deals'::regclass and conname = c.name) then
      execute format('alter table public.founder_deals add constraint %I %s', c.name, c.def);
    end if;
  end loop;
end $$;

-- 2. Activity history ----------------------------------------------------------------

create table if not exists public.founder_deal_activities (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  -- NO ACTION: a deal with history can't be deleted (mark it lost instead).
  deal_id uuid not null references public.founder_deals(id),
  kind text not null check (kind in (
    'outreach', 'reply_received', 'meeting_booked', 'meeting_held', 'meeting_no_show',
    'demo_completed', 'audit_completed', 'proposal_sent', 'note',
    'stage_change', 'won', 'lost', 'reopened'
  )),
  occurred_at timestamp with time zone not null,
  channel text check (channel is null or channel in ('email', 'phone', 'text', 'social', 'in_person', 'video', 'other')),
  scheduled_for timestamp with time zone,
  summary text check (summary is null or char_length(summary) <= 1000),
  from_stage text,
  to_stage text,
  setup_fee numeric(12, 2) check (setup_fee is null or setup_fee >= 0),
  monthly_fee numeric(12, 2) check (monthly_fee is null or monthly_fee >= 0),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  source text not null default 'manual' check (source = 'manual'),
  voided_at timestamp with time zone,
  void_reason text check (void_reason is null or char_length(void_reason) <= 500),
  recorded_at timestamp with time zone not null default now(),
  constraint founder_deal_activities_stage_shape check (
    (kind in ('stage_change', 'won', 'lost', 'reopened') and to_stage is not null and from_stage is not null)
    or (kind not in ('stage_change', 'won', 'lost', 'reopened') and to_stage is null and from_stage is null)
  ),
  constraint founder_deal_activities_won_terms check (kind <> 'won' or (setup_fee is not null and monthly_fee is not null and currency is not null)),
  constraint founder_deal_activities_scheduled_only_meetings check (scheduled_for is null or kind = 'meeting_booked'),
  constraint founder_deal_activities_void_pair check ((voided_at is null) = (void_reason is null))
);

create index if not exists idx_founder_deal_activities_deal on public.founder_deal_activities (owner_id, deal_id, occurred_at desc);
create index if not exists idx_founder_deal_activities_owner_time on public.founder_deal_activities (owner_id, occurred_at);
create index if not exists idx_founder_deal_activities_deal_fk on public.founder_deal_activities (deal_id);

comment on table public.founder_deal_activities is 'Append-only record of what was logged as happening on a founder deal (manual entries) and of every stage change. Written only by founder_* SECURITY DEFINER functions.';

alter table public.founder_deal_activities enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'founder_deal_activities' and policyname = 'founder_deal_activities_select_own') then
    create policy founder_deal_activities_select_own on public.founder_deal_activities for select to authenticated using (owner_id = auth.uid() and public.is_founder());
  end if;
end $$;
revoke all on public.founder_deal_activities from public, anon, authenticated;
grant select on public.founder_deal_activities to authenticated;
grant select, insert, update, delete on public.founder_deal_activities to service_role;

-- Append-only: no edits except a one-time void of a non-stage entry; no
-- deletes while the deal exists (deleting the user account still cascades).
create or replace function public.founder_deal_activities_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    -- pg_trigger_depth() > 1: removed by a cascade (the user account was
    -- deleted), not by a direct DELETE.
    if pg_trigger_depth() <= 1 and exists (select 1 from public.founder_deals d where d.id = old.deal_id) then
      raise exception 'sales activity history is append-only' using errcode = 'FS403';
    end if;
    return old;
  end if;
  if old.voided_at is not null
     or new.voided_at is null
     or old.kind in ('stage_change', 'won', 'lost', 'reopened')
     or (to_jsonb(new) - 'voided_at' - 'void_reason') is distinct from (to_jsonb(old) - 'voided_at' - 'void_reason') then
    raise exception 'sales activity history is append-only (only a one-time void is allowed)' using errcode = 'FS403';
  end if;
  return new;
end;
$$;

create or replace trigger founder_deal_activities_append_only
  before update or delete on public.founder_deal_activities
  for each row execute function public.founder_deal_activities_append_only();

-- 3. Guard: stage, outcome and history fields only through the functions ------

create or replace function public.founder_deals_sales_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(current_setting('founder.sales_write', true), '') = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.stage in ('won', 'lost') then
      raise exception 'create the deal at an open stage, then record the win or loss' using errcode = 'FS422';
    end if;
    new.entered_stage := new.stage;
    new.stage_changed_at := now();
    new.last_activity_at := null;
    new.won_setup_fee := null;
    new.won_monthly_fee := null;
    new.won_amount := null;
    new.won_on := null;
    new.lost_reason := null;
    new.lost_on := null;
    return new;
  end if;
  if new.stage is distinct from old.stage
     or new.won_setup_fee is distinct from old.won_setup_fee
     or new.won_monthly_fee is distinct from old.won_monthly_fee
     or new.won_amount is distinct from old.won_amount
     or new.won_on is distinct from old.won_on
     or new.lost_reason is distinct from old.lost_reason
     or new.lost_on is distinct from old.lost_on
     or new.entered_stage is distinct from old.entered_stage
     or new.stage_changed_at is distinct from old.stage_changed_at
     or new.last_activity_at is distinct from old.last_activity_at then
    raise exception 'stage and outcome changes are recorded through founder_change_deal_stage' using errcode = 'FS422';
  end if;
  return new;
end;
$$;

create or replace trigger founder_deals_sales_guard
  before insert or update on public.founder_deals
  for each row execute function public.founder_deals_sales_guard();

-- 4. Writers -------------------------------------------------------------------------

create or replace function public.founder_sales_stage_rank(p_stage text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select array_position(array['identified', 'qualified', 'outreach', 'replied', 'meeting_booked', 'meeting_held', 'proposal_sent', 'negotiation', 'won', 'lost']::text[], p_stage);
$$;

-- Internal: validates and applies one stage change on a deal row the caller
-- already locked and owns, and records it. Not callable by clients.
create or replace function public.founder_sales_apply_stage(
  p_deal public.founder_deals,
  p_activity_id uuid,
  p_to_stage text,
  p_occurred_at timestamp with time zone,
  p_setup_fee numeric,
  p_monthly_fee numeric,
  p_currency text,
  p_won_on date,
  p_reason text
) returns timestamp with time zone
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_currency text := coalesce(nullif(upper(btrim(p_currency)), ''), p_deal.currency);
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_today date := (now() at time zone coalesce((select f.timezone from public.founder_users f where f.user_id = p_deal.owner_id), 'America/Denver'))::date;
  v_updated timestamp with time zone;
begin
  if public.founder_sales_stage_rank(p_to_stage) is null then
    raise exception 'choose a valid stage' using errcode = 'FS422';
  end if;
  if p_to_stage = p_deal.stage then
    raise exception 'the deal is already at that stage' using errcode = 'FS422';
  end if;
  if p_deal.stage in ('won', 'lost') and p_to_stage in ('won', 'lost') then
    raise exception 'reopen the deal before changing its outcome' using errcode = 'FS422';
  end if;
  if p_occurred_at > now() + interval '5 minutes' then
    raise exception 'a stage change can''t be dated in the future' using errcode = 'FS422';
  end if;
  if v_reason is not null and char_length(v_reason) > 500 then
    raise exception 'keep the note under 500 characters' using errcode = 'FS422';
  end if;

  v_kind := case when p_to_stage = 'won' then 'won' when p_to_stage = 'lost' then 'lost' when p_deal.stage in ('won', 'lost') then 'reopened' else 'stage_change' end;

  if v_kind = 'won' then
    if p_setup_fee is null or p_monthly_fee is null or p_setup_fee < 0 or p_monthly_fee < 0 or p_setup_fee > 9999999999 or p_monthly_fee > 9999999999 then
      raise exception 'enter the agreed setup fee and monthly fee (0 or more)' using errcode = 'FS422';
    end if;
    if v_currency !~ '^[A-Z]{3}$' then
      raise exception 'enter a three-letter currency code' using errcode = 'FS422';
    end if;
    if p_won_on is null or p_won_on > v_today then
      raise exception 'enter the date the deal was won (not in the future)' using errcode = 'FS422';
    end if;
  elsif v_kind = 'lost' then
    if v_reason is null then
      raise exception 'enter why the deal was lost' using errcode = 'FS422';
    end if;
  end if;

  perform set_config('founder.sales_write', 'on', true);

  insert into public.founder_deal_activities (id, owner_id, deal_id, kind, occurred_at, summary, from_stage, to_stage, setup_fee, monthly_fee, currency)
  values (
    p_activity_id, p_deal.owner_id, p_deal.id, v_kind, p_occurred_at, v_reason, p_deal.stage, p_to_stage,
    case when v_kind = 'won' then round(p_setup_fee, 2) end,
    case when v_kind = 'won' then round(p_monthly_fee, 2) end,
    case when v_kind = 'won' then v_currency end
  );

  update public.founder_deals d set
    stage = p_to_stage,
    stage_changed_at = p_occurred_at,
    last_activity_at = greatest(coalesce(d.last_activity_at, p_occurred_at), p_occurred_at),
    currency = case when v_kind = 'won' then v_currency else d.currency end,
    won_setup_fee = case when v_kind = 'won' then round(p_setup_fee, 2) end,
    won_monthly_fee = case when v_kind = 'won' then round(p_monthly_fee, 2) end,
    won_amount = null,
    won_on = case when v_kind = 'won' then p_won_on end,
    lost_reason = case when v_kind = 'lost' then v_reason end,
    lost_on = case when v_kind = 'lost' then (p_occurred_at at time zone coalesce((select f.timezone from public.founder_users f where f.user_id = p_deal.owner_id), 'America/Denver'))::date end
  where d.id = p_deal.id
  returning d.updated_at into v_updated;

  perform set_config('founder.sales_write', '', true);
  return v_updated;
end;
$$;

-- Locks and returns the caller's own deal, or raises not-found.
create or replace function public.founder_sales_lock_deal(p_deal_id uuid)
returns public.founder_deals
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deal public.founder_deals;
begin
  if auth.uid() is null or not public.is_founder() then
    raise exception 'not available' using errcode = 'FS404';
  end if;
  select * into v_deal from public.founder_deals d where d.id = p_deal_id and d.owner_id = auth.uid() for update;
  if not found then
    raise exception 'deal not found' using errcode = 'FS404';
  end if;
  return v_deal;
end;
$$;

-- A retried request: the activity id is already recorded for this deal.
create or replace function public.founder_sales_is_duplicate(p_request_id uuid, p_deal_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.founder_deal_activities;
begin
  select * into v_existing from public.founder_deal_activities a where a.id = p_request_id;
  if not found then
    return false;
  end if;
  if v_existing.owner_id <> auth.uid() or v_existing.deal_id <> p_deal_id then
    raise exception 'request id already used' using errcode = 'FS422';
  end if;
  return true;
end;
$$;

create or replace function public.founder_change_deal_stage(
  p_request_id uuid,
  p_deal_id uuid,
  p_to_stage text,
  p_expected_updated_at timestamp with time zone,
  p_occurred_at timestamp with time zone default null,
  p_setup_fee numeric default null,
  p_monthly_fee numeric default null,
  p_currency text default null,
  p_won_on date default null,
  p_reason text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deal public.founder_deals;
  v_updated timestamp with time zone;
begin
  if p_request_id is null or p_expected_updated_at is null then
    raise exception 'request id and expected version are required' using errcode = 'FS422';
  end if;
  v_deal := public.founder_sales_lock_deal(p_deal_id);
  if public.founder_sales_is_duplicate(p_request_id, p_deal_id) then
    return jsonb_build_object('status', 'duplicate', 'updated_at', v_deal.updated_at);
  end if;
  if v_deal.updated_at <> p_expected_updated_at then
    raise exception 'the deal changed since it was loaded' using errcode = 'FS409';
  end if;
  v_updated := public.founder_sales_apply_stage(v_deal, p_request_id, p_to_stage, coalesce(p_occurred_at, now()), p_setup_fee, p_monthly_fee, p_currency, p_won_on, p_reason);
  return jsonb_build_object('status', 'recorded', 'updated_at', v_updated);
end;
$$;

create or replace function public.founder_log_deal_activity(
  p_request_id uuid,
  p_deal_id uuid,
  p_kind text,
  p_occurred_at timestamp with time zone,
  p_channel text default null,
  p_summary text default null,
  p_scheduled_for timestamp with time zone default null,
  p_to_stage text default null,
  p_expected_updated_at timestamp with time zone default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deal public.founder_deals;
  v_summary text := nullif(btrim(coalesce(p_summary, '')), '');
  v_updated timestamp with time zone;
begin
  if p_request_id is null or p_occurred_at is null then
    raise exception 'request id and date are required' using errcode = 'FS422';
  end if;
  v_deal := public.founder_sales_lock_deal(p_deal_id);
  if public.founder_sales_is_duplicate(p_request_id, p_deal_id) then
    return jsonb_build_object('status', 'duplicate', 'updated_at', v_deal.updated_at);
  end if;
  if p_kind is null or p_kind not in ('outreach', 'reply_received', 'meeting_booked', 'meeting_held', 'meeting_no_show', 'demo_completed', 'audit_completed', 'proposal_sent', 'note') then
    raise exception 'choose what happened' using errcode = 'FS422';
  end if;
  if p_occurred_at > now() + interval '5 minutes' then
    raise exception 'only record things that have already happened' using errcode = 'FS422';
  end if;
  if p_channel is not null and p_channel not in ('email', 'phone', 'text', 'social', 'in_person', 'video', 'other') then
    raise exception 'choose a valid channel' using errcode = 'FS422';
  end if;
  if v_summary is not null and char_length(v_summary) > 1000 then
    raise exception 'keep the summary under 1,000 characters' using errcode = 'FS422';
  end if;
  if p_scheduled_for is not null and p_kind <> 'meeting_booked' then
    raise exception 'only a booked meeting has a scheduled time' using errcode = 'FS422';
  end if;
  if p_to_stage is not null then
    if p_to_stage in ('won', 'lost') or v_deal.stage in ('won', 'lost') then
      raise exception 'record wins, losses and reopening with the stage control' using errcode = 'FS422';
    end if;
    if p_expected_updated_at is null or v_deal.updated_at <> p_expected_updated_at then
      raise exception 'the deal changed since it was loaded' using errcode = 'FS409';
    end if;
  end if;

  perform set_config('founder.sales_write', 'on', true);
  insert into public.founder_deal_activities (id, owner_id, deal_id, kind, occurred_at, channel, scheduled_for, summary)
  values (p_request_id, v_deal.owner_id, v_deal.id, p_kind, p_occurred_at, p_channel, p_scheduled_for, v_summary);
  update public.founder_deals d set last_activity_at = greatest(coalesce(d.last_activity_at, p_occurred_at), p_occurred_at)
    where d.id = v_deal.id
    returning d.* into v_deal;
  perform set_config('founder.sales_write', '', true);

  if p_to_stage is not null and p_to_stage <> v_deal.stage then
    v_updated := public.founder_sales_apply_stage(v_deal, gen_random_uuid(), p_to_stage, p_occurred_at, null, null, null, null, null);
  else
    v_updated := v_deal.updated_at;
  end if;
  return jsonb_build_object('status', 'recorded', 'updated_at', v_updated);
end;
$$;

create or replace function public.founder_void_deal_activity(p_activity_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_activity public.founder_deal_activities;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if auth.uid() is null or not public.is_founder() then
    raise exception 'not available' using errcode = 'FS404';
  end if;
  select * into v_activity from public.founder_deal_activities a where a.id = p_activity_id and a.owner_id = auth.uid() for update;
  if not found then
    raise exception 'activity not found' using errcode = 'FS404';
  end if;
  if v_activity.voided_at is not null then
    return jsonb_build_object('status', 'duplicate');
  end if;
  if v_activity.kind in ('stage_change', 'won', 'lost', 'reopened') then
    raise exception 'stage history can''t be voided - change the stage again instead' using errcode = 'FS422';
  end if;
  if v_reason is null or char_length(v_reason) > 500 then
    raise exception 'say why this entry is wrong (up to 500 characters)' using errcode = 'FS422';
  end if;
  update public.founder_deal_activities set voided_at = now(), void_reason = v_reason where id = v_activity.id;
  return jsonb_build_object('status', 'recorded');
end;
$$;

revoke all on function public.founder_sales_stage_rank(text) from public, anon;
grant execute on function public.founder_sales_stage_rank(text) to authenticated, service_role;
revoke all on function public.founder_sales_apply_stage(public.founder_deals, uuid, text, timestamp with time zone, numeric, numeric, text, date, text) from public, anon, authenticated;
revoke all on function public.founder_sales_lock_deal(uuid) from public, anon, authenticated;
revoke all on function public.founder_sales_is_duplicate(uuid, uuid) from public, anon, authenticated;
revoke all on function public.founder_deal_activities_append_only() from public, anon, authenticated;
revoke all on function public.founder_deals_sales_guard() from public, anon, authenticated;
revoke all on function public.founder_change_deal_stage(uuid, uuid, text, timestamp with time zone, timestamp with time zone, numeric, numeric, text, date, text) from public, anon;
revoke all on function public.founder_log_deal_activity(uuid, uuid, text, timestamp with time zone, text, text, timestamp with time zone, text, timestamp with time zone) from public, anon;
revoke all on function public.founder_void_deal_activity(uuid, text) from public, anon;
grant execute on function public.founder_change_deal_stage(uuid, uuid, text, timestamp with time zone, timestamp with time zone, numeric, numeric, text, date, text) to authenticated;
grant execute on function public.founder_log_deal_activity(uuid, uuid, text, timestamp with time zone, text, text, timestamp with time zone, text, timestamp with time zone) to authenticated;
grant execute on function public.founder_void_deal_activity(uuid, text) to authenticated;

select set_config('founder.sales_write', '', true);
commit;

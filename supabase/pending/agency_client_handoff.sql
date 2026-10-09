-- Deal-to-client handoff (Phase 2): a won Founder deal becomes an Agency
-- client only through two explicit steps - the founder prepares a handoff,
-- an agency admin confirms it - and never touches a live client account.
--
-- STATUS: PENDING. Requires founder_command_center.sql, founder_sales_os.sql
-- and the agency_command_center_foundation migration (agency_admins,
-- is_agency_admin()). Validate with
-- supabase/pending/scratch/validate-agency-client-handoff.mjs; TEST only.
--
-- Three domains stay apart:
--  * founder_deals - the founder's private pipeline (owner + is_founder()).
--  * agency_clients - the Agency's own client record (agency admins only).
--    It is NOT an organization, NOT linked to agency_organizations, and NOT
--    a Trackpr contractor customer. organization_id stays empty until a
--    later, separate step links a Trackpr account.
--  * agency_client_handoffs - the bridge: a snapshot of only the approved
--    commercial fields (company, contact, agreed setup + monthly fee,
--    currency, scope) and who prepared / confirmed / cancelled it, when.
--    Readable by the deal's founder (status only - they supplied every
--    field) and by agency admins.
--
-- Rules (enforced here, again in the app):
--  * Prepare: founder only, their own deal, deal is Won with agreed terms,
--    a decision-maker name, an email or phone, and a written scope. One live
--    (non-cancelled) handoff per deal; the request id is the handoff id, so
--    a retry or a concurrent second prepare returns the existing one.
--  * Confirm: agency admins only. Locks the handoff, refuses if the deal is
--    no longer won or any carried field changed since it was prepared, then
--    creates the client and marks the handoff confirmed in ONE transaction -
--    nothing partial survives a failure. A repeated confirm returns the same
--    client. agency_clients.source_deal_id and source_handoff_id are UNIQUE,
--    so one deal can never produce two clients, whatever the timing.
--  * Cancel: the deal's founder or an agency admin, only while prepared, with
--    a reason. A cancelled handoff stays on record; a new one can be prepared.
--  * Snapshot fields can't change after preparing. Deal terms and the deal's
--    activity history are read, never written.
--
-- Idempotent. Rollback (non-destructive): agency_client_handoff_rollback.sql.

begin;

-- 1. Agency clients ------------------------------------------------------------------

create table if not exists public.agency_clients (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  contact_name text not null check (char_length(btrim(contact_name)) between 1 and 200),
  contact_email text check (contact_email is null or char_length(contact_email) <= 320),
  contact_phone text check (contact_phone is null or char_length(contact_phone) <= 40),
  setup_fee numeric(12, 2) not null check (setup_fee >= 0),
  monthly_fee numeric(12, 2) not null check (monthly_fee >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  scope text not null check (char_length(btrim(scope)) between 10 and 5000),
  status text not null default 'onboarding_not_started' check (status in ('onboarding_not_started')),
  -- A Trackpr account is linked later, by a separate explicit step - never here.
  organization_id uuid unique,
  -- Kept if the founder's deal or account is later removed; unique = one client per deal / handoff.
  source_deal_id uuid unique references public.founder_deals(id) on delete set null,
  source_handoff_id uuid unique,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint agency_clients_contact_route check (contact_email is not null or contact_phone is not null)
);
comment on table public.agency_clients is 'The Agency''s client record (Contractor Growth Co. client), created only by confirming a client handoff. Not a Trackpr organization or contractor customer.';

-- 2. Handoffs ------------------------------------------------------------------------

create table if not exists public.agency_client_handoffs (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.founder_deals(id),
  founder_owner_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'prepared' check (status in ('prepared', 'confirmed', 'cancelled')),
  client_name text not null check (char_length(btrim(client_name)) between 1 and 200),
  contact_name text not null check (char_length(btrim(contact_name)) between 1 and 200),
  contact_email text check (contact_email is null or char_length(contact_email) <= 320),
  contact_phone text check (contact_phone is null or char_length(contact_phone) <= 40),
  setup_fee numeric(12, 2) not null check (setup_fee >= 0),
  monthly_fee numeric(12, 2) not null check (monthly_fee >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  scope text not null check (char_length(btrim(scope)) between 10 and 5000),
  prepared_by uuid not null references auth.users(id) on delete cascade,
  prepared_at timestamp with time zone not null default now(),
  confirmed_by uuid references auth.users(id) on delete set null,
  confirmed_at timestamp with time zone,
  cancelled_by uuid references auth.users(id) on delete set null,
  cancelled_at timestamp with time zone,
  cancel_reason text check (cancel_reason is null or char_length(cancel_reason) <= 500),
  agency_client_id uuid unique references public.agency_clients(id),
  constraint agency_client_handoffs_contact_route check (contact_email is not null or contact_phone is not null),
  constraint agency_client_handoffs_state check (
    (status = 'prepared' and confirmed_at is null and cancelled_at is null and agency_client_id is null)
    or (status = 'confirmed' and confirmed_at is not null and confirmed_by is not null and agency_client_id is not null and cancelled_at is null)
    or (status = 'cancelled' and cancelled_at is not null and cancel_reason is not null and confirmed_at is null and agency_client_id is null)
  )
);
comment on table public.agency_client_handoffs is 'Founder deal -> Agency client handoff: snapshot of the approved commercial fields and who prepared, confirmed or cancelled it. Written only by the handoff functions.';

-- At most one live (prepared or confirmed) handoff per deal.
create unique index if not exists agency_client_handoffs_one_live_per_deal on public.agency_client_handoffs (deal_id) where status <> 'cancelled';
create index if not exists idx_agency_client_handoffs_owner on public.agency_client_handoffs (founder_owner_id, prepared_at desc);
create index if not exists idx_agency_client_handoffs_status on public.agency_client_handoffs (status, prepared_at desc);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agency_clients_source_handoff_fk') then
    alter table public.agency_clients add constraint agency_clients_source_handoff_fk foreign key (source_handoff_id) references public.agency_client_handoffs(id) on delete set null;
  end if;
end $$;

-- The prepared snapshot can't be rewritten - only the status columns move.
create or replace function public.agency_client_handoffs_snapshot_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (to_jsonb(new) - array['status', 'confirmed_by', 'confirmed_at', 'cancelled_by', 'cancelled_at', 'cancel_reason', 'agency_client_id'])
     is distinct from (to_jsonb(old) - array['status', 'confirmed_by', 'confirmed_at', 'cancelled_by', 'cancelled_at', 'cancel_reason', 'agency_client_id']) then
    raise exception 'a prepared handoff can''t be edited - cancel it and prepare a new one' using errcode = 'FS422';
  end if;
  if old.status <> 'prepared' and new.status is distinct from old.status then
    raise exception 'this handoff is already %', old.status using errcode = 'FS422';
  end if;
  return new;
end;
$$;
create or replace trigger agency_client_handoffs_snapshot_guard
  before update on public.agency_client_handoffs
  for each row execute function public.agency_client_handoffs_snapshot_guard();

-- 3. Access --------------------------------------------------------------------------

alter table public.agency_clients enable row level security;
alter table public.agency_client_handoffs enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'agency_clients' and policyname = 'agency_clients_agency_admin_select') then
    create policy agency_clients_agency_admin_select on public.agency_clients for select to authenticated using (public.is_agency_admin());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'agency_client_handoffs' and policyname = 'agency_client_handoffs_select') then
    create policy agency_client_handoffs_select on public.agency_client_handoffs for select to authenticated
      using ((founder_owner_id = auth.uid() and public.is_founder()) or public.is_agency_admin());
  end if;
end $$;
revoke all on public.agency_clients from public, anon, authenticated;
revoke all on public.agency_client_handoffs from public, anon, authenticated;
grant select on public.agency_clients to authenticated;
grant select on public.agency_client_handoffs to authenticated;
grant select, insert, update, delete on public.agency_clients to service_role;
grant select, insert, update, delete on public.agency_client_handoffs to service_role;

-- 4. Functions -----------------------------------------------------------------------

-- What a won deal still needs before it can be handed off (empty = ready).
create or replace function public.founder_handoff_missing(p_deal public.founder_deals, p_scope text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array_remove(array[
    case when p_deal.stage <> 'won' then 'the deal must be won' end,
    case when p_deal.won_setup_fee is null or p_deal.won_monthly_fee is null then 'agreed setup and monthly fees' end,
    case when p_deal.contact_name is null or btrim(p_deal.contact_name) = '' then 'a decision-maker name' end,
    case when coalesce(btrim(p_deal.contact_email), '') = '' and coalesce(btrim(p_deal.contact_phone), '') = '' then 'a contact email or phone' end,
    case when char_length(btrim(coalesce(p_scope, ''))) < 10 then 'a written scope (at least 10 characters)' end,
    case when char_length(btrim(coalesce(p_scope, ''))) > 5000 then 'a shorter scope (5,000 characters at most)' end
  ], null);
$$;

create or replace function public.founder_prepare_client_handoff(p_request_id uuid, p_deal_id uuid, p_scope text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deal public.founder_deals;
  v_existing public.agency_client_handoffs;
  v_missing text[];
begin
  if p_request_id is null then
    raise exception 'request id is required' using errcode = 'FS422';
  end if;
  if auth.uid() is null or not public.is_founder() then
    raise exception 'not available' using errcode = 'FS404';
  end if;
  select * into v_deal from public.founder_deals d where d.id = p_deal_id and d.owner_id = auth.uid() for update;
  if not found then
    raise exception 'deal not found' using errcode = 'FS404';
  end if;

  -- A retry of this request, or a live handoff prepared by an earlier one.
  select * into v_existing from public.agency_client_handoffs h where h.id = p_request_id;
  if found then
    if v_existing.deal_id <> p_deal_id or v_existing.founder_owner_id <> auth.uid() then
      raise exception 'request id already used' using errcode = 'FS422';
    end if;
    return jsonb_build_object('status', 'duplicate', 'handoff_id', v_existing.id, 'handoff_status', v_existing.status);
  end if;
  select * into v_existing from public.agency_client_handoffs h where h.deal_id = p_deal_id and h.status <> 'cancelled';
  if found then
    return jsonb_build_object('status', 'exists', 'handoff_id', v_existing.id, 'handoff_status', v_existing.status);
  end if;

  v_missing := public.founder_handoff_missing(v_deal, p_scope);
  if cardinality(v_missing) > 0 then
    raise exception 'before handing off, add: %', array_to_string(v_missing, '; ') using errcode = 'FS422';
  end if;

  insert into public.agency_client_handoffs (id, deal_id, founder_owner_id, client_name, contact_name, contact_email, contact_phone, setup_fee, monthly_fee, currency, scope, prepared_by)
  values (
    p_request_id, v_deal.id, v_deal.owner_id, btrim(v_deal.name), btrim(v_deal.contact_name), nullif(btrim(v_deal.contact_email), ''), nullif(btrim(v_deal.contact_phone), ''),
    v_deal.won_setup_fee, v_deal.won_monthly_fee, v_deal.currency, btrim(p_scope), auth.uid()
  );
  return jsonb_build_object('status', 'prepared', 'handoff_id', p_request_id, 'handoff_status', 'prepared');
end;
$$;

create or replace function public.agency_confirm_client_handoff(p_handoff_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_handoff public.agency_client_handoffs;
  v_deal public.founder_deals;
  v_client_id uuid;
begin
  if auth.uid() is null or not public.is_agency_admin() then
    raise exception 'not available' using errcode = 'FS404';
  end if;
  select * into v_handoff from public.agency_client_handoffs h where h.id = p_handoff_id for update;
  if not found then
    raise exception 'handoff not found' using errcode = 'FS404';
  end if;
  if v_handoff.status = 'confirmed' then
    return jsonb_build_object('status', 'duplicate', 'agency_client_id', v_handoff.agency_client_id);
  end if;
  if v_handoff.status = 'cancelled' then
    raise exception 'this handoff was cancelled' using errcode = 'FS409';
  end if;

  -- The deal must still say what the snapshot says.
  select * into v_deal from public.founder_deals d where d.id = v_handoff.deal_id for share;
  if not found
     or v_deal.stage <> 'won'
     or btrim(v_deal.name) is distinct from v_handoff.client_name
     or btrim(v_deal.contact_name) is distinct from v_handoff.contact_name
     or nullif(btrim(v_deal.contact_email), '') is distinct from v_handoff.contact_email
     or nullif(btrim(v_deal.contact_phone), '') is distinct from v_handoff.contact_phone
     or v_deal.won_setup_fee is distinct from v_handoff.setup_fee
     or v_deal.won_monthly_fee is distinct from v_handoff.monthly_fee
     or v_deal.currency is distinct from v_handoff.currency then
    raise exception 'the deal changed since this handoff was prepared - cancel it and prepare a new one' using errcode = 'FS409';
  end if;

  insert into public.agency_clients (name, contact_name, contact_email, contact_phone, setup_fee, monthly_fee, currency, scope, source_deal_id, source_handoff_id, created_by)
  values (v_handoff.client_name, v_handoff.contact_name, v_handoff.contact_email, v_handoff.contact_phone, v_handoff.setup_fee, v_handoff.monthly_fee, v_handoff.currency, v_handoff.scope, v_handoff.deal_id, v_handoff.id, auth.uid())
  returning id into v_client_id;

  update public.agency_client_handoffs
    set status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = now(), agency_client_id = v_client_id
    where id = v_handoff.id;
  return jsonb_build_object('status', 'confirmed', 'agency_client_id', v_client_id);
exception
  when unique_violation then
    raise exception 'an Agency client already exists for this deal' using errcode = 'FS409';
end;
$$;

create or replace function public.cancel_client_handoff(p_handoff_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_handoff public.agency_client_handoffs;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if auth.uid() is null then
    raise exception 'not available' using errcode = 'FS404';
  end if;
  select * into v_handoff from public.agency_client_handoffs h
    where h.id = p_handoff_id and ((h.founder_owner_id = auth.uid() and public.is_founder()) or public.is_agency_admin())
    for update;
  if not found then
    raise exception 'handoff not found' using errcode = 'FS404';
  end if;
  if v_handoff.status = 'cancelled' then
    return jsonb_build_object('status', 'duplicate');
  end if;
  if v_handoff.status = 'confirmed' then
    raise exception 'this handoff is confirmed - the Agency client already exists' using errcode = 'FS422';
  end if;
  if v_reason is null or char_length(v_reason) > 500 then
    raise exception 'say why the handoff is being cancelled (up to 500 characters)' using errcode = 'FS422';
  end if;
  update public.agency_client_handoffs set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = v_reason where id = v_handoff.id;
  return jsonb_build_object('status', 'cancelled');
end;
$$;

revoke all on function public.founder_handoff_missing(public.founder_deals, text) from public, anon;
grant execute on function public.founder_handoff_missing(public.founder_deals, text) to authenticated, service_role;
revoke all on function public.agency_client_handoffs_snapshot_guard() from public, anon, authenticated;
revoke all on function public.founder_prepare_client_handoff(uuid, uuid, text) from public, anon;
revoke all on function public.agency_confirm_client_handoff(uuid) from public, anon;
revoke all on function public.cancel_client_handoff(uuid, text) from public, anon;
grant execute on function public.founder_prepare_client_handoff(uuid, uuid, text) to authenticated;
grant execute on function public.agency_confirm_client_handoff(uuid) to authenticated;
grant execute on function public.cancel_client_handoff(uuid, text) to authenticated;

commit;

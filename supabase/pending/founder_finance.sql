-- Founder financial records (Phase 4, Stage 1): manual expenses, recurring
-- cost commitments, manual income received outside Stripe, manual cash
-- balances, an append-only audit history of every change, and three
-- founder-only, aggregate-only read functions over the Stripe revenue ledger
-- and the Agency's contracted fees.
--
-- STATUS: PENDING. TEST only. Requires founder_command_center.sql,
-- revenue_intelligence (revenue_events), agency_client_handoff.sql and
-- agency_client_delivery.sql. Validate first with
-- supabase/pending/scratch/validate-founder-finance.mjs.
--
-- Accounting rules this enforces (the app adds the period arithmetic):
--  * Cash basis: an expense counts when it is paid (paid_on); income counts
--    when it was received (received_on). Nothing is dated in the future.
--  * Every record is the founder's own entry (source = 'manual'). Nothing
--    here is synced from a bank, Stripe or any other provider, and nothing
--    is derived: a cash balance is only ever what the founder entered.
--  * Manual income is kept apart from Stripe revenue: a different table,
--    source = 'manual', and a received-via method that can't be Stripe.
--  * One amount per currency; no currency conversion anywhere. Manual
--    amounts are major units (dollars, yen) with at most the currency's own
--    decimal places (ISO 4217: JPY 0, USD 2, KWD 3) - checked by the
--    functions and again by each table. Stripe amounts stay in Stripe's minor
--    units; the Stripe reads return an exponent only where it is verified
--    (founder_stripe_verified_exponent) and NULL / 'unverified' otherwise, so
--    nothing assumes every currency has cents (see the display contract in
--    section 9).
--  * Prepayment: a payment may be dated before the expense it pays for
--    (annual plans, deposits). The only date rule is that nothing is paid,
--    received or measured in the future. There is no lower bound: no
--    accounting or business requirement fixes one, and an old date is the
--    founder's to enter and correct (with a reason) if wrong.
--  * Records are kept for good. A founder's account can't be deleted while
--    any financial record or finance history of theirs exists (ON DELETE
--    RESTRICT, plus a trigger that refuses every DELETE). A wrong record is
--    corrected (with a reason, before and after kept) or voided (with a
--    reason). A recurring cost's amount, currency and cadence are fixed once
--    created - a price change ends it and starts a new one, so past
--    commitments aren't rewritten.
--  * A recurring cost is paid at most once per month (one live expense per
--    cost per covered month), so a payment can't be counted twice.
--
-- Access:
--  * Every table carries owner_id; RLS lets a founder SELECT only their own
--    rows (owner_id = auth.uid() and is_founder()). There are no INSERT,
--    UPDATE or DELETE grants: every write goes through the SECURITY DEFINER
--    functions below, which check is_founder() and ownership themselves and
--    write an audit row in the same transaction. A guard trigger refuses
--    any other write - including from the service role.
--  * founder_stripe_revenue_summary, founder_stripe_unrecovered_invoices and
--    founder_contracted_mrr return per-currency totals only - no organization ids, client names or rows -
--    and only to a founder. They write nothing and change no grant or policy
--    on revenue_events or agency_clients.
--  * Not touched: revenue_events, the Stripe webhook, founder_mrr_entries,
--    organizations, Agency tables.
--
-- Idempotent. Rollback (non-destructive): founder_finance_rollback.sql.

begin;

-- 0. Currency decimal places ---------------------------------------------------------------

-- ISO 4217 minor-unit digits for manual amounts. NULL: not supported here (4-decimal
-- accounting units such as CLF/UYW, or anything malformed).
create or replace function public.founder_currency_minor_units(p_currency text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case
    when p_currency is null or p_currency !~ '^[A-Z]{3}$' then null
    when p_currency in ('CLF', 'UYW') then null
    when p_currency in ('BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF') then 0
    when p_currency in ('BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND') then 3
    else 2
  end;
$$;

-- 1. Tables ---------------------------------------------------------------------------

create table if not exists public.founder_recurring_costs (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete restrict,
  vendor text not null check (char_length(btrim(vendor)) between 1 and 200),
  category text not null check (category in ('software', 'hosting', 'telecom', 'payment_processing', 'contractors', 'payroll', 'marketing', 'professional_services', 'office', 'travel', 'insurance', 'other')),
  description text check (description is null or char_length(description) <= 500),
  amount numeric(15, 3) not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  cadence text not null check (cadence in ('monthly', 'annual')),
  start_on date not null,
  end_on date,
  source text not null default 'manual' check (source = 'manual'),
  voided_at timestamp with time zone,
  void_reason text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint founder_recurring_costs_end check (end_on is null or end_on >= start_on),
  constraint founder_recurring_costs_decimals check (public.founder_currency_minor_units(currency) is not null and amount = round(amount, public.founder_currency_minor_units(currency))),
  constraint founder_recurring_costs_void check ((voided_at is null) = (void_reason is null) and (void_reason is null or char_length(void_reason) between 1 and 500))
);
create index if not exists idx_founder_recurring_costs_owner on public.founder_recurring_costs (owner_id, start_on);

create table if not exists public.founder_expenses (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete restrict,
  recurring_cost_id uuid references public.founder_recurring_costs(id),
  covers_month date check (covers_month is null or extract(day from covers_month) = 1),
  vendor text not null check (char_length(btrim(vendor)) between 1 and 200),
  category text not null check (category in ('software', 'hosting', 'telecom', 'payment_processing', 'contractors', 'payroll', 'marketing', 'professional_services', 'office', 'travel', 'insurance', 'other')),
  description text check (description is null or char_length(description) <= 500),
  amount numeric(15, 3) not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  incurred_on date not null,
  due_on date,
  paid_on date,
  source text not null default 'manual' check (source = 'manual'),
  voided_at timestamp with time zone,
  void_reason text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint founder_expenses_recurring_month check ((recurring_cost_id is null) = (covers_month is null)),
  constraint founder_expenses_decimals check (public.founder_currency_minor_units(currency) is not null and amount = round(amount, public.founder_currency_minor_units(currency))),
  constraint founder_expenses_void check ((voided_at is null) = (void_reason is null) and (void_reason is null or char_length(void_reason) between 1 and 500))
);
create index if not exists idx_founder_expenses_owner_paid on public.founder_expenses (owner_id, paid_on);
create index if not exists idx_founder_expenses_owner_due on public.founder_expenses (owner_id, due_on) where paid_on is null and voided_at is null;
-- One live payment per recurring cost per month: a month can't be paid (counted) twice.
create unique index if not exists founder_expenses_one_per_cost_month on public.founder_expenses (recurring_cost_id, covers_month) where recurring_cost_id is not null and voided_at is null;

create table if not exists public.founder_income_receipts (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete restrict,
  payer text not null check (char_length(btrim(payer)) between 1 and 200),
  kind text not null check (kind in ('recurring_fee', 'setup_fee', 'one_time', 'other')),
  description text check (description is null or char_length(description) <= 500),
  amount numeric(15, 3) not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  received_on date not null,
  -- How it arrived. Stripe payments are already in revenue_events; they are never recorded here.
  received_via text not null check (received_via in ('bank_transfer', 'check', 'cash', 'other_non_stripe')),
  reference text check (reference is null or char_length(reference) <= 200),
  source text not null default 'manual' check (source = 'manual'),
  voided_at timestamp with time zone,
  void_reason text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint founder_income_receipts_decimals check (public.founder_currency_minor_units(currency) is not null and amount = round(amount, public.founder_currency_minor_units(currency))),
  constraint founder_income_receipts_void check ((voided_at is null) = (void_reason is null) and (void_reason is null or char_length(void_reason) between 1 and 500))
);
create index if not exists idx_founder_income_owner_received on public.founder_income_receipts (owner_id, received_on);

create table if not exists public.founder_cash_balances (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete restrict,
  account_label text not null check (char_length(btrim(account_label)) between 1 and 100),
  -- What the account statement said on as_of. May be negative (overdrawn).
  balance numeric(17, 3) not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  as_of date not null,
  note text check (note is null or char_length(note) <= 500),
  source text not null default 'manual' check (source = 'manual'),
  voided_at timestamp with time zone,
  void_reason text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint founder_cash_balances_decimals check (public.founder_currency_minor_units(currency) is not null and balance = round(balance, public.founder_currency_minor_units(currency))),
  constraint founder_cash_balances_void check ((voided_at is null) = (void_reason is null) and (void_reason is null or char_length(void_reason) between 1 and 500))
);
create index if not exists idx_founder_cash_owner_account on public.founder_cash_balances (owner_id, account_label, as_of desc);

create table if not exists public.founder_finance_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  entity text not null check (entity in ('expense', 'recurring_cost', 'income', 'cash_balance')),
  entity_id uuid not null,
  action text not null check (action in ('created', 'corrected', 'paid', 'ended', 'voided')),
  reason text check (reason is null or char_length(reason) <= 500),
  before jsonb check (before is null or jsonb_typeof(before) = 'object'),
  after jsonb check (after is null or jsonb_typeof(after) = 'object'),
  occurred_at timestamp with time zone not null default now()
);
create index if not exists idx_founder_finance_events_entity on public.founder_finance_events (owner_id, entity, entity_id, occurred_at);

comment on table public.founder_expenses is 'Founder operating expenses, entered by hand. Cash basis: counted when paid_on is set. Never deleted; corrected or voided with a reason.';
comment on table public.founder_recurring_costs is 'Founder recurring cost commitments (estimates of what is owed each period), entered by hand. Amount, currency and cadence are fixed once created.';
comment on table public.founder_income_receipts is 'Income the founder received OUTSIDE Stripe, entered by hand. Stripe revenue is only in revenue_events and is never recorded here.';
comment on table public.founder_cash_balances is 'Cash balances as stated on an account on a date, entered by hand. Append-only; never derived from revenue.';
comment on table public.founder_finance_events is 'Append-only audit history of every founder financial record change.';

-- 2. Guards: writes only through the functions; no deletes; voided rows frozen ------------

create or replace function public.founder_finance_rows_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Every DELETE is refused, however it arrives (owner_id is ON DELETE RESTRICT, so an
  -- account with financial records can't be deleted in the first place).
  if tg_op = 'DELETE' then
    raise exception 'financial records are never deleted - void them instead' using errcode = 'FS403';
  end if;
  if coalesce(current_setting('founder.finance_write', true), '') <> 'on' then
    raise exception 'financial records change only through the founder finance functions' using errcode = 'FS403';
  end if;
  if tg_op = 'UPDATE' then
    if old.voided_at is not null then
      raise exception 'a voided record can''t be changed' using errcode = 'FS403';
    end if;
    if new.id is distinct from old.id or new.owner_id is distinct from old.owner_id or new.created_at is distinct from old.created_at or new.source is distinct from old.source then
      raise exception 'id, owner, created time and source are fixed' using errcode = 'FS403';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.founder_finance_events_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and coalesce(current_setting('founder.finance_write', true), '') = 'on' then
    return new;
  end if;
  raise exception 'financial history is append-only' using errcode = 'FS403';
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['founder_recurring_costs', 'founder_expenses', 'founder_income_receipts', 'founder_cash_balances'] loop
    execute format('create or replace trigger %I before insert or update or delete on public.%I for each row execute function public.founder_finance_rows_guard()', t || '_guard', t);
    execute format('create or replace trigger %I before update on public.%I for each row execute function set_updated_at()', t || '_updated_at', t);
  end loop;
end $$;
create or replace trigger founder_finance_events_guard before insert or update or delete on public.founder_finance_events for each row execute function public.founder_finance_events_guard();

-- 3. RLS and grants: founders read their own rows; nobody writes directly -----------------

do $$
declare
  t text;
begin
  foreach t in array array['founder_recurring_costs', 'founder_expenses', 'founder_income_receipts', 'founder_cash_balances', 'founder_finance_events'] loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_founder_select') then
      execute format('create policy %I on public.%I for select to authenticated using (owner_id = auth.uid() and public.is_founder())', t || '_founder_select', t);
    end if;
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;

-- 4. Helpers (not callable by clients) ------------------------------------------------------

-- The caller must be a founder. Returns their local "today" (founder_users.timezone).
create or replace function public.founder_finance_today()
returns date
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text;
begin
  if auth.uid() is null or not public.is_founder() then
    raise exception 'not available' using errcode = 'FS404';
  end if;
  select f.timezone into v_tz from public.founder_users f where f.user_id = auth.uid();
  return (now() at time zone coalesce(v_tz, 'UTC'))::date;
end;
$$;

create or replace function public.founder_finance_audit(p_entity text, p_entity_id uuid, p_action text, p_reason text, p_before jsonb, p_after jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.founder_finance_events (owner_id, entity, entity_id, action, reason, before, after)
  values (auth.uid(), p_entity, p_entity_id, p_action, p_reason, p_before - 'owner_id', p_after - 'owner_id');
$$;

-- Shared input checks. Raise FS422 with a message the founder can act on.
create or replace function public.founder_finance_check(p_amount numeric, p_currency text, p_text text, p_text_label text, p_description text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_currency is null or p_currency !~ '^[A-Z]{3}$' then
    raise exception 'enter a three-letter currency code' using errcode = 'FS422';
  end if;
  if public.founder_currency_minor_units(p_currency) is null then
    raise exception '% isn''t supported', p_currency using errcode = 'FS422';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount >= 1000000000000 or p_amount <> round(p_amount, public.founder_currency_minor_units(p_currency)) then
    raise exception 'enter an amount above 0 with at most % decimal place(s) for %', public.founder_currency_minor_units(p_currency), p_currency using errcode = 'FS422';
  end if;
  if p_text is null or char_length(btrim(p_text)) not between 1 and 200 then
    raise exception 'enter the % (up to 200 characters)', p_text_label using errcode = 'FS422';
  end if;
  if p_description is not null and char_length(p_description) > 500 then
    raise exception 'keep the description under 500 characters' using errcode = 'FS422';
  end if;
end;
$$;

create or replace function public.founder_finance_reason(p_reason text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v is null or char_length(v) > 500 then
    raise exception 'say why (up to 500 characters)' using errcode = 'FS422';
  end if;
  return v;
end;
$$;

-- 5. Expenses -------------------------------------------------------------------------------

create or replace function public.founder_record_expense(
  p_request_id uuid, p_vendor text, p_category text, p_description text, p_amount numeric, p_currency text,
  p_incurred_on date, p_due_on date, p_paid_on date, p_recurring_cost_id uuid, p_covers_month date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := public.founder_finance_today();
  v_existing public.founder_expenses;
  v_cost public.founder_recurring_costs;
  v_row public.founder_expenses;
begin
  if p_request_id is null then
    raise exception 'request id is required' using errcode = 'FS422';
  end if;
  select * into v_existing from public.founder_expenses e where e.id = p_request_id;
  if found then
    if v_existing.owner_id <> auth.uid() then
      raise exception 'request id already used' using errcode = 'FS422';
    end if;
    return jsonb_build_object('status', 'duplicate', 'id', v_existing.id);
  end if;
  perform public.founder_finance_check(p_amount, p_currency, p_vendor, 'vendor', p_description);
  if p_category is null or p_category not in ('software', 'hosting', 'telecom', 'payment_processing', 'contractors', 'payroll', 'marketing', 'professional_services', 'office', 'travel', 'insurance', 'other') then
    raise exception 'choose a valid category' using errcode = 'FS422';
  end if;
  if p_incurred_on is null then
    raise exception 'enter the date of the expense' using errcode = 'FS422';
  end if;
  if p_paid_on is not null and p_paid_on > v_today then
    raise exception 'a payment can''t be dated in the future - record it as due instead' using errcode = 'FS422';
  end if;
  if (p_recurring_cost_id is null) <> (p_covers_month is null) then
    raise exception 'a recurring cost payment needs the month it covers' using errcode = 'FS422';
  end if;
  if p_recurring_cost_id is not null then
    select * into v_cost from public.founder_recurring_costs c where c.id = p_recurring_cost_id and c.owner_id = auth.uid() for update;
    if not found then
      raise exception 'recurring cost not found' using errcode = 'FS404';
    end if;
    if v_cost.voided_at is not null then
      raise exception 'that recurring cost was voided' using errcode = 'FS422';
    end if;
    if extract(day from p_covers_month) <> 1 then
      raise exception 'the covered month must be the first of a month' using errcode = 'FS422';
    end if;
    if p_currency <> v_cost.currency then
      raise exception 'record the payment in the recurring cost''s currency (%)', v_cost.currency using errcode = 'FS422';
    end if;
    if p_covers_month < date_trunc('month', v_cost.start_on)::date or (v_cost.end_on is not null and p_covers_month > date_trunc('month', v_cost.end_on)::date) then
      raise exception 'that month is outside the recurring cost''s active period' using errcode = 'FS422';
    end if;
    if exists (select 1 from public.founder_expenses e where e.recurring_cost_id = p_recurring_cost_id and e.covers_month = p_covers_month and e.voided_at is null) then
      raise exception 'that month is already recorded for this recurring cost' using errcode = 'FS422';
    end if;
  end if;

  perform set_config('founder.finance_write', 'on', true);
  insert into public.founder_expenses (id, owner_id, recurring_cost_id, covers_month, vendor, category, description, amount, currency, incurred_on, due_on, paid_on)
  values (p_request_id, auth.uid(), p_recurring_cost_id, p_covers_month, btrim(p_vendor), p_category, nullif(btrim(coalesce(p_description, '')), ''), p_amount, p_currency, p_incurred_on, p_due_on, p_paid_on)
  returning * into v_row;
  perform public.founder_finance_audit('expense', v_row.id, 'created', null, null, to_jsonb(v_row));
  perform set_config('founder.finance_write', '', true);
  return jsonb_build_object('status', 'recorded', 'id', v_row.id, 'updated_at', v_row.updated_at);
end;
$$;

-- Locks one of the caller's own live rows and checks its version. Missing, someone else's: FS404.
create or replace function public.founder_finance_lock_expense(p_id uuid, p_expected_updated_at timestamp with time zone)
returns public.founder_expenses
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.founder_expenses;
begin
  perform public.founder_finance_today();
  select * into v_row from public.founder_expenses e where e.id = p_id and e.owner_id = auth.uid() for update;
  if not found then
    raise exception 'expense not found' using errcode = 'FS404';
  end if;
  if v_row.voided_at is not null then
    raise exception 'that expense was voided' using errcode = 'FS422';
  end if;
  if p_expected_updated_at is null or v_row.updated_at <> p_expected_updated_at then
    raise exception 'this expense changed since it was loaded' using errcode = 'FS409';
  end if;
  return v_row;
end;
$$;

create or replace function public.founder_mark_expense_paid(p_expense_id uuid, p_expected_updated_at timestamp with time zone, p_paid_on date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := public.founder_finance_today();
  v_before public.founder_expenses;
  v_row public.founder_expenses;
begin
  select * into v_before from public.founder_expenses e where e.id = p_expense_id and e.owner_id = auth.uid();
  if found and v_before.paid_on is not null and v_before.voided_at is null and v_before.paid_on = p_paid_on then
    return jsonb_build_object('status', 'duplicate', 'updated_at', v_before.updated_at);
  end if;
  v_before := public.founder_finance_lock_expense(p_expense_id, p_expected_updated_at);
  if v_before.paid_on is not null then
    raise exception 'this expense is already paid - correct it to change the date' using errcode = 'FS422';
  end if;
  if p_paid_on is null or p_paid_on > v_today then
    raise exception 'enter the date it was paid (not in the future)' using errcode = 'FS422';
  end if;
  perform set_config('founder.finance_write', 'on', true);
  update public.founder_expenses set paid_on = p_paid_on where id = p_expense_id returning * into v_row;
  perform public.founder_finance_audit('expense', v_row.id, 'paid', null, to_jsonb(v_before), to_jsonb(v_row));
  perform set_config('founder.finance_write', '', true);
  return jsonb_build_object('status', 'recorded', 'updated_at', v_row.updated_at);
end;
$$;

-- Corrects what was entered. The recurring-cost link is fixed (void and re-record to move a payment).
create or replace function public.founder_correct_expense(
  p_expense_id uuid, p_expected_updated_at timestamp with time zone, p_vendor text, p_category text, p_description text,
  p_amount numeric, p_currency text, p_incurred_on date, p_due_on date, p_paid_on date, p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := public.founder_finance_today();
  v_before public.founder_expenses := public.founder_finance_lock_expense(p_expense_id, p_expected_updated_at);
  v_reason text := public.founder_finance_reason(p_reason);
  v_cost_currency text;
  v_row public.founder_expenses;
begin
  perform public.founder_finance_check(p_amount, p_currency, p_vendor, 'vendor', p_description);
  if p_category is null or p_category not in ('software', 'hosting', 'telecom', 'payment_processing', 'contractors', 'payroll', 'marketing', 'professional_services', 'office', 'travel', 'insurance', 'other') then
    raise exception 'choose a valid category' using errcode = 'FS422';
  end if;
  if p_incurred_on is null then
    raise exception 'enter the date of the expense' using errcode = 'FS422';
  end if;
  if p_paid_on is not null and p_paid_on > v_today then
    raise exception 'a payment can''t be dated in the future' using errcode = 'FS422';
  end if;
  if v_before.recurring_cost_id is not null then
    select c.currency into v_cost_currency from public.founder_recurring_costs c where c.id = v_before.recurring_cost_id;
    if p_currency <> v_cost_currency then
      raise exception 'a recurring cost payment stays in the recurring cost''s currency (%)', v_cost_currency using errcode = 'FS422';
    end if;
  end if;
  if btrim(p_vendor) = v_before.vendor and p_category = v_before.category and nullif(btrim(coalesce(p_description, '')), '') is not distinct from v_before.description
     and p_amount = v_before.amount and p_currency = v_before.currency and p_incurred_on = v_before.incurred_on
     and p_due_on is not distinct from v_before.due_on and p_paid_on is not distinct from v_before.paid_on then
    raise exception 'nothing to correct' using errcode = 'FS422';
  end if;
  perform set_config('founder.finance_write', 'on', true);
  update public.founder_expenses set vendor = btrim(p_vendor), category = p_category, description = nullif(btrim(coalesce(p_description, '')), ''),
    amount = p_amount, currency = p_currency, incurred_on = p_incurred_on, due_on = p_due_on, paid_on = p_paid_on
    where id = p_expense_id returning * into v_row;
  perform public.founder_finance_audit('expense', v_row.id, 'corrected', v_reason, to_jsonb(v_before), to_jsonb(v_row));
  perform set_config('founder.finance_write', '', true);
  return jsonb_build_object('status', 'recorded', 'updated_at', v_row.updated_at);
end;
$$;

create or replace function public.founder_void_expense(p_expense_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.founder_expenses;
  v_row public.founder_expenses;
  v_reason text;
begin
  perform public.founder_finance_today();
  select * into v_before from public.founder_expenses e where e.id = p_expense_id and e.owner_id = auth.uid() for update;
  if not found then
    raise exception 'expense not found' using errcode = 'FS404';
  end if;
  if v_before.voided_at is not null then
    return jsonb_build_object('status', 'duplicate');
  end if;
  v_reason := public.founder_finance_reason(p_reason);
  perform set_config('founder.finance_write', 'on', true);
  update public.founder_expenses set voided_at = now(), void_reason = v_reason where id = p_expense_id returning * into v_row;
  perform public.founder_finance_audit('expense', v_row.id, 'voided', v_reason, to_jsonb(v_before), to_jsonb(v_row));
  perform set_config('founder.finance_write', '', true);
  return jsonb_build_object('status', 'recorded');
end;
$$;

-- 6. Recurring costs --------------------------------------------------------------------------

create or replace function public.founder_create_recurring_cost(
  p_request_id uuid, p_vendor text, p_category text, p_description text, p_amount numeric, p_currency text, p_cadence text, p_start_on date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.founder_recurring_costs;
  v_row public.founder_recurring_costs;
begin
  perform public.founder_finance_today();
  if p_request_id is null then
    raise exception 'request id is required' using errcode = 'FS422';
  end if;
  select * into v_existing from public.founder_recurring_costs c where c.id = p_request_id;
  if found then
    if v_existing.owner_id <> auth.uid() then
      raise exception 'request id already used' using errcode = 'FS422';
    end if;
    return jsonb_build_object('status', 'duplicate', 'id', v_existing.id);
  end if;
  perform public.founder_finance_check(p_amount, p_currency, p_vendor, 'vendor', p_description);
  if p_category is null or p_category not in ('software', 'hosting', 'telecom', 'payment_processing', 'contractors', 'payroll', 'marketing', 'professional_services', 'office', 'travel', 'insurance', 'other') then
    raise exception 'choose a valid category' using errcode = 'FS422';
  end if;
  if p_cadence is null or p_cadence not in ('monthly', 'annual') then
    raise exception 'choose monthly or annual' using errcode = 'FS422';
  end if;
  if p_start_on is null then
    raise exception 'enter when the cost starts' using errcode = 'FS422';
  end if;
  perform set_config('founder.finance_write', 'on', true);
  insert into public.founder_recurring_costs (id, owner_id, vendor, category, description, amount, currency, cadence, start_on)
  values (p_request_id, auth.uid(), btrim(p_vendor), p_category, nullif(btrim(coalesce(p_description, '')), ''), p_amount, p_currency, p_cadence, p_start_on)
  returning * into v_row;
  perform public.founder_finance_audit('recurring_cost', v_row.id, 'created', null, null, to_jsonb(v_row));
  perform set_config('founder.finance_write', '', true);
  return jsonb_build_object('status', 'recorded', 'id', v_row.id, 'updated_at', v_row.updated_at);
end;
$$;

-- Corrects the descriptive fields only. Amount, currency, cadence and start are fixed:
-- a price change ends this cost and starts a new one, so past commitments stay as they were.
create or replace function public.founder_correct_recurring_cost(
  p_cost_id uuid, p_expected_updated_at timestamp with time zone, p_vendor text, p_category text, p_description text, p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.founder_recurring_costs;
  v_row public.founder_recurring_costs;
  v_reason text;
begin
  perform public.founder_finance_today();
  select * into v_before from public.founder_recurring_costs c where c.id = p_cost_id and c.owner_id = auth.uid() for update;
  if not found then
    raise exception 'recurring cost not found' using errcode = 'FS404';
  end if;
  if v_before.voided_at is not null then
    raise exception 'that recurring cost was voided' using errcode = 'FS422';
  end if;
  if p_expected_updated_at is null or v_before.updated_at <> p_expected_updated_at then
    raise exception 'this recurring cost changed since it was loaded' using errcode = 'FS409';
  end if;
  v_reason := public.founder_finance_reason(p_reason);
  perform public.founder_finance_check(v_before.amount, v_before.currency, p_vendor, 'vendor', p_description);
  if p_category is null or p_category not in ('software', 'hosting', 'telecom', 'payment_processing', 'contractors', 'payroll', 'marketing', 'professional_services', 'office', 'travel', 'insurance', 'other') then
    raise exception 'choose a valid category' using errcode = 'FS422';
  end if;
  perform set_config('founder.finance_write', 'on', true);
  update public.founder_recurring_costs set vendor = btrim(p_vendor), category = p_category, description = nullif(btrim(coalesce(p_description, '')), '')
    where id = p_cost_id returning * into v_row;
  perform public.founder_finance_audit('recurring_cost', v_row.id, 'corrected', v_reason, to_jsonb(v_before), to_jsonb(v_row));
  perform set_config('founder.finance_write', '', true);
  return jsonb_build_object('status', 'recorded', 'updated_at', v_row.updated_at);
end;
$$;

create or replace function public.founder_end_recurring_cost(p_cost_id uuid, p_expected_updated_at timestamp with time zone, p_end_on date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.founder_recurring_costs;
  v_row public.founder_recurring_costs;
begin
  perform public.founder_finance_today();
  select * into v_before from public.founder_recurring_costs c where c.id = p_cost_id and c.owner_id = auth.uid() for update;
  if not found then
    raise exception 'recurring cost not found' using errcode = 'FS404';
  end if;
  if v_before.voided_at is not null then
    raise exception 'that recurring cost was voided' using errcode = 'FS422';
  end if;
  if v_before.end_on is not null then
    if v_before.end_on = p_end_on then
      return jsonb_build_object('status', 'duplicate', 'updated_at', v_before.updated_at);
    end if;
    raise exception 'this recurring cost already ended' using errcode = 'FS422';
  end if;
  if p_expected_updated_at is null or v_before.updated_at <> p_expected_updated_at then
    raise exception 'this recurring cost changed since it was loaded' using errcode = 'FS409';
  end if;
  if p_end_on is null or p_end_on < v_before.start_on then
    raise exception 'enter an end date on or after the start date' using errcode = 'FS422';
  end if;
  if exists (select 1 from public.founder_expenses e where e.recurring_cost_id = p_cost_id and e.voided_at is null and e.covers_month > date_trunc('month', p_end_on)::date) then
    raise exception 'payments are recorded for months after that date - void them first' using errcode = 'FS422';
  end if;
  perform set_config('founder.finance_write', 'on', true);
  update public.founder_recurring_costs set end_on = p_end_on where id = p_cost_id returning * into v_row;
  perform public.founder_finance_audit('recurring_cost', v_row.id, 'ended', null, to_jsonb(v_before), to_jsonb(v_row));
  perform set_config('founder.finance_write', '', true);
  return jsonb_build_object('status', 'recorded', 'updated_at', v_row.updated_at);
end;
$$;

-- Voiding means it was entered in error; refused while live payments are linked to it.
create or replace function public.founder_void_recurring_cost(p_cost_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.founder_recurring_costs;
  v_row public.founder_recurring_costs;
  v_reason text;
begin
  perform public.founder_finance_today();
  select * into v_before from public.founder_recurring_costs c where c.id = p_cost_id and c.owner_id = auth.uid() for update;
  if not found then
    raise exception 'recurring cost not found' using errcode = 'FS404';
  end if;
  if v_before.voided_at is not null then
    return jsonb_build_object('status', 'duplicate');
  end if;
  v_reason := public.founder_finance_reason(p_reason);
  if exists (select 1 from public.founder_expenses e where e.recurring_cost_id = p_cost_id and e.voided_at is null) then
    raise exception 'payments are recorded against this cost - void them first, or end the cost instead' using errcode = 'FS422';
  end if;
  perform set_config('founder.finance_write', 'on', true);
  update public.founder_recurring_costs set voided_at = now(), void_reason = v_reason where id = p_cost_id returning * into v_row;
  perform public.founder_finance_audit('recurring_cost', v_row.id, 'voided', v_reason, to_jsonb(v_before), to_jsonb(v_row));
  perform set_config('founder.finance_write', '', true);
  return jsonb_build_object('status', 'recorded');
end;
$$;

-- 7. Income received outside Stripe -----------------------------------------------------------

create or replace function public.founder_record_income(
  p_request_id uuid, p_payer text, p_kind text, p_description text, p_amount numeric, p_currency text,
  p_received_on date, p_received_via text, p_reference text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := public.founder_finance_today();
  v_existing public.founder_income_receipts;
  v_row public.founder_income_receipts;
begin
  if p_request_id is null then
    raise exception 'request id is required' using errcode = 'FS422';
  end if;
  select * into v_existing from public.founder_income_receipts r where r.id = p_request_id;
  if found then
    if v_existing.owner_id <> auth.uid() then
      raise exception 'request id already used' using errcode = 'FS422';
    end if;
    return jsonb_build_object('status', 'duplicate', 'id', v_existing.id);
  end if;
  perform public.founder_finance_check(p_amount, p_currency, p_payer, 'payer', p_description);
  if p_kind is null or p_kind not in ('recurring_fee', 'setup_fee', 'one_time', 'other') then
    raise exception 'choose what the payment was for' using errcode = 'FS422';
  end if;
  if p_received_via is null or p_received_via not in ('bank_transfer', 'check', 'cash', 'other_non_stripe') then
    raise exception 'choose how it was received - Stripe payments are already recorded automatically and aren''t entered here' using errcode = 'FS422';
  end if;
  if p_received_on is null or p_received_on > v_today then
    raise exception 'enter the date it was received (not in the future)' using errcode = 'FS422';
  end if;
  if p_reference is not null and char_length(p_reference) > 200 then
    raise exception 'keep the reference under 200 characters' using errcode = 'FS422';
  end if;
  perform set_config('founder.finance_write', 'on', true);
  insert into public.founder_income_receipts (id, owner_id, payer, kind, description, amount, currency, received_on, received_via, reference)
  values (p_request_id, auth.uid(), btrim(p_payer), p_kind, nullif(btrim(coalesce(p_description, '')), ''), p_amount, p_currency, p_received_on, p_received_via, nullif(btrim(coalesce(p_reference, '')), ''))
  returning * into v_row;
  perform public.founder_finance_audit('income', v_row.id, 'created', null, null, to_jsonb(v_row));
  perform set_config('founder.finance_write', '', true);
  return jsonb_build_object('status', 'recorded', 'id', v_row.id, 'updated_at', v_row.updated_at);
end;
$$;

create or replace function public.founder_correct_income(
  p_income_id uuid, p_expected_updated_at timestamp with time zone, p_payer text, p_kind text, p_description text, p_amount numeric,
  p_currency text, p_received_on date, p_received_via text, p_reference text, p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := public.founder_finance_today();
  v_before public.founder_income_receipts;
  v_row public.founder_income_receipts;
  v_reason text;
begin
  select * into v_before from public.founder_income_receipts r where r.id = p_income_id and r.owner_id = auth.uid() for update;
  if not found then
    raise exception 'income record not found' using errcode = 'FS404';
  end if;
  if v_before.voided_at is not null then
    raise exception 'that income record was voided' using errcode = 'FS422';
  end if;
  if p_expected_updated_at is null or v_before.updated_at <> p_expected_updated_at then
    raise exception 'this income record changed since it was loaded' using errcode = 'FS409';
  end if;
  v_reason := public.founder_finance_reason(p_reason);
  perform public.founder_finance_check(p_amount, p_currency, p_payer, 'payer', p_description);
  if p_kind is null or p_kind not in ('recurring_fee', 'setup_fee', 'one_time', 'other') then
    raise exception 'choose what the payment was for' using errcode = 'FS422';
  end if;
  if p_received_via is null or p_received_via not in ('bank_transfer', 'check', 'cash', 'other_non_stripe') then
    raise exception 'choose how it was received - Stripe payments aren''t entered here' using errcode = 'FS422';
  end if;
  if p_received_on is null or p_received_on > v_today then
    raise exception 'enter the date it was received (not in the future)' using errcode = 'FS422';
  end if;
  if p_reference is not null and char_length(p_reference) > 200 then
    raise exception 'keep the reference under 200 characters' using errcode = 'FS422';
  end if;
  if btrim(p_payer) = v_before.payer and p_kind = v_before.kind and nullif(btrim(coalesce(p_description, '')), '') is not distinct from v_before.description
     and p_amount = v_before.amount and p_currency = v_before.currency and p_received_on = v_before.received_on and p_received_via = v_before.received_via
     and nullif(btrim(coalesce(p_reference, '')), '') is not distinct from v_before.reference then
    raise exception 'nothing to correct' using errcode = 'FS422';
  end if;
  perform set_config('founder.finance_write', 'on', true);
  update public.founder_income_receipts set payer = btrim(p_payer), kind = p_kind, description = nullif(btrim(coalesce(p_description, '')), ''), amount = p_amount,
    currency = p_currency, received_on = p_received_on, received_via = p_received_via, reference = nullif(btrim(coalesce(p_reference, '')), '')
    where id = p_income_id returning * into v_row;
  perform public.founder_finance_audit('income', v_row.id, 'corrected', v_reason, to_jsonb(v_before), to_jsonb(v_row));
  perform set_config('founder.finance_write', '', true);
  return jsonb_build_object('status', 'recorded', 'updated_at', v_row.updated_at);
end;
$$;

create or replace function public.founder_void_income(p_income_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.founder_income_receipts;
  v_row public.founder_income_receipts;
  v_reason text;
begin
  perform public.founder_finance_today();
  select * into v_before from public.founder_income_receipts r where r.id = p_income_id and r.owner_id = auth.uid() for update;
  if not found then
    raise exception 'income record not found' using errcode = 'FS404';
  end if;
  if v_before.voided_at is not null then
    return jsonb_build_object('status', 'duplicate');
  end if;
  v_reason := public.founder_finance_reason(p_reason);
  perform set_config('founder.finance_write', 'on', true);
  update public.founder_income_receipts set voided_at = now(), void_reason = v_reason where id = p_income_id returning * into v_row;
  perform public.founder_finance_audit('income', v_row.id, 'voided', v_reason, to_jsonb(v_before), to_jsonb(v_row));
  perform set_config('founder.finance_write', '', true);
  return jsonb_build_object('status', 'recorded');
end;
$$;

-- 8. Cash balances (append-only: a correction is a new balance; a mistake is voided) -------------

create or replace function public.founder_record_cash_balance(p_request_id uuid, p_account_label text, p_balance numeric, p_currency text, p_as_of date, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := public.founder_finance_today();
  v_existing public.founder_cash_balances;
  v_row public.founder_cash_balances;
begin
  if p_request_id is null then
    raise exception 'request id is required' using errcode = 'FS422';
  end if;
  select * into v_existing from public.founder_cash_balances b where b.id = p_request_id;
  if found then
    if v_existing.owner_id <> auth.uid() then
      raise exception 'request id already used' using errcode = 'FS422';
    end if;
    return jsonb_build_object('status', 'duplicate', 'id', v_existing.id);
  end if;
  if p_account_label is null or char_length(btrim(p_account_label)) not between 1 and 100 then
    raise exception 'name the account (up to 100 characters)' using errcode = 'FS422';
  end if;
  if p_currency is null or p_currency !~ '^[A-Z]{3}$' then
    raise exception 'enter a three-letter currency code' using errcode = 'FS422';
  end if;
  if public.founder_currency_minor_units(p_currency) is null then
    raise exception '% isn''t supported', p_currency using errcode = 'FS422';
  end if;
  if p_balance is null or abs(p_balance) >= 100000000000000 or p_balance <> round(p_balance, public.founder_currency_minor_units(p_currency)) then
    raise exception 'enter the balance with at most % decimal place(s) for %', public.founder_currency_minor_units(p_currency), p_currency using errcode = 'FS422';
  end if;
  if p_as_of is null or p_as_of > v_today then
    raise exception 'enter the date of the balance (not in the future)' using errcode = 'FS422';
  end if;
  if p_note is not null and char_length(p_note) > 500 then
    raise exception 'keep the note under 500 characters' using errcode = 'FS422';
  end if;
  perform set_config('founder.finance_write', 'on', true);
  insert into public.founder_cash_balances (id, owner_id, account_label, balance, currency, as_of, note)
  values (p_request_id, auth.uid(), btrim(p_account_label), p_balance, p_currency, p_as_of, nullif(btrim(coalesce(p_note, '')), ''))
  returning * into v_row;
  perform public.founder_finance_audit('cash_balance', v_row.id, 'created', null, null, to_jsonb(v_row));
  perform set_config('founder.finance_write', '', true);
  return jsonb_build_object('status', 'recorded', 'id', v_row.id);
end;
$$;

create or replace function public.founder_void_cash_balance(p_balance_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.founder_cash_balances;
  v_row public.founder_cash_balances;
  v_reason text;
begin
  perform public.founder_finance_today();
  select * into v_before from public.founder_cash_balances b where b.id = p_balance_id and b.owner_id = auth.uid() for update;
  if not found then
    raise exception 'cash balance not found' using errcode = 'FS404';
  end if;
  if v_before.voided_at is not null then
    return jsonb_build_object('status', 'duplicate');
  end if;
  v_reason := public.founder_finance_reason(p_reason);
  perform set_config('founder.finance_write', 'on', true);
  update public.founder_cash_balances set voided_at = now(), void_reason = v_reason where id = p_balance_id returning * into v_row;
  perform public.founder_finance_audit('cash_balance', v_row.id, 'voided', v_reason, to_jsonb(v_before), to_jsonb(v_row));
  perform set_config('founder.finance_write', '', true);
  return jsonb_build_object('status', 'recorded');
end;
$$;

-- 9. Founder-only, aggregate-only reads ---------------------------------------------------------

-- Stripe minor-unit exponents that may be used to convert Stripe amounts to
-- major units. Only an entry here is treated as verified; every other
-- currency returns NULL (unverified) - there is deliberately no default.
-- USD: 2 (cents), the currency this business bills in, and the convention the
-- existing Stripe code here already relies on (lib/format/money.ts). Nothing
-- else has been independently verified against Stripe's currency rules, so
-- JPY, KWD, EUR and every other currency stay unverified until a reviewed
-- migration adds them here.
create or replace function public.founder_stripe_verified_exponent(p_currency text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case upper(coalesce(p_currency, ''))
    when 'USD' then 2
    else null
  end;
$$;

-- STAGE 2 DISPLAY CONTRACT (fail-safe) for both Stripe reads below:
--  * Amounts are Stripe minor units, exactly as Stripe sent them.
--  * Convert to a major-unit value ONLY when exponent_status = 'verified'
--    (minor_unit_exponent is then non-null): major = minor / 10 ^ exponent.
--  * When exponent_status = 'unverified' (minor_unit_exponent is NULL), do not
--    display a converted amount, do not guess an exponent (never default to
--    2), and do not include the amount in any converted total. Show the
--    currency as "amount format not verified" instead.

-- Stripe revenue as recorded by the webhook (revenue_events), for the selected
-- period [p_from, p_to), per month (founder's time zone) and currency. Every
-- figure counts only events that OCCURRED in the period (occurred_at):
--  * collected / recurring_collected / uncategorized_collected: successful
--    payments, gross (as paid, including any tax, before Stripe fees) - cash
--    basis, unchanged.
--  * refunded: refunds, a separate total, never attributed to recurring or
--    setup revenue.
--  * failed_attempts: failed payment attempts in the period.
--  * invoices_with_failed_attempts: distinct invoices (provider_object_id =
--    the Stripe invoice id, stable across retries) with at least one failed
--    attempt in that month - whether or not they were paid afterwards.
--  * failed_attempted_amount: per such invoice, its latest failed attempt in
--    that month, summed - money that was attempted, NOT money lost.
-- Failures are never collected revenue. This function says nothing about
-- whether an invoice is still unpaid today - that is
-- founder_stripe_unrecovered_invoices(). Only revenue_events is read: manual
-- income can never appear here. No organization ids or event rows are
-- returned. Reads only.
create or replace function public.founder_stripe_revenue_summary(p_from timestamp with time zone, p_to timestamp with time zone)
returns table (
  month date, currency text, collected bigint, recurring_collected bigint, uncategorized_collected bigint, refunded bigint,
  succeeded_payments integer, failed_attempts integer, invoices_with_failed_attempts integer, failed_attempted_amount bigint,
  last_recorded_at timestamp with time zone, minor_unit_exponent integer, exponent_status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text;
begin
  perform public.founder_finance_today();
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '3 years' then
    raise exception 'choose a period of up to 3 years' using errcode = 'FS422';
  end if;
  select coalesce(f.timezone, 'UTC') into v_tz from public.founder_users f where f.user_id = auth.uid();
  return query
  with base as (
    select r.event_type, r.revenue_category, r.provider_object_id, r.amount, lower(r.currency) as cur,
      date_trunc('month', r.occurred_at at time zone v_tz)::date as m, r.occurred_at, r.recorded_at
    from public.revenue_events r
    where r.occurred_at >= p_from and r.occurred_at < p_to
  ),
  failed_per_invoice as (
    select distinct on (b.m, b.provider_object_id) b.m, b.cur, b.amount
    from base b
    where b.event_type = 'payment_failed'
    order by b.m, b.provider_object_id, b.occurred_at desc
  ),
  lines as (
    select b.m, b.cur,
      case when b.event_type = 'payment_succeeded' then b.amount else 0 end as collected,
      case when b.event_type = 'payment_succeeded' and b.revenue_category = 'recurring' then b.amount else 0 end as recurring,
      case when b.event_type = 'payment_succeeded' and b.revenue_category is null then b.amount else 0 end as uncategorized,
      case when b.event_type = 'refund' then b.amount else 0 end as refunded,
      case when b.event_type = 'payment_succeeded' then 1 else 0 end as ok_n,
      case when b.event_type = 'payment_failed' then 1 else 0 end as fail_n,
      0 as fail_inv, 0::bigint as fail_amount,
      b.recorded_at
    from base b
    union all
    select f.m, f.cur, 0, 0, 0, 0, 0, 0, 1, f.amount, null
    from failed_per_invoice f
  )
  select x.m, upper(x.cur), sum(x.collected)::bigint, sum(x.recurring)::bigint, sum(x.uncategorized)::bigint, sum(x.refunded)::bigint,
    sum(x.ok_n)::integer, sum(x.fail_n)::integer, sum(x.fail_inv)::integer, sum(x.fail_amount)::bigint,
    max(x.recorded_at),
    public.founder_stripe_verified_exponent(x.cur),
    case when public.founder_stripe_verified_exponent(x.cur) is null then 'unverified' else 'verified' end
  from lines x
  group by x.m, x.cur
  order by x.m, x.cur;
end;
$$;

-- Recovery status AS OF THE MOMENT OF THE READ (measured_at = now()), not a
-- period figure: invoices (provider_object_id = the Stripe invoice id) that
-- have at least one failed attempt ever recorded and no successful payment
-- ever recorded, per currency. amount_due_latest_attempt sums each invoice's
-- most recent failed attempt. An invoice paid at any time - before or after
-- any reporting period - is not unrecovered. Minor units; same display
-- contract as above. Only revenue_events is read. Reads only.
create or replace function public.founder_stripe_unrecovered_invoices()
returns table (
  currency text, unrecovered_invoices integer, amount_due_latest_attempt bigint, earliest_failure_at timestamp with time zone,
  latest_failure_at timestamp with time zone, measured_at timestamp with time zone, minor_unit_exponent integer, exponent_status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.founder_finance_today();
  return query
  with failed as (
    select r.provider_object_id, lower(r.currency) as cur, r.amount, r.occurred_at
    from public.revenue_events r
    where r.event_type = 'payment_failed'
      and not exists (select 1 from public.revenue_events s where s.event_type = 'payment_succeeded' and s.provider_object_id = r.provider_object_id)
  ),
  per_invoice as (
    select distinct on (f.provider_object_id) f.provider_object_id, f.cur, f.amount,
      min(f.occurred_at) over (partition by f.provider_object_id) as first_at, f.occurred_at as last_at
    from failed f
    order by f.provider_object_id, f.occurred_at desc
  )
  select upper(i.cur), count(*)::integer, sum(i.amount)::bigint, min(i.first_at), max(i.last_at), now(),
    public.founder_stripe_verified_exponent(i.cur),
    case when public.founder_stripe_verified_exponent(i.cur) is null then 'unverified' else 'verified' end
  from per_invoice i
  group by i.cur
  order by upper(i.cur);
end;
$$;

-- The Agency's contracted fees (agency_clients terms confirmed at handoff) for
-- clients that are live or under ongoing management, per currency. Contracted,
-- not collected. No client names or ids are returned. Reads only.
create or replace function public.founder_contracted_mrr()
returns table (currency text, monthly_total numeric, setup_total numeric, client_count integer, latest_change_at timestamp with time zone)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.founder_finance_today();
  return query
  select upper(c.currency), sum(c.monthly_fee), sum(c.setup_fee), count(*)::integer, max(c.status_changed_at)
  from public.agency_clients c
  where c.status in ('live', 'ongoing_management')
  group by upper(c.currency)
  order by upper(c.currency);
end;
$$;

-- 10. Grants -----------------------------------------------------------------------------------

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.founder_finance_rows_guard()',
    'public.founder_finance_events_guard()',
    'public.founder_finance_today()',
    'public.founder_finance_audit(text, uuid, text, text, jsonb, jsonb)',
    'public.founder_finance_check(numeric, text, text, text, text)',
    'public.founder_finance_reason(text)',
    'public.founder_finance_lock_expense(uuid, timestamp with time zone)',
    'public.founder_stripe_verified_exponent(text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'public.founder_record_expense(uuid, text, text, text, numeric, text, date, date, date, uuid, date)',
    'public.founder_mark_expense_paid(uuid, timestamp with time zone, date)',
    'public.founder_correct_expense(uuid, timestamp with time zone, text, text, text, numeric, text, date, date, date, text)',
    'public.founder_void_expense(uuid, text)',
    'public.founder_create_recurring_cost(uuid, text, text, text, numeric, text, text, date)',
    'public.founder_correct_recurring_cost(uuid, timestamp with time zone, text, text, text, text)',
    'public.founder_end_recurring_cost(uuid, timestamp with time zone, date)',
    'public.founder_void_recurring_cost(uuid, text)',
    'public.founder_record_income(uuid, text, text, text, numeric, text, date, text, text)',
    'public.founder_correct_income(uuid, timestamp with time zone, text, text, text, numeric, text, date, text, text, text)',
    'public.founder_void_income(uuid, text)',
    'public.founder_record_cash_balance(uuid, text, numeric, text, date, text)',
    'public.founder_void_cash_balance(uuid, text)',
    'public.founder_stripe_revenue_summary(timestamp with time zone, timestamp with time zone)',
    'public.founder_stripe_unrecovered_invoices()',
    'public.founder_contracted_mrr()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

commit;

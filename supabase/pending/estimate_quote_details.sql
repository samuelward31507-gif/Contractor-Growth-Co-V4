-- Customer-facing quote details: quote numbers, an itemized breakdown, and
-- the scope of work and terms the customer reads before approving.
--
-- STATUS: PENDING - not applied anywhere. Apply with the procedure in
-- supabase/pending/README.md; validate first with
-- supabase/pending/scratch/validate-estimate-quote-details.mjs.
-- The application tolerates a database without it: every read of these
-- columns/table is separate and falls back to the pre-existing quote (title,
-- total, dates) when they are missing, so this can be applied before or
-- after the code that uses it is deployed.
--
-- 1. estimates.scope_of_work / estimates.terms - customer-visible text.
--    estimates.notes stays internal and is never shown to the customer.
-- 2. estimates.number - a per-organization quote number assigned by the
--    database on insert (the invoices_guard_insert pattern: the organization
--    row is locked so concurrent inserts queue; the unique constraint is the
--    backstop) and immutable afterwards. Existing estimates are backfilled in
--    creation order.
-- 3. public.estimate_line_items - description, quantity, optional unit, unit
--    price. RLS: organization members (is_org_member) plus the payment-active
--    RESTRICTIVE policy every revenue table has. Triggers keep a line item in
--    its estimate's organization and allow changes only while the estimate is
--    a draft, so a sent quote can never change under the customer. The
--    application keeps estimates.amount equal to the line-item sum.
--
-- Idempotent. Rollback: estimate_quote_details_rollback.sql.

begin;

-- 1. Scope and terms --------------------------------------------------------

alter table public.estimates
  add column if not exists scope_of_work text,
  add column if not exists terms text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'estimates_scope_of_work_length') then
    alter table public.estimates add constraint estimates_scope_of_work_length check (scope_of_work is null or char_length(scope_of_work) <= 5000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'estimates_terms_length') then
    alter table public.estimates add constraint estimates_terms_length check (terms is null or char_length(terms) <= 5000);
  end if;
end $$;

comment on column public.estimates.scope_of_work is 'Customer-visible: the work this quote covers. Shown on the public quote page. (estimates.notes is internal.)';
comment on column public.estimates.terms is 'Customer-visible: deposit, payment schedule, warranty and other terms, exactly as the contractor wrote them.';

-- 2. Quote number -----------------------------------------------------------

alter table public.estimates add column if not exists number integer;

with numbered as (
  select e.id,
         coalesce((select max(x.number) from public.estimates x where x.organization_id = e.organization_id), 0)
           + row_number() over (partition by e.organization_id order by e.created_at, e.id) as n
  from public.estimates e
  where e.number is null
)
update public.estimates e set number = numbered.n from numbered where numbered.id = e.id;

alter table public.estimates alter column number set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'estimates_number_positive') then
    alter table public.estimates add constraint estimates_number_positive check (number > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'estimates_org_number_unique') then
    alter table public.estimates add constraint estimates_org_number_unique unique (organization_id, number);
  end if;
end $$;

create or replace function public.estimates_assign_number()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  perform 1 from public.organizations where id = new.organization_id for update;
  select coalesce(max(number), 0) + 1 into new.number
    from public.estimates where organization_id = new.organization_id;
  return new;
end;
$$;

create or replace trigger estimates_assign_number
  before insert on public.estimates
  for each row execute function public.estimates_assign_number();

create or replace function public.estimates_number_immutable()
returns trigger
language plpgsql
set search_path = 'public'
as $$
begin
  if new.number is distinct from old.number then
    raise exception 'estimate number is immutable';
  end if;
  return new;
end;
$$;

create or replace trigger estimates_number_immutable
  before update of number on public.estimates
  for each row execute function public.estimates_number_immutable();

-- 3. Line items -------------------------------------------------------------

create table if not exists public.estimate_line_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  estimate_id uuid not null references public.estimates(id) on delete cascade,
  position integer not null default 0,
  description text not null check (char_length(btrim(description)) between 1 and 500),
  quantity numeric(12, 3) not null default 1 check (quantity > 0),
  unit text check (unit is null or char_length(unit) <= 20),
  unit_price numeric(12, 2) not null check (unit_price >= 0),
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create index if not exists idx_estimate_line_items_estimate on public.estimate_line_items (estimate_id, position, created_at);
create index if not exists idx_estimate_line_items_org on public.estimate_line_items (organization_id);

create or replace trigger estimate_line_items_updated_at
  before update on public.estimate_line_items
  for each row execute function set_updated_at();

-- A line item belongs to its estimate's organization, and changes only while
-- that estimate is a draft. During a cascade delete of the estimate itself the
-- parent row is already gone, so the cascade is allowed.
create or replace function public.estimate_line_items_guard()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_row public.estimate_line_items%rowtype;
  v_status text;
  v_org uuid;
begin
  v_row := case when tg_op = 'DELETE' then old else new end;
  select status, organization_id into v_status, v_org from public.estimates where id = v_row.estimate_id;
  if not found then
    if tg_op = 'DELETE' then return old; end if;
    raise exception 'estimate not found';
  end if;
  if v_org <> v_row.organization_id then
    raise exception 'line item organization_id must match its estimate';
  end if;
  if tg_op = 'UPDATE' and (new.estimate_id <> old.estimate_id or new.organization_id <> old.organization_id) then
    raise exception 'line item estimate and organization are immutable';
  end if;
  if v_status <> 'draft' then
    raise exception 'line items can only change while the estimate is a draft';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace trigger estimate_line_items_guard
  before insert or update or delete on public.estimate_line_items
  for each row execute function public.estimate_line_items_guard();

alter table public.estimate_line_items enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'estimate_line_items' and policyname = 'estimate_line_items_select') then
    create policy estimate_line_items_select on public.estimate_line_items for select to authenticated using (is_org_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'estimate_line_items' and policyname = 'estimate_line_items_insert') then
    create policy estimate_line_items_insert on public.estimate_line_items for insert to authenticated with check (is_org_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'estimate_line_items' and policyname = 'estimate_line_items_update') then
    create policy estimate_line_items_update on public.estimate_line_items for update to authenticated using (is_org_member(organization_id)) with check (is_org_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'estimate_line_items' and policyname = 'estimate_line_items_delete') then
    create policy estimate_line_items_delete on public.estimate_line_items for delete to authenticated using (is_org_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'estimate_line_items' and policyname = 'estimate_line_items_payment_active') then
    create policy estimate_line_items_payment_active on public.estimate_line_items as restrictive for all to public
      using (organization_payment_active(organization_id)) with check (organization_payment_active(organization_id));
  end if;
end $$;

revoke all on public.estimate_line_items from anon;
grant select, insert, update, delete on public.estimate_line_items to authenticated;
grant all on public.estimate_line_items to service_role;

commit;

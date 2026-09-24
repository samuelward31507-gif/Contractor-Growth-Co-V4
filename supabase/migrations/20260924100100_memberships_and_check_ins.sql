-- Gym Foundation Phase 1, Sections 3-4: the two minimal entities a gym
-- vertical needs that nothing in the contractor schema already covers -
-- a membership (the commercial relationship between an org and a member)
-- and a check-in (a single gym visit). Deliberately NOT: class scheduling,
-- trainer/PT management, payment processing, POS, barcode/access-control
-- hardware, or a member self-service portal - those are explicit Phase 1
-- non-goals. No automation reads or writes these tables yet.
--
-- Modeled directly on calendar_connections' own shape/conventions
-- (20260922040000_calendar_connections.sql) - the most recent precedent for
-- adding a brand-new org-scoped table in this schema: is_org_member RLS for
-- all four commands (this is operational CRM data any org member can work
-- with, like appointments/contacts, not admin-only settings), the existing
-- organization_payment_active() RESTRICTIVE policy reused verbatim, plain
-- `create table`/`create policy` (no idempotent do-block needed - these are
-- brand-new tables, not columns being added to an existing one).
--
-- contact_id FK uses ON DELETE RESTRICT, not the older SET NULL style
-- (leads/review_requests) - matching 20260923030500's own precedent and
-- reasoning: a membership or check-in is itself a historical business
-- record anchored to a specific member, the same category as an
-- appointment/estimate/job, so a contact with any membership or check-in
-- history can no longer be deleted, exactly like a contact with any
-- appointment/estimate/job today. deleteContact() already catches Postgres
-- 23503 and returns a friendly message for this exact constraint shape
-- (app/(app)/contacts/actions.ts) - no application code changes are
-- required for that handling to also cover these two new tables.
--
-- guard_same_organization_contact(): no existing table in this schema has a
-- cross-organization FK-match guard trigger (only generic updated_at
-- triggers exist) - RLS alone already prevents a client from ever SELECTing
-- a foreign-org contact to reference, but Phase 1 explicitly, repeatedly
-- requires memberships/check-ins can never reference a cross-org contact,
-- so this migration adds one small, reusable trigger function (mirroring
-- guard_organizations_payment_status()'s raise-exception style) and attaches
-- it to both new tables - it does not touch any existing table or trigger.

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete restrict,
  plan_name text not null,
  status text not null default 'active'
    check (status in ('active', 'paused', 'cancelled', 'expired')),
  start_at timestamptz not null,
  end_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.check_ins (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete restrict,
  checked_in_at timestamptz not null default now(),
  checked_out_at timestamptz,
  -- Free text, unconstrained, mirroring leads.source's own precedent - no
  -- existing enum/CHECK convention for "where did this event originate"
  -- exists anywhere else in this schema either.
  source text,
  created_at timestamptz not null default now()
);

create index idx_memberships_org on public.memberships (organization_id);
create index idx_memberships_contact on public.memberships (contact_id);
create index idx_memberships_org_status on public.memberships (organization_id, status);

create index idx_check_ins_org on public.check_ins (organization_id);
create index idx_check_ins_contact on public.check_ins (contact_id);
create index idx_check_ins_contact_checked_in_at on public.check_ins (contact_id, checked_in_at desc);

create trigger memberships_updated_at
  before update on public.memberships
  for each row execute function public.set_updated_at();

alter table public.memberships enable row level security;
alter table public.check_ins enable row level security;

create policy memberships_select on public.memberships
  for select to authenticated using (public.is_org_member(organization_id));
create policy memberships_insert on public.memberships
  for insert to authenticated with check (public.is_org_member(organization_id));
create policy memberships_update on public.memberships
  for update to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
create policy memberships_delete on public.memberships
  for delete to authenticated using (public.is_org_member(organization_id));
create policy memberships_payment_active on public.memberships
  as restrictive for all to public
  using (public.organization_payment_active(organization_id))
  with check (public.organization_payment_active(organization_id));

create policy check_ins_select on public.check_ins
  for select to authenticated using (public.is_org_member(organization_id));
create policy check_ins_insert on public.check_ins
  for insert to authenticated with check (public.is_org_member(organization_id));
create policy check_ins_update on public.check_ins
  for update to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
create policy check_ins_delete on public.check_ins
  for delete to authenticated using (public.is_org_member(organization_id));
create policy check_ins_payment_active on public.check_ins
  as restrictive for all to public
  using (public.organization_payment_active(organization_id))
  with check (public.organization_payment_active(organization_id));

create or replace function public.guard_same_organization_contact()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  if not exists (
    select 1 from public.contacts
    where id = new.contact_id
      and organization_id = new.organization_id
  ) then
    raise exception 'contact_id must belong to the same organization_id';
  end if;
  return new;
end;
$$;

create trigger memberships_same_organization_contact
  before insert or update on public.memberships
  for each row
  execute function public.guard_same_organization_contact();

create trigger check_ins_same_organization_contact
  before insert or update on public.check_ins
  for each row
  execute function public.guard_same_organization_contact();

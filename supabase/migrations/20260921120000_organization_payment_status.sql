-- Payment Gate V1.
--
-- The invariant this column exists to enforce: NO PAYMENT = NO USABLE
-- TRACKPR WORKSPACE. Today, bootstrap_organization() (see
-- 20260917060537_bootstrap_organization.sql) lets any authenticated Supabase
-- user create a fully-functional organization + owner membership for free,
-- and app/(app)/layout.tsx grants full Trackpr access to anyone with any
-- organization membership - there is no payment concept anywhere in this
-- schema. This migration adds the smallest field capable of representing
-- that gate without changing bootstrap_organization, its RLS, or any
-- existing table shape.
--
-- Exactly the same safe-migration pattern as
-- 20260920000000_organization_automation_mode.sql: every organization that
-- already exists today has been operating with unrestricted access - it has
-- effectively always been "active". Backfilling every pre-existing row to
-- 'active' preserves that behavior exactly (no existing client is ever
-- retroactively locked out), and only setting the column's default to
-- 'payment_required' afterward means only organizations created AFTER this
-- migration runs (via the unchanged bootstrap_organization RPC) start
-- gated. Run this once, review the row count it reports, and confirm
-- before deploying application code that reads/writes this column.
--
-- Values: 'payment_required' (org exists, no usable CRM access yet),
-- 'active' (paid, full access), plus 'suspended'/'cancelled' reserved for
-- future subscription-lifecycle handling (not read or written by any code
-- in this pass - included now only so a later pass doesn't need a second
-- migration to add them).

alter table public.organizations
  add column if not exists payment_status text;

update public.organizations
  set payment_status = 'active'
  where payment_status is null;

alter table public.organizations
  alter column payment_status set default 'payment_required';

alter table public.organizations
  alter column payment_status set not null;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.organizations'::regclass
      and conname = 'organizations_payment_status_check'
  ) then
    alter table public.organizations
      add constraint organizations_payment_status_check
      check (payment_status in ('payment_required', 'active', 'suspended', 'cancelled'));
  end if;
end $$;

-- organizations_update (is_org_admin) already lets an organization's own
-- owner/admin update their own row via the ordinary client SDK - this is
-- intentional and unchanged for every other column (business profile
-- fields, automation_mode, etc. are meant to be self-service). Without this
-- guard, that same RLS policy would let an org admin simply PATCH their own
-- payment_status to 'active' directly, defeating the entire gate. This
-- trigger is the only thing that makes payment_status different from every
-- other organizations column: any write to it must come from a
-- service-role connection (the Stripe webhook route, via
-- lib/supabase/service.ts) - never from a session-authenticated request,
-- regardless of role. Fails loudly (raises, not a silent revert) so a
-- misconfigured caller - including our own webhook code, if it were ever
-- accidentally invoked with the anon/session client instead of service-role
-- - is obvious rather than silently swallowed.
create or replace function public.guard_organizations_payment_status()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  if new.payment_status is distinct from old.payment_status and auth.role() is distinct from 'service_role' then
    raise exception 'payment_status can only be changed by a trusted server-side process';
  end if;
  return new;
end;
$$;

drop trigger if exists organizations_payment_status_guard on public.organizations;
create trigger organizations_payment_status_guard
  before update on public.organizations
  for each row
  execute function public.guard_organizations_payment_status();

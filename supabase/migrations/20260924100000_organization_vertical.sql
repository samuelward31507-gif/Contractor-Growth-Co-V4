-- Gym Foundation Phase 1, Section 1: minimal multi-vertical marker.
--
-- Trackpr Core -> Contractor / Gym. This column is the ONLY thing that
-- distinguishes a gym organization from a contractor organization at the
-- data layer - it does not introduce a second tenant system, does not
-- change organization_members/RLS isolation, and does not touch
-- bootstrap_organization() (see 20260917060537_bootstrap_organization.sql),
-- which inserts only `(name)` and already relies on column DEFAULTs for
-- every other organizations column (payment_status, automation_mode) -
-- vertical DEFAULT 'contractor' needs zero RPC changes.
--
-- Exactly the same safe-migration pattern as
-- 20260921120000_organization_payment_status.sql: every organization that
-- exists today was created for the contractor product, so backfilling every
-- pre-existing row to 'contractor' preserves current behavior exactly (no
-- existing org is ever silently reclassified), and only setting the
-- column's default afterward means only orgs created AFTER this migration
-- runs start out explicitly tagged - and they still default to 'contractor'
-- unless a future onboarding flow explicitly sets 'gym'.
--
-- Writable only by a trusted server-side process, same guard shape as
-- organizations_payment_status_guard (20260921120000): there is no
-- legitimate self-service reason for an organization's own admin to change
-- which product vertical their organization is - it is decided once, at
-- onboarding/sales time, not a preference toggle - and allowing self-service
-- writes here would let a customer switch into gym-specific navigation/
-- terminology/automation catalog behavior that Phase 1 does not build a
-- real UI for yet.
--
-- APPLICATION CODE NOTE: this migration is created for review only, per
-- Phase 1 instructions - it is NOT applied to production here. Until it is
-- reviewed and applied, no application code in this pass queries this
-- column directly (a PostgREST embedded-select referencing a column that
-- doesn't exist yet would 400 the entire request and break every
-- authenticated page) - lib/auth/organization.ts hardcodes vertical to
-- 'contractor' until this ships, see that file's own comment.

alter table public.organizations
  add column if not exists vertical text;

update public.organizations
  set vertical = 'contractor'
  where vertical is null;

alter table public.organizations
  alter column vertical set default 'contractor';

alter table public.organizations
  alter column vertical set not null;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.organizations'::regclass
      and conname = 'organizations_vertical_check'
  ) then
    alter table public.organizations
      add constraint organizations_vertical_check
      check (vertical in ('contractor', 'gym'));
  end if;
end $$;

-- Same rationale/shape as guard_organizations_payment_status()
-- (20260921120000_organization_payment_status.sql): without this, the
-- ordinary organizations_update (is_org_admin) policy would let any org
-- admin PATCH their own vertical directly via the client SDK. Fails loudly
-- so a misconfigured caller is obvious rather than silently swallowed.
create or replace function public.guard_organizations_vertical()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  if new.vertical is distinct from old.vertical and auth.role() is distinct from 'service_role' then
    raise exception 'vertical can only be changed by a trusted server-side process';
  end if;
  return new;
end;
$$;

drop trigger if exists organizations_vertical_guard on public.organizations;
create trigger organizations_vertical_guard
  before update on public.organizations
  for each row
  execute function public.guard_organizations_vertical();

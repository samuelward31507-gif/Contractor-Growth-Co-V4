-- Fast-Track Production Readiness, Pass 3: go-live protection.
--
-- The smallest possible organization-level automation state: 'test' or
-- 'live'. The outbound gate (see lib/automation/outbound-gate.ts) denies
-- every customer-facing automated send for an organization that is not
-- 'live', independent of every other safety check it already performs -
-- this can only ever add an additional restriction, never bypass one.
-- Manual/internal testing (creating leads, appointments, etc. in the CRM
-- UI) is unaffected - only the automation send path is gated.
--
-- IMPORTANT for whoever applies this: any organization that already exists
-- in production today has been operating with no such restriction at all -
-- its automation has always been effectively "live". Adding a NOT NULL
-- column with a blanket DEFAULT 'test' would silently flip every existing
-- organization's automation off the moment this migration runs, which is
-- exactly the kind of production behavior change this fast-track pass was
-- told never to make. So this backfills every pre-existing organization to
-- 'live' explicitly (preserving exactly the behavior they already have
-- today), and only then sets the column's default to 'test' - meaning only
-- organizations created AFTER this migration runs (via bootstrap_organization,
-- unchanged) start in Test mode, per the actual requirement ("new
-- organizations default to test"). Run this once, review the row count it
-- reports, and confirm before deploying the application code that reads it.

alter table public.organizations
  add column if not exists automation_mode text;

update public.organizations
  set automation_mode = 'live'
  where automation_mode is null;

alter table public.organizations
  alter column automation_mode set default 'test';

alter table public.organizations
  alter column automation_mode set not null;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.organizations'::regclass
      and conname = 'organizations_automation_mode_check'
  ) then
    alter table public.organizations
      add constraint organizations_automation_mode_check
      check (automation_mode in ('test', 'live'));
  end if;
end $$;

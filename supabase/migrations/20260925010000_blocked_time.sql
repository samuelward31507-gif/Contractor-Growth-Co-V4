-- Pass 2 (Native Calendar System): the smallest schema addition needed to
-- represent blocked time (lunch, personal time, vacation, internal
-- meetings, travel, maintenance) as a real, availability-affecting concept.
--
-- WHY A NEW TABLE, NOT A REUSE OF appointments: appointments.contact_id is
-- nullable, so a contact-less "appointment" was briefly considered instead
-- of a new table - rejected because (a) it would silently count toward
-- every appointment-shaped query/automation in this codebase (dashboard
-- counts, automation lifecycle events, n8n confirmation dispatch, the
-- appointments list page) that has no reason to ever see a blocked period,
-- and (b) appointments.status's check constraint (scheduled/confirmed/
-- completed/cancelled/no_show) has no state that means "not customer-
-- facing, blocks time" - stretching an existing enum to mean something new
-- is exactly the kind of schema reuse Pass 2's own instructions warn
-- against ("do not redesign the database simply to make the calendar
-- easier" cuts both ways - it also means don't force an unrelated concept
-- into an existing table just to avoid a second one). A dedicated table
-- with its own two-column shape (start_at/end_at + a free-text reason) is
-- the minimal, honest representation.
--
-- WHY NO PER-TECHNICIAN COLUMN: confirmed by inspection (see
-- lib/appointments/overlap.ts's own header comment and the
-- appointments_no_overlap exclusion constraint in
-- 20260922030000_appointment_double_booking_protection.sql) that this
-- schema has no staff/technician representation anywhere and the existing
-- double-booking protection is deliberately organization-wide. blocked_time
-- matches that exact granularity - organization-wide, not per-tech - so it
-- composes with the existing availability engine without implying a
-- per-technician scheduling model this codebase does not actually have.
--
-- WHY NO EXCLUSION CONSTRAINT ON blocked_time ITSELF: unlike appointments,
-- two overlapping blocked periods are not a safety hazard (at most
-- redundant), and blocked_time never needs to prevent itself from
-- overlapping an appointment at the database level - the calendar UI
-- surfaces that as a soft conflict warning, and availability computation
-- (lib/scheduling/availability.ts) is the actual enforcement point for
-- "never offer a slot that overlaps blocked time", exactly like it already
-- is for appointments and Google Calendar busy periods.
--
-- RLS shape matches appointments exactly (member-level select/insert/
-- update/delete, not admin-only like services) - blocking time is a
-- day-to-day scheduling operation any team member should be able to do,
-- the same access level appointments themselves already have. The payment-
-- gate RESTRICTIVE policy (organization_payment_active(), from
-- 20260921150000_payment_gate_rls_enforcement.sql) is reused verbatim and
-- added here for this new table, consistent with every other ordinary
-- business-data table that migration already gates - appointments,
-- business_hours, and booking_settings are the closest siblings and are
-- all gated.

create table if not exists public.blocked_time (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at > start_at)
);

create index if not exists idx_blocked_time_org_start on public.blocked_time (organization_id, start_at);

alter table public.blocked_time enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'blocked_time' and policyname = 'blocked_time_select') then
    create policy blocked_time_select on public.blocked_time for select to authenticated using (is_org_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'blocked_time' and policyname = 'blocked_time_insert') then
    create policy blocked_time_insert on public.blocked_time for insert to authenticated with check (is_org_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'blocked_time' and policyname = 'blocked_time_update') then
    create policy blocked_time_update on public.blocked_time for update to authenticated using (is_org_member(organization_id)) with check (is_org_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'blocked_time' and policyname = 'blocked_time_delete') then
    create policy blocked_time_delete on public.blocked_time for delete to authenticated using (is_org_member(organization_id));
  end if;
end $$;

drop policy if exists blocked_time_payment_active on public.blocked_time;
create policy blocked_time_payment_active on public.blocked_time as restrictive for all to public
  using (public.organization_payment_active(organization_id))
  with check (public.organization_payment_active(organization_id));

-- Replay-safe the same way this repo's own precedent already is
-- (organizations_vertical_guard, 20260924100000_organization_vertical.sql):
-- drop-if-exists then create, not a bare CREATE TRIGGER - a plain CREATE
-- TRIGGER has no IF NOT EXISTS form in Postgres, so re-running this file
-- against a database that already has this trigger (as production does)
-- would otherwise fail with "trigger already exists". Functionally a
-- no-op on a database that already has it: same name, same timing, same
-- function - nothing about the trigger's behavior changes.
drop trigger if exists set_blocked_time_updated_at on public.blocked_time;
create trigger set_blocked_time_updated_at
  before update on public.blocked_time
  for each row execute function public.set_updated_at();

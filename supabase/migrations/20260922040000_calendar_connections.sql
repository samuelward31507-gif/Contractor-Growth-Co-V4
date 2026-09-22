-- Phase 1 Scheduling Foundation, Stage 3: Google Calendar connection layer.
--
-- TWO-TABLE SPLIT (per the Phase 1 audit's own recommendation): calendar_connections
-- holds only safe, client-displayable metadata and follows the exact same
-- RLS shape every other settings table already uses (is_org_member for
-- SELECT, is_org_admin for INSERT/UPDATE/DELETE, plus the existing
-- Blocker #1 payment-gate RESTRICTIVE policy - organization_payment_active()
-- already exists, reused verbatim, not redefined). calendar_credentials
-- holds the actual OAuth tokens and gets ZERO policies for authenticated/
-- anon - RLS is enabled with no permissive policy at all, which is a
-- default-deny for every role except service_role (which bypasses RLS
-- entirely, exactly like every other service-role-only write path in this
-- schema - see lib/supabase/service.ts's own module comment). This means a
-- session-authenticated client - including the organization's own owner -
-- can never SELECT/INSERT/UPDATE/DELETE a single row of this table via
-- PostgREST, regardless of role; only server code holding the service-role
-- key can, and only app code that has already independently verified the
-- caller server-side ever uses that key for this table (the OAuth callback
-- route, and lib/calendar/connection.ts's credential read/refresh/write
-- functions).
--
-- ON DELETE CASCADE from calendar_credentials to calendar_connections means
-- disconnecting (deleting the connection row) always purges its stored
-- tokens as the same atomic operation - there is no code path that can
-- delete a connection while accidentally leaving its credentials behind.
--
-- calendar_credentials is keyed 1:1 by calendar_connection_id (its own
-- primary key, no separate surrogate id) - the same convention
-- booking_settings already uses (keyed 1:1 by organization_id) for a
-- config row that only ever has exactly one instance per parent.
--
-- unique(organization_id, provider) on calendar_connections: this
-- organization-wide (not per-technician) scheduling model supports exactly
-- one active calendar connection per provider per organization, matching
-- how booking_settings/business_hours are already organization-wide rather
-- than per-user.
--
-- appointments.external_event_id/external_calendar_id: additive, nullable,
-- unpopulated by this migration or anything in Stage 3 - Stage 3 only
-- builds the connection layer itself; no appointment ever gets synced to
-- Google until a later stage. Opaque string ids only, no special RLS
-- needed beyond the appointments table's own existing policies (an event
-- id carries no more sensitivity than any other appointment field).

create table public.calendar_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null check (provider in ('google')),
  account_email text,
  calendar_id text,
  calendar_name text,
  status text not null default 'connected' check (status in ('connected', 'disconnected', 'error')),
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider)
);

create index idx_calendar_connections_org on public.calendar_connections(organization_id);

alter table public.calendar_connections enable row level security;

create policy calendar_connections_select on public.calendar_connections
  for select to authenticated
  using (public.is_org_member(organization_id));

create policy calendar_connections_insert on public.calendar_connections
  for insert to authenticated
  with check (public.is_org_admin(organization_id));

create policy calendar_connections_update on public.calendar_connections
  for update to authenticated
  using (public.is_org_admin(organization_id))
  with check (public.is_org_admin(organization_id));

create policy calendar_connections_delete on public.calendar_connections
  for delete to authenticated
  using (public.is_org_admin(organization_id));

create policy calendar_connections_payment_active on public.calendar_connections
  as restrictive for all to public
  using (public.organization_payment_active(organization_id))
  with check (public.organization_payment_active(organization_id));

create table public.calendar_credentials (
  calendar_connection_id uuid primary key references public.calendar_connections(id) on delete cascade,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.calendar_credentials enable row level security;
-- Deliberately zero policies for authenticated/anon - see this migration's
-- own header comment. RLS enabled with no permissive policy is a
-- default-deny; only the service_role Postgres role (BYPASSRLS) can ever
-- read or write this table.

alter table public.appointments
  add column if not exists external_event_id text,
  add column if not exists external_calendar_id text;

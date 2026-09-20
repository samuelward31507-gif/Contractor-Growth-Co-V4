-- Fast-Track Production Readiness, Pass 1: baseline schema reconstruction.
--
-- The foundational schema (these 17 tables, plus is_org_member/is_org_admin/
-- set_updated_at) was created directly against the live database before this
-- repository's migration history began - every existing migration file only
-- ALTERs tables that already existed. A fresh `supabase db push` against an
-- empty database could not reconstruct Trackpr's schema without this file.
--
-- This migration reconstructs exactly what already exists in production
-- today, as verified directly against it - nothing more, nothing renamed,
-- nothing "improved". Every statement is idempotent (IF NOT EXISTS / guarded
-- policy creation) so running this against the already-populated production
-- database is always a safe no-op, never a behavior change. Columns/indexes
-- that a later, already-versioned migration in this repo adds (e.g.
-- organizations.sms_phone_number, contacts.sms_opt_out, messages.status) are
-- deliberately NOT included here - they remain owned by those migrations.
--
-- is_agency_admin() and the agency_admins/agency_organizations tables it
-- references are intentionally left to their own existing migration
-- (20260918182032_agency_command_center_foundation.sql) - a SQL function
-- body is not validated against referenced-table existence at CREATE TIME in
-- Postgres, so leaving it there causes no ordering hazard.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------------
create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  timezone text not null default 'America/Denver',
  phone text,
  email text,
  address text,
  city text,
  state text,
  zip text,
  website text
);
alter table public.organizations enable row level security;

-- ---------------------------------------------------------------------------
-- organization_members
-- ---------------------------------------------------------------------------
create table if not exists public.organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);
create index if not exists idx_org_members_user on public.organization_members (user_id);
create index if not exists idx_org_members_org on public.organization_members (organization_id);
alter table public.organization_members enable row level security;

-- ---------------------------------------------------------------------------
-- Core authorization functions - identical to the live production bodies.
-- ---------------------------------------------------------------------------
create or replace function public.is_org_member(target_org_id uuid)
returns boolean
language sql
stable security definer
set search_path = 'public'
as $$
  select exists (
    select 1
    from public.organization_members om
    where om.organization_id = target_org_id
      and om.user_id = auth.uid()
  );
$$;

create or replace function public.is_org_admin(target_org_id uuid)
returns boolean
language sql
stable security definer
set search_path = 'public'
as $$
  select exists (
    select 1
    from public.organization_members om
    where om.organization_id = target_org_id
      and om.user_id = auth.uid()
      and om.role in ('owner', 'admin')
  );
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = 'public'
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'organizations' and policyname = 'organizations_select') then
    create policy organizations_select on public.organizations for select to authenticated using (is_org_member(id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'organizations' and policyname = 'organizations_update') then
    create policy organizations_update on public.organizations for update to authenticated using (is_org_admin(id)) with check (is_org_admin(id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'organization_members' and policyname = 'organization_members_select') then
    create policy organization_members_select on public.organization_members for select to authenticated using (is_org_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'organization_members' and policyname = 'organization_members_insert') then
    create policy organization_members_insert on public.organization_members for insert to authenticated with check (is_org_admin(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'organization_members' and policyname = 'organization_members_update') then
    create policy organization_members_update on public.organization_members for update to authenticated using (is_org_admin(organization_id)) with check (is_org_admin(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'organization_members' and policyname = 'organization_members_delete') then
    create policy organization_members_delete on public.organization_members for delete to authenticated using (is_org_admin(organization_id));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- contacts
-- ---------------------------------------------------------------------------
create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  first_name text,
  last_name text,
  phone text,
  email text,
  company_name text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_contacts_org on public.contacts (organization_id);
create index if not exists idx_contacts_phone on public.contacts (phone);
create index if not exists idx_contacts_email on public.contacts (email);
alter table public.contacts enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'contacts' and policyname = 'contacts_select') then
    create policy contacts_select on public.contacts for select to authenticated using (is_org_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'contacts' and policyname = 'contacts_insert') then
    create policy contacts_insert on public.contacts for insert to authenticated with check (is_org_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'contacts' and policyname = 'contacts_update') then
    create policy contacts_update on public.contacts for update to authenticated using (is_org_member(organization_id)) with check (is_org_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'contacts' and policyname = 'contacts_delete') then
    create policy contacts_delete on public.contacts for delete to authenticated using (is_org_member(organization_id));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- leads
-- ---------------------------------------------------------------------------
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  source text,
  service text,
  status text not null default 'new' check (status in ('new', 'contacted', 'qualified', 'appointment', 'estimate', 'won', 'lost')),
  temperature text not null default 'cold' check (temperature in ('cold', 'warm', 'hot')),
  estimated_value numeric,
  ai_score integer check (ai_score >= 0 and ai_score <= 100),
  ai_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_leads_org on public.leads (organization_id);
create index if not exists idx_leads_contact on public.leads (contact_id);
create index if not exists idx_leads_status on public.leads (organization_id, status);
create index if not exists idx_leads_temperature on public.leads (organization_id, temperature);
create index if not exists idx_leads_created on public.leads (organization_id, created_at desc);
alter table public.leads enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'leads' and policyname = 'leads_select') then
    create policy leads_select on public.leads for select to authenticated using (is_org_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'leads' and policyname = 'leads_insert') then
    create policy leads_insert on public.leads for insert to authenticated with check (is_org_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'leads' and policyname = 'leads_update') then
    create policy leads_update on public.leads for update to authenticated using (is_org_member(organization_id)) with check (is_org_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'leads' and policyname = 'leads_delete') then
    create policy leads_delete on public.leads for delete to authenticated using (is_org_member(organization_id));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- conversations
-- ---------------------------------------------------------------------------
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  lead_id uuid references public.leads(id) on delete set null,
  channel text not null check (channel in ('sms', 'voice', 'email', 'web')),
  status text not null default 'open' check (status in ('open', 'closed')),
  ai_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_conversations_org on public.conversations (organization_id);
create index if not exists idx_conversations_contact on public.conversations (contact_id);
alter table public.conversations enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'conversations' and policyname = 'conversations_select') then
    create policy conversations_select on public.conversations for select to authenticated using (is_org_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'conversations' and policyname = 'conversations_insert') then
    create policy conversations_insert on public.conversations for insert to authenticated with check (is_org_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'conversations' and policyname = 'conversations_update') then
    create policy conversations_update on public.conversations for update to authenticated using (is_org_member(organization_id)) with check (is_org_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'conversations' and policyname = 'conversations_delete') then
    create policy conversations_delete on public.conversations for delete to authenticated using (is_org_member(organization_id));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- messages (baseline shape only - status/status_reason/workflow_execution_id/
-- updated_at/provider_error_code are added by later, already-versioned
-- migrations in this repo).
-- ---------------------------------------------------------------------------
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  direction text not null check (direction in ('inbound', 'outbound')),
  sender_type text not null check (sender_type in ('customer', 'ai', 'user', 'system')),
  body text not null,
  provider_message_id text,
  created_at timestamptz not null default now()
);
create index if not exists idx_messages_conversation on public.messages (conversation_id, created_at);
create index if not exists idx_messages_org on public.messages (organization_id);
alter table public.messages enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'messages' and policyname = 'messages_select') then
    create policy messages_select on public.messages for select to authenticated using (is_org_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'messages' and policyname = 'messages_insert') then
    create policy messages_insert on public.messages for insert to authenticated with check (is_org_member(organization_id));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- appointments
-- ---------------------------------------------------------------------------
create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  lead_id uuid references public.leads(id) on delete set null,
  title text not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'confirmed', 'completed', 'cancelled', 'no_show')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at > start_at)
);
create index if not exists idx_appointments_org on public.appointments (organization_id);
create index if not exists idx_appointments_start on public.appointments (organization_id, start_at);
create index if not exists idx_appointments_status on public.appointments (organization_id, status);
alter table public.appointments enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'appointments' and policyname = 'appointments_select') then
    create policy appointments_select on public.appointments for select to authenticated using (is_org_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'appointments' and policyname = 'appointments_insert') then
    create policy appointments_insert on public.appointments for insert to authenticated with check (is_org_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'appointments' and policyname = 'appointments_update') then
    create policy appointments_update on public.appointments for update to authenticated using (is_org_member(organization_id)) with check (is_org_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'appointments' and policyname = 'appointments_delete') then
    create policy appointments_delete on public.appointments for delete to authenticated using (is_org_member(organization_id));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- ai_settings
-- ---------------------------------------------------------------------------
create table if not exists public.ai_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  ai_enabled boolean not null default false,
  tone text,
  business_introduction text,
  general_instructions text,
  emergency_instructions text,
  escalation_instructions text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.ai_settings enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'ai_settings' and policyname = 'ai_settings_select') then
    create policy ai_settings_select on public.ai_settings for select using (is_org_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'ai_settings' and policyname = 'ai_settings_insert') then
    create policy ai_settings_insert on public.ai_settings for insert with check (is_org_admin(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'ai_settings' and policyname = 'ai_settings_update') then
    create policy ai_settings_update on public.ai_settings for update using (is_org_admin(organization_id)) with check (is_org_admin(organization_id));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- ai_interactions (baseline shape only - workflow_execution_id is added by
-- 20260918052910_ai_interaction_execution_idempotency.sql).
-- ---------------------------------------------------------------------------
create table if not exists public.ai_interactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  lead_id uuid references public.leads(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,
  interaction_type text not null,
  input jsonb not null default '{}'::jsonb,
  output jsonb not null default '{}'::jsonb,
  model text,
  tokens_used integer,
  created_at timestamptz not null default now()
);
create index if not exists idx_ai_interactions_org on public.ai_interactions (organization_id);
create index if not exists idx_ai_interactions_lead on public.ai_interactions (lead_id);
create index if not exists idx_ai_interactions_created on public.ai_interactions (organization_id, created_at desc);
alter table public.ai_interactions enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'ai_interactions' and policyname = 'ai_interactions_select') then
    create policy ai_interactions_select on public.ai_interactions for select to authenticated using (is_org_member(organization_id));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- audit_log (baseline shape only - automation_id is added by
-- 20260919040902_automation_control_center_v2_foundation.sql).
-- ---------------------------------------------------------------------------
create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity_type text,
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_audit_log_org on public.audit_log (organization_id);
create index if not exists idx_audit_log_created on public.audit_log (organization_id, created_at desc);
alter table public.audit_log enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'audit_log' and policyname = 'audit_log_select') then
    create policy audit_log_select on public.audit_log for select to authenticated using (is_org_member(organization_id));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- automation_events (baseline shape only - updated_at/idempotency_key are
-- added by 20260917061708_automation_core_foundation.sql).
-- ---------------------------------------------------------------------------
create table if not exists public.automation_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event_type text not null,
  entity_type text,
  entity_id uuid,
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'failed')),
  payload jsonb not null default '{}'::jsonb,
  error_message text,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_automation_events_org on public.automation_events (organization_id);
create index if not exists idx_automation_events_status on public.automation_events (organization_id, status);
create index if not exists idx_automation_events_entity on public.automation_events (entity_type, entity_id);
create index if not exists idx_automation_events_created on public.automation_events (organization_id, created_at desc);
alter table public.automation_events enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'automation_events' and policyname = 'automation_events_select') then
    create policy automation_events_select on public.automation_events for select to authenticated using (is_org_member(organization_id));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- workflow_executions (baseline shape only - trigger_source is added by
-- 20260919040902_automation_control_center_v2_foundation.sql).
-- ---------------------------------------------------------------------------
create table if not exists public.workflow_executions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  automation_event_id uuid references public.automation_events(id) on delete set null,
  workflow_name text not null,
  status text not null default 'running' check (status in ('running', 'completed', 'failed', 'cancelled')),
  attempt integer not null default 1,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  error_message text,
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists idx_workflow_executions_org on public.workflow_executions (organization_id);
create index if not exists idx_workflow_executions_status on public.workflow_executions (organization_id, status);
alter table public.workflow_executions enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'workflow_executions' and policyname = 'workflow_executions_select') then
    create policy workflow_executions_select on public.workflow_executions for select to authenticated using (is_org_member(organization_id));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- business_hours
-- ---------------------------------------------------------------------------
create table if not exists public.business_hours (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  day_of_week text not null check (day_of_week in ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')),
  is_open boolean not null default true,
  open_time time,
  close_time time,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, day_of_week),
  check (is_open = false or (open_time is not null and close_time is not null and close_time > open_time))
);
create index if not exists idx_business_hours_org on public.business_hours (organization_id);
alter table public.business_hours enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'business_hours' and policyname = 'business_hours_select') then
    create policy business_hours_select on public.business_hours for select using (is_org_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'business_hours' and policyname = 'business_hours_insert') then
    create policy business_hours_insert on public.business_hours for insert with check (is_org_admin(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'business_hours' and policyname = 'business_hours_update') then
    create policy business_hours_update on public.business_hours for update using (is_org_admin(organization_id)) with check (is_org_admin(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'business_hours' and policyname = 'business_hours_delete') then
    create policy business_hours_delete on public.business_hours for delete using (is_org_admin(organization_id));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- booking_settings
-- ---------------------------------------------------------------------------
create table if not exists public.booking_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  booking_enabled boolean not null default false,
  minimum_notice_minutes integer not null default 60 check (minimum_notice_minutes >= 0),
  default_duration_minutes integer not null default 60 check (default_duration_minutes > 0),
  buffer_minutes integer not null default 0 check (buffer_minutes >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.booking_settings enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'booking_settings' and policyname = 'booking_settings_select') then
    create policy booking_settings_select on public.booking_settings for select using (is_org_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'booking_settings' and policyname = 'booking_settings_insert') then
    create policy booking_settings_insert on public.booking_settings for insert with check (is_org_admin(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'booking_settings' and policyname = 'booking_settings_update') then
    create policy booking_settings_update on public.booking_settings for update using (is_org_admin(organization_id)) with check (is_org_admin(organization_id));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- notification_settings
-- ---------------------------------------------------------------------------
create table if not exists public.notification_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  notification_email text,
  notification_phone text,
  notify_on_hot_lead boolean not null default true,
  notify_on_ai_escalation boolean not null default true,
  notify_on_missed_call boolean not null default true,
  notify_on_appointment_booked boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.notification_settings enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notification_settings' and policyname = 'notification_settings_select') then
    create policy notification_settings_select on public.notification_settings for select using (is_org_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notification_settings' and policyname = 'notification_settings_insert') then
    create policy notification_settings_insert on public.notification_settings for insert with check (is_org_admin(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notification_settings' and policyname = 'notification_settings_update') then
    create policy notification_settings_update on public.notification_settings for update using (is_org_admin(organization_id)) with check (is_org_admin(organization_id));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- service_areas
-- ---------------------------------------------------------------------------
create table if not exists public.service_areas (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_service_areas_org on public.service_areas (organization_id);
alter table public.service_areas enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'service_areas' and policyname = 'service_areas_select') then
    create policy service_areas_select on public.service_areas for select using (is_org_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'service_areas' and policyname = 'service_areas_insert') then
    create policy service_areas_insert on public.service_areas for insert with check (is_org_admin(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'service_areas' and policyname = 'service_areas_delete') then
    create policy service_areas_delete on public.service_areas for delete using (is_org_admin(organization_id));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- services
-- ---------------------------------------------------------------------------
create table if not exists public.services (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_services_org on public.services (organization_id);
alter table public.services enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'services' and policyname = 'services_select') then
    create policy services_select on public.services for select using (is_org_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'services' and policyname = 'services_insert') then
    create policy services_insert on public.services for insert with check (is_org_admin(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'services' and policyname = 'services_update') then
    create policy services_update on public.services for update using (is_org_admin(organization_id)) with check (is_org_admin(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'services' and policyname = 'services_delete') then
    create policy services_delete on public.services for delete using (is_org_admin(organization_id));
  end if;
end $$;

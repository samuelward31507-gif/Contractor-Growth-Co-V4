-- Automation Control Center V2 - Phase A (schema foundation only).
--
-- Derived from a dedicated, prior read-only architecture/schema audit of the
-- automation system (execution lifecycle, audit_log, RLS/security model).
-- This migration adds ONLY the schema this phase approved - no enable/disable
-- enforcement, no manual-run/retry code paths, and no config storage yet
-- (deferred until a real automation has a real user-facing setting to store).

-- 1. audit_log.automation_id
--
-- audit_log.entity_id is left unchanged (still uuid) - every existing
-- entity_id column in this codebase (automation_events.entity_id included)
-- always holds a real row's UUID, and audit_log.entity_id should keep that
-- one meaning rather than becoming ambiguous. automation_id is a separate,
-- always-populated identifier for which catalog automation (a static
-- TypeScript-defined slug, e.g. "instant-lead-followup" - see
-- lib/automation/catalog.ts) an administrative action concerns, including
-- actions like enable/disable that have no underlying database row to point
-- entity_id at.
alter table public.audit_log
  add column automation_id text;

-- 2. automation_settings
--
-- Per-organization enable/disable state for a catalog automation. Modeled on
-- the existing services table (same RLS shape: select via is_org_member,
-- mutation via is_org_admin; same set_updated_at() trigger convention).
-- Deliberately has no `config` column and no `updated_by` column - see the
-- migration header above and the corresponding audit for why both are
-- deferred rather than speculative. Deliberately has no custom RPC: this
-- codebase's established pattern for admin-mutated per-org settings is a
-- direct table write through RLS (see services, ai_settings, etc.), not a
-- SECURITY DEFINER function - automation_settings needs neither a
-- service-role bypass nor an atomic multi-table transition, so introducing
-- one would be inconsistent with every comparable settings table.
create table public.automation_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  automation_id text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, automation_id)
);

create trigger automation_settings_updated_at
  before update on public.automation_settings
  for each row execute function set_updated_at();

alter table public.automation_settings enable row level security;

create policy automation_settings_select on public.automation_settings
  for select using (is_org_member(organization_id));

create policy automation_settings_insert on public.automation_settings
  for insert with check (is_org_admin(organization_id));

create policy automation_settings_update on public.automation_settings
  for update using (is_org_admin(organization_id)) with check (is_org_admin(organization_id));

-- No delete policy: rows are upserted (enabled/disabled), never removed.

-- 3. workflow_executions.trigger_source
--
-- Distinguishes a real, production-triggered execution from a future
-- manual "run now" or a retry of a prior failed attempt. Required before any
-- manual-run/retry feature ships, so that execution stats and health/
-- attention detection can exclude non-production rows - see the Phase A
-- audit for the full list of queries that will need that filter added
-- (getWorkflowNameStats, getRecentExecutionsForWorkflows, the automation
-- health endpoint's stuck-execution scan). This migration only adds the
-- column; none of those queries are modified in this phase, and no code
-- path writes a value other than the 'event' default yet, so existing
-- behavior is unchanged.
alter table public.workflow_executions
  add column trigger_source text not null default 'event'
    check (trigger_source in ('event', 'manual', 'retry'));

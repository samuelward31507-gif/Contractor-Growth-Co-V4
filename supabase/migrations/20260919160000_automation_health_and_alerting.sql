-- Automation Health + Alerting V1.
--
-- Audited first (see the feature's own final report): automation_events,
-- workflow_executions, ai_interactions, messages, audit_log, and the
-- existing /api/automation/health stuck-execution scan already exist and are
-- reused as-is - nothing about their schema or write paths changes here.
-- What does not exist today: any durable record that a failure/stuck/
-- delivery-failure signal was ever actually detected, deduplicated, and
-- tracked to resolution - "an execution failed" and "an operator was told
-- about it and confirmed it's handled" were indistinguishable. This
-- migration adds exactly the two tables needed to close that gap.
--
-- automation_incidents is modeled directly on review_requests/
-- referral_requests' own shape and conventions (same is_org_member-based
-- select policy, same set_updated_at trigger), with one important
-- difference: incidents are never client-inserted at all (no INSERT policy,
-- matching automation_events/workflow_executions/audit_log's own
-- established "narrow SECURITY DEFINER RPC only" pattern) - detection is a
-- system responsibility, not something any organization member can forge.
-- The partial unique index on (organization_id, fingerprint) WHERE status
-- IN ('open','acknowledged') is the actual, race-condition-safe
-- deduplication guarantee: a flood of 20 identical failures for the same
-- automation within a few minutes can only ever produce ONE active
-- incident, upserted via ON CONFLICT, never 20 separate rows.

create table public.automation_incidents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Catalog id (lib/automation/catalog.ts), not a foreign key - the catalog
  -- is a static TS list, not a database table, matching audit_log.automation_id's
  -- own precedent exactly. Nullable: a small number of failure modes (e.g. a
  -- stuck execution whose workflow_name maps to no catalog automation) have
  -- no automation to attribute to.
  automation_id text,
  -- ON DELETE SET NULL: the incident record must survive even if the
  -- underlying execution row is ever pruned - the incident is the durable
  -- operational record, the execution is only supporting context.
  workflow_execution_id uuid references public.workflow_executions(id) on delete set null,
  category text not null check (category in (
    'workflow_failed', 'repeated_workflow_failure', 'workflow_stuck',
    'n8n_dispatch_failed', 'n8n_callback_failed',
    'sms_send_failed', 'sms_delivery_failed'
  )),
  severity text not null check (severity in ('info', 'warning', 'critical')),
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  -- Deterministic dedup key built by lib/automation-health/fingerprint.ts -
  -- see that file for the exact per-category context rules (e.g. "one
  -- incident per automation while any failure is active" vs. "one incident
  -- per specific stuck execution" vs. "one incident per specific failed
  -- delivery").
  fingerprint text not null,
  title text not null check (char_length(title) <= 200),
  description text check (description is null or char_length(description) <= 1000),
  first_seen_at timestamp with time zone not null default now(),
  last_seen_at timestamp with time zone not null default now(),
  occurrence_count integer not null default 1 check (occurrence_count >= 1),
  resolved_at timestamp with time zone,
  resolved_by uuid references auth.users(id) on delete set null,
  acknowledged_at timestamp with time zone,
  acknowledged_by uuid references auth.users(id) on delete set null,
  -- Sanitized only - never a raw provider error payload, never a Twilio/n8n
  -- credential, never full customer PII. Every writer of this column
  -- (lib/automation-health/service.ts) passes only short, developer-authored
  -- strings or already-truncated/sanitized error text, matching
  -- workflow_executions.error_message's own established handling.
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create index idx_automation_incidents_org_status on public.automation_incidents (organization_id, status);
create index idx_automation_incidents_org_severity on public.automation_incidents (organization_id, severity, status);
create index idx_automation_incidents_org_automation on public.automation_incidents (organization_id, automation_id);
create index idx_automation_incidents_org_updated on public.automation_incidents (organization_id, updated_at desc);
create index idx_automation_incidents_execution on public.automation_incidents (workflow_execution_id);

-- The real dedup guarantee - see the migration's own header comment. Only
-- ever conflicts against an ACTIVE (open/acknowledged) incident: once an
-- incident is resolved, a later recurrence of the exact same problem opens
-- a fresh incident rather than silently reopening old, already-reviewed
-- history.
create unique index automation_incidents_active_fingerprint_unique
  on public.automation_incidents (organization_id, fingerprint)
  where status in ('open', 'acknowledged');

create trigger automation_incidents_updated_at
  before update on public.automation_incidents
  for each row execute function public.set_updated_at();

alter table public.automation_incidents enable row level security;

-- Any org member may VIEW their organization's operational incidents (same
-- access level members already have over jobs/review_requests/automation
-- execution history itself) - managing them (acknowledge/resolve) is a
-- stricter, owner/admin-only authority enforced separately by the two RPCs
-- below, not by this policy. No INSERT/UPDATE/DELETE policy exists at all:
-- every write to this table goes through record_automation_incident_signal,
-- acknowledge_automation_incident, or resolve_automation_incident - never a
-- direct client insert/update, matching automation_events'/audit_log's own
-- "no client-facing write policy" precedent exactly.
create policy automation_incidents_select on public.automation_incidents
  for select using (is_org_member(organization_id));

grant select, references, trigger on public.automation_incidents to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- record_automation_incident_signal: the single, centralized way any part of
-- Trackpr may create or update an incident. Never called directly by a
-- client with an arbitrary organization_id - see the dual auth path below,
-- matching create_automation_event's own service_role/authenticated split
-- (automation_rpcs_service_role_access migration) exactly:
--
--  - service_role callers (the n8n callback route, the SMS status webhook,
--    the /api/automation/health stuck-execution scan, and every dispatch-
--    failure "AsService" code path) already resolved organization_id
--    themselves from a trusted database row (never from client input), so
--    it is trusted directly here, exactly like create_automation_event's own
--    service_role branch.
--  - authenticated (session) callers - the synchronous dispatch-failure
--    paths that run inside a real user's request via next/server's after(),
--    e.g. lib/automation/lead-followup.ts - must independently pass
--    is_org_member(p_organization_id), re-verified here, never trusted from
--    the caller.
--
-- Deduplication is the ON CONFLICT upsert against the partial unique index
-- above. Repeated-failure escalation is deterministic and documented here,
-- not tunable at the call site: once occurrence_count reaches 3 on an
-- active 'workflow_failed' incident, this function itself reclassifies it
-- to 'repeated_workflow_failure' / 'critical' - never invented at a higher
-- layer, and never re-lowered back down automatically (only resolving the
-- incident, or a fresh later incident, can change it again).
create or replace function public.record_automation_incident_signal(
  p_organization_id uuid,
  p_category text,
  p_severity text,
  p_fingerprint text,
  p_title text,
  p_description text default null,
  p_automation_id text default null,
  p_workflow_execution_id uuid default null,
  p_metadata jsonb default '{}'::jsonb
)
returns public.automation_incidents
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_is_service_role boolean;
  v_category text;
  v_severity text;
  v_fingerprint text;
  v_title text;
  v_description text;
  v_automation_id text;
  v_metadata jsonb;
  v_row public.automation_incidents;
begin
  v_is_service_role := (auth.role() = 'service_role');

  if p_organization_id is null then
    raise exception 'organization_id is required';
  end if;

  if not v_is_service_role then
    if auth.uid() is null then
      raise exception 'Not authenticated';
    end if;
    if not public.is_org_member(p_organization_id) then
      raise exception 'Not authorized';
    end if;
  end if;

  v_category := nullif(trim(p_category), '');
  if v_category is null or v_category not in (
    'workflow_failed', 'workflow_stuck',
    'n8n_dispatch_failed', 'n8n_callback_failed',
    'sms_send_failed', 'sms_delivery_failed'
  ) then
    -- 'repeated_workflow_failure' is deliberately excluded from the
    -- caller-supplied allowlist: it is only ever produced by this
    -- function's own escalation logic below, never requested directly.
    raise exception 'Unsupported incident category';
  end if;

  v_severity := nullif(trim(p_severity), '');
  if v_severity is null or v_severity not in ('info', 'warning', 'critical') then
    raise exception 'Unsupported incident severity';
  end if;

  v_fingerprint := nullif(trim(p_fingerprint), '');
  if v_fingerprint is null or length(v_fingerprint) > 300 then
    raise exception 'Invalid fingerprint';
  end if;

  v_title := nullif(trim(p_title), '');
  if v_title is null or length(v_title) > 200 then
    raise exception 'Invalid title';
  end if;

  v_description := nullif(trim(p_description), '');
  if v_description is not null then
    v_description := left(v_description, 1000);
  end if;

  v_automation_id := nullif(trim(p_automation_id), '');

  v_metadata := coalesce(p_metadata, '{}'::jsonb);
  if jsonb_typeof(v_metadata) is distinct from 'object' then
    raise exception 'metadata must be a JSON object';
  end if;

  insert into public.automation_incidents as ai (
    organization_id, automation_id, workflow_execution_id, category, severity, status,
    fingerprint, title, description, metadata
  ) values (
    p_organization_id, v_automation_id, p_workflow_execution_id, v_category, v_severity, 'open',
    v_fingerprint, v_title, v_description, v_metadata
  )
  on conflict (organization_id, fingerprint) where status in ('open', 'acknowledged')
  do update set
    occurrence_count = ai.occurrence_count + 1,
    last_seen_at = now(),
    workflow_execution_id = coalesce(excluded.workflow_execution_id, ai.workflow_execution_id),
    title = excluded.title,
    description = excluded.description,
    metadata = excluded.metadata,
    updated_at = now(),
    -- Deterministic repeated-failure threshold: documented once, here -
    -- see lib/automation-health/fingerprint.ts and the feature's final
    -- report for the same threshold restated for readers of the TS layer.
    category = case
      when ai.category = 'workflow_failed' and ai.occurrence_count + 1 >= 3 then 'repeated_workflow_failure'
      else ai.category
    end,
    severity = case
      when ai.category = 'workflow_failed' and ai.occurrence_count + 1 >= 3 then 'critical'
      else ai.severity
    end
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.record_automation_incident_signal(uuid, text, text, text, text, text, text, uuid, jsonb) from public;
revoke all on function public.record_automation_incident_signal(uuid, text, text, text, text, text, text, uuid, jsonb) from anon;
grant execute on function public.record_automation_incident_signal(uuid, text, text, text, text, text, text, uuid, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Manual acknowledge/resolve - organization owner/admin only (is_org_admin,
-- the same authority create_automation_audit_event already uses), never
-- agency admins: the existing Agency Command Center architecture is
-- explicitly read-only everywhere today (see lib/automation/authorization.ts's
-- own documented "Agency Command Center remains read-only" rule) - this
-- migration does not introduce agency-admin mutation as a new precedent.
-- Every transition is audited atomically in the SAME transaction as the
-- status change itself (not a second, best-effort round trip), so a manual
-- action can never succeed while its audit record silently fails to save.

create or replace function public.acknowledge_automation_incident(p_incident_id uuid)
returns public.automation_incidents
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_user_id uuid;
  v_org_id uuid;
  v_row public.automation_incidents;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  select organization_id into v_org_id from public.automation_incidents where id = p_incident_id;
  if v_org_id is null then
    raise exception 'Incident not found';
  end if;

  if not public.is_org_admin(v_org_id) then
    raise exception 'Not authorized';
  end if;

  update public.automation_incidents
  set status = 'acknowledged', acknowledged_at = now(), acknowledged_by = v_user_id, updated_at = now()
  where id = p_incident_id and status = 'open'
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Incident cannot be acknowledged from its current status';
  end if;

  insert into public.audit_log (organization_id, user_id, action, entity_type, entity_id, automation_id, metadata)
  values (v_org_id, v_user_id, 'automation_incident_acknowledged', 'automation_incident', p_incident_id, v_row.automation_id, '{}'::jsonb);

  return v_row;
end;
$$;

revoke all on function public.acknowledge_automation_incident(uuid) from public;
revoke all on function public.acknowledge_automation_incident(uuid) from anon;
grant execute on function public.acknowledge_automation_incident(uuid) to authenticated;

create or replace function public.resolve_automation_incident(p_incident_id uuid)
returns public.automation_incidents
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_user_id uuid;
  v_org_id uuid;
  v_row public.automation_incidents;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  select organization_id into v_org_id from public.automation_incidents where id = p_incident_id;
  if v_org_id is null then
    raise exception 'Incident not found';
  end if;

  if not public.is_org_admin(v_org_id) then
    raise exception 'Not authorized';
  end if;

  update public.automation_incidents
  set status = 'resolved', resolved_at = now(), resolved_by = v_user_id, updated_at = now()
  where id = p_incident_id and status in ('open', 'acknowledged')
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Incident cannot be resolved from its current status';
  end if;

  insert into public.audit_log (organization_id, user_id, action, entity_type, entity_id, automation_id, metadata)
  values (v_org_id, v_user_id, 'automation_incident_resolved', 'automation_incident', p_incident_id, v_row.automation_id, '{}'::jsonb);

  return v_row;
end;
$$;

revoke all on function public.resolve_automation_incident(uuid) from public;
revoke all on function public.resolve_automation_incident(uuid) from anon;
grant execute on function public.resolve_automation_incident(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- automation_health_check_runs: a minimal, global (not organization-scoped)
-- heartbeat log for the external, CRON_SECRET-protected /api/automation/health
-- invocation itself - "is Trackpr's own health-check job even running,
-- and when did it last run" is otherwise unanswerable, since nothing
-- previously recorded that fact. Deliberately not organization-scoped: one
-- invocation of that endpoint scans every organization's stuck executions in
-- a single pass, so "last health check" is inherently one global timestamp,
-- not a per-organization one. Contains no PII and no per-organization data,
-- only counts - safe to expose to any authenticated user.
create table public.automation_health_check_runs (
  id uuid primary key default gen_random_uuid(),
  checked_at timestamp with time zone not null default now(),
  stuck_count integer not null,
  incidents_opened integer not null,
  incidents_resolved integer not null
);

create index idx_automation_health_check_runs_checked_at on public.automation_health_check_runs (checked_at desc);

alter table public.automation_health_check_runs enable row level security;

-- Global, non-sensitive heartbeat data - any authenticated user may read it
-- (used by both the per-organization health page and the Agency Command
-- Center). Only service_role ever writes it (the health-check route itself),
-- so there is no INSERT/UPDATE/DELETE policy for authenticated/anon at all.
create policy automation_health_check_runs_select on public.automation_health_check_runs
  for select using (auth.role() = 'authenticated');

grant select, insert, references, trigger on public.automation_health_check_runs to service_role;
grant select on public.automation_health_check_runs to authenticated;

-- Automation Control Center V2 - Phase D: manual run + dry run foundation.
--
-- Two small, additive RPC changes, both following the exact pattern already
-- established for evolving an RPC without touching its original migration
-- file (see create_automation_event's own p_organization_id addition in
-- 20260918064500_automation_rpcs_service_role_access.sql):
--
-- 1. start_workflow_execution gains an optional p_trigger_source parameter
--    (default 'event'), so a manually-triggered run can be tagged
--    trigger_source = 'manual' at creation time instead of needing a
--    separate, RLS-blocked UPDATE after the fact (workflow_executions has
--    no client UPDATE policy, by design, and this migration does not add
--    one). Every existing call site - every cron tick, every CRUD-triggered
--    automation, the n8n callback route - omits this parameter and keeps
--    getting the column's own DEFAULT 'event', so existing behavior is
--    completely unchanged. Adding a parameter grows the signature, which
--    Postgres treats as a new overload rather than a replacement (confirmed
--    by the same situation when create_automation_event gained
--    p_organization_id) - the old 3-argument overload is dropped below so
--    PostgREST is never ambiguous about which one to call.
--
-- 2. create_automation_audit_event's allowed action list grows to include
--    the two Phase D actions (automation_manual_run_requested,
--    automation_dry_run_requested), alongside the two Phase C.1 actions
--    (automation_enabled, automation_disabled). Same signature as before,
--    so this is a true replace, not a new overload - no drop needed, and
--    Postgres preserves the existing grants for a same-signature replace;
--    the revoke/grant lines below are reapplied anyway, defensively, so
--    this migration is self-contained and doesn't rely on that behavior.

create or replace function public.start_workflow_execution(
  p_automation_event_id uuid,
  p_workflow_name text,
  p_metadata jsonb,
  p_trigger_source text default 'event'
)
returns public.workflow_executions
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_org_id uuid;
  v_event_status text;
  v_workflow_name text;
  v_metadata jsonb;
  v_trigger_source text;
  v_next_attempt int;
  v_execution public.workflow_executions;
  v_is_service_role boolean;
begin
  v_is_service_role := (auth.role() = 'service_role');

  if auth.uid() is null and not v_is_service_role then
    raise exception 'Not authenticated';
  end if;

  select ae.organization_id, ae.status into v_org_id, v_event_status
  from public.automation_events ae
  where ae.id = p_automation_event_id;

  if v_org_id is null then
    raise exception 'Automation event not found';
  end if;

  if not v_is_service_role and not public.is_org_member(v_org_id) then
    raise exception 'Automation event not found';
  end if;

  if v_event_status = 'processing' then
    raise exception 'Automation event is already being processed';
  end if;

  if v_event_status = 'completed' then
    raise exception 'Automation event has already completed';
  end if;

  v_workflow_name := nullif(trim(p_workflow_name), '');
  if v_workflow_name is null then
    raise exception 'workflow_name is required';
  end if;

  v_metadata := coalesce(p_metadata, '{}'::jsonb);
  if jsonb_typeof(v_metadata) is distinct from 'object' then
    raise exception 'metadata must be a JSON object';
  end if;

  v_trigger_source := coalesce(nullif(trim(p_trigger_source), ''), 'event');
  if v_trigger_source not in ('event', 'manual', 'retry') then
    raise exception 'Invalid trigger_source';
  end if;

  select coalesce(max(we.attempt), 0) + 1 into v_next_attempt
  from public.workflow_executions we
  where we.automation_event_id = p_automation_event_id;

  update public.automation_events
  set status = 'processing'
  where id = p_automation_event_id;

  insert into public.workflow_executions (
    organization_id, automation_event_id, workflow_name, status, attempt, started_at, metadata, trigger_source
  ) values (
    v_org_id, p_automation_event_id, v_workflow_name, 'running', v_next_attempt, now(), v_metadata, v_trigger_source
  )
  returning * into v_execution;

  return v_execution;
end;
$$;

drop function if exists public.start_workflow_execution(uuid, text, jsonb);

revoke all on function public.start_workflow_execution(uuid, text, jsonb, text) from public;
revoke all on function public.start_workflow_execution(uuid, text, jsonb, text) from anon;
grant execute on function public.start_workflow_execution(uuid, text, jsonb, text) to authenticated;

create or replace function public.create_automation_audit_event(
  p_organization_id uuid,
  p_action text,
  p_automation_id text,
  p_metadata jsonb default '{}'::jsonb
)
returns public.audit_log
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_user_id uuid;
  v_action text;
  v_automation_id text;
  v_metadata jsonb;
  v_row public.audit_log;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  if p_organization_id is null then
    raise exception 'organization_id is required';
  end if;

  if not public.is_org_admin(p_organization_id) then
    raise exception 'Not authorized';
  end if;

  -- Phase D adds the two manual-run/dry-run actions to the same, still
  -- explicit allowlist Phase C.1 established - never a generic/arbitrary
  -- action string.
  v_action := nullif(trim(p_action), '');
  if v_action is null or v_action not in (
    'automation_enabled',
    'automation_disabled',
    'automation_manual_run_requested',
    'automation_dry_run_requested'
  ) then
    raise exception 'Unsupported audit action';
  end if;

  v_automation_id := nullif(trim(p_automation_id), '');
  if v_automation_id is null then
    raise exception 'automation_id is required';
  end if;

  v_metadata := coalesce(p_metadata, '{}'::jsonb);
  if jsonb_typeof(v_metadata) is distinct from 'object' then
    raise exception 'metadata must be a JSON object';
  end if;

  insert into public.audit_log (
    organization_id, user_id, action, entity_type, entity_id, automation_id, metadata
  ) values (
    p_organization_id, v_user_id, v_action, 'automation', null, v_automation_id, v_metadata
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.create_automation_audit_event(uuid, text, text, jsonb) from public;
revoke all on function public.create_automation_audit_event(uuid, text, text, jsonb) from anon;
grant execute on function public.create_automation_audit_event(uuid, text, text, jsonb) to authenticated;

-- Rollback for start_workflow_execution_atomic_claim.sql (P0-B B0).
-- Restores the exact previous body (supabase/migrations/20260921160000_
-- payment_gate_rpc_enforcement.sql; identical to TEST's deployed definition
-- before B0), including its read-then-unconditional-update race. No DROP.

create or replace function public.start_workflow_execution(p_automation_event_id uuid, p_workflow_name text, p_metadata jsonb, p_trigger_source text default 'event'::text)
returns workflow_executions
language plpgsql
security definer
set search_path to 'public'
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

  if not v_is_service_role and not public.organization_payment_active(v_org_id) then
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

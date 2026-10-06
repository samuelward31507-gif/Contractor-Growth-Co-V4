-- P0-B B0: start_workflow_execution claims its event atomically.
--
-- STATUS: PENDING for Production - applied to TEST only. See
-- supabase/pending/README.md.
--
-- The previous body (supabase/migrations/20260921160000_payment_gate_rpc_
-- enforcement.sql) read the event's status, checked it was not
-- processing/completed, and then set it to 'processing' with an
-- UNCONDITIONAL update. Two concurrent callers for the same event (for
-- example a staff retry and the automatic A2 retry) could both read
-- 'failed', both pass the check and both insert a 'running' execution - two
-- live attempts of one event, each able to send. The messages unique index
-- only allows one outbound per EXECUTION, so it does not stop that.
--
-- Now the claim is the single conditional UPDATE ... WHERE status NOT IN
-- ('processing', 'completed'): under concurrency the second caller blocks on
-- the row lock, re-evaluates the WHERE against the winner's committed row,
-- matches nothing and raises the same "already being processed" error the
-- pre-check raises. The attempt number is computed after the claim, while
-- the event row is locked.
--
-- Everything else is unchanged: signature, SECURITY DEFINER, search_path,
-- authorization (service role / member + payment active), validation,
-- error messages, attempt numbering, trigger_source, returned row, grants
-- (CREATE OR REPLACE keeps them). No DROP (the MCP SQL tools hang on it).
--
-- Idempotent. Rollback: start_workflow_execution_atomic_claim_rollback.sql.

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

  -- The atomic claim: only one caller can move this event into 'processing'.
  update public.automation_events
  set status = 'processing'
  where id = p_automation_event_id
    and status not in ('processing', 'completed');

  if not found then
    select ae.status into v_event_status
    from public.automation_events ae
    where ae.id = p_automation_event_id;
    if v_event_status = 'completed' then
      raise exception 'Automation event has already completed';
    end if;
    raise exception 'Automation event is already being processed';
  end if;

  select coalesce(max(we.attempt), 0) + 1 into v_next_attempt
  from public.workflow_executions we
  where we.automation_event_id = p_automation_event_id;

  insert into public.workflow_executions (
    organization_id, automation_event_id, workflow_name, status, attempt, started_at, metadata, trigger_source
  ) values (
    v_org_id, p_automation_event_id, v_workflow_name, 'running', v_next_attempt, now(), v_metadata, v_trigger_source
  )
  returning * into v_execution;

  return v_execution;
end;
$$;

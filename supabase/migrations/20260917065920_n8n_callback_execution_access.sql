-- Allows the n8n callback route to complete/fail a workflow execution.
--
-- complete_workflow_execution and fail_workflow_execution were built for
-- authenticated end-user sessions only: both raise 'Not authenticated' when
-- auth.uid() is null. That's correct for every caller so far (a contractor's
-- own browser/server-action session), but the n8n callback
-- (app/api/automation/n8n-callback) is a server-to-server webhook receiver -
-- n8n never logs in as a Trackpr user, so it can never present an auth.uid().
-- It is instead authenticated by a shared secret (N8N_WEBHOOK_SECRET),
-- verified by the route handler itself before it ever touches the database,
-- and it connects to Supabase using the service-role key specifically
-- because there is no user session for RLS or auth.uid() to check.
--
-- Rather than bypassing these RPCs (which would mean re-implementing their
-- status-transition guards and duplicate-prevention logic a second time,
-- directly against the tables, via service role - exactly the "second
-- execution/state system" this project's rules forbid), this migration
-- broadens each function's auth check to also accept the service_role
-- Postgres role as a legitimate caller, alongside the existing
-- authenticated-user path. auth.role() reflects which literal API
-- key/connection Supabase/PostgREST used to open the session - it is never
-- something a request body or client-supplied parameter can influence - so
-- this does not weaken the check, it recognizes a second real caller
-- identity. Organization/event/execution relationship validation for that
-- caller is performed explicitly by the callback route itself (which never
-- trusts organization_id supplied by n8n) before either RPC is called; the
-- RPC's own org-derivation-from-the-row logic is unchanged.
--
-- No table, column, or RLS policy is touched. start_workflow_execution is
-- intentionally left untouched - it is only ever called from an
-- authenticated contractor session (createLead), never from this callback.
--
-- Both functions below also close a pre-existing race in the original
-- Automation Core migration: the status guard was a separate SELECT-then-IF
-- check, not part of the UPDATE's own WHERE clause, so two concurrent calls
-- for the same execution (a realistic scenario for a webhook callback,
-- which may be retried or redelivered) could both read status='running'
-- before either commits and both proceed to mutate it - a lost update, and
-- in the callback's case, a risk of double-processing (e.g. two SMS
-- attempts). The UPDATE now carries `and status = 'running'` itself and
-- checks FOUND, making the transition atomic: only one concurrent caller can
-- ever win it, and the loser reliably sees 'Execution is not running'
-- instead of silently overwriting the winner's result.

create or replace function public.complete_workflow_execution(
  p_execution_id uuid,
  p_metadata jsonb
)
returns public.workflow_executions
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_org_id uuid;
  v_event_id uuid;
  v_execution public.workflow_executions;
  v_is_service_role boolean;
begin
  v_is_service_role := (auth.role() = 'service_role');

  if auth.uid() is null and not v_is_service_role then
    raise exception 'Not authenticated';
  end if;

  select we.organization_id, we.automation_event_id
  into v_org_id, v_event_id
  from public.workflow_executions we
  where we.id = p_execution_id;

  if v_org_id is null then
    raise exception 'Execution not found';
  end if;

  if not v_is_service_role and not public.is_org_member(v_org_id) then
    raise exception 'Execution not found';
  end if;

  update public.workflow_executions
  set status = 'completed',
      completed_at = now(),
      metadata = coalesce(p_metadata, metadata)
  where id = p_execution_id and status = 'running'
  returning * into v_execution;

  if not found then
    raise exception 'Execution is not running';
  end if;

  update public.automation_events
  set status = 'completed',
      processed_at = now()
  where id = v_event_id and status = 'processing';

  return v_execution;
end;
$$;

create or replace function public.fail_workflow_execution(
  p_execution_id uuid,
  p_error_message text
)
returns public.workflow_executions
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_org_id uuid;
  v_event_id uuid;
  v_error text;
  v_execution public.workflow_executions;
  v_is_service_role boolean;
begin
  v_is_service_role := (auth.role() = 'service_role');

  if auth.uid() is null and not v_is_service_role then
    raise exception 'Not authenticated';
  end if;

  select we.organization_id, we.automation_event_id
  into v_org_id, v_event_id
  from public.workflow_executions we
  where we.id = p_execution_id;

  if v_org_id is null then
    raise exception 'Execution not found';
  end if;

  if not v_is_service_role and not public.is_org_member(v_org_id) then
    raise exception 'Execution not found';
  end if;

  v_error := left(nullif(trim(p_error_message), ''), 2000);

  update public.workflow_executions
  set status = 'failed',
      completed_at = now(),
      error_message = v_error
  where id = p_execution_id and status = 'running'
  returning * into v_execution;

  if not found then
    raise exception 'Execution is not running';
  end if;

  update public.automation_events
  set status = 'failed',
      error_message = v_error
  where id = v_event_id and status = 'processing';

  return v_execution;
end;
$$;

-- Grants are unchanged (authenticated only) - service_role always bypasses
-- GRANT/REVOKE and RLS by design, so no new grant is needed for it to call
-- these functions once the auth check above permits it.

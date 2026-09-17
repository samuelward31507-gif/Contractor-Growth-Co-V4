-- Automation Core Phase 1 foundation.
--
-- automation_events/workflow_executions, like organizations before them, have
-- no client-facing INSERT/UPDATE policy - RLS only grants SELECT
-- (is_org_member(organization_id)). Writes must be idempotent and
-- organization-scoped in a single atomic operation, which a plain policy
-- can't express, so all writes go through SECURITY DEFINER RPCs below that
-- resolve the organization from auth.uid() (or from the row being acted on,
-- re-checked against auth.uid()) and never accept a client-supplied
-- organization_id, user_id, or role/status override.
--
-- The requested pending -> processing -> completed / processing -> failed ->
-- retry -> processing lifecycle is represented without a 5th status value:
-- automation_events.status keeps its existing four-value CHECK constraint
-- (pending/processing/completed/failed). "Retry" is the act of re-entering
-- processing from failed - tracked by workflow_executions.attempt
-- incrementing - rather than a persisted status, so no constraint change is
-- needed.

-- 1. Schema additions -------------------------------------------------------

alter table public.automation_events
  add column updated_at timestamptz not null default now(),
  add column idempotency_key text;

create trigger automation_events_updated_at
  before update on public.automation_events
  for each row execute function public.set_updated_at();

-- Organization-scoped idempotency: two different orgs may reuse the same
-- key, but the same org can never create two events with the same key. NULL
-- keys (events that don't need idempotency) are excluded from the
-- constraint entirely via the partial index.
create unique index automation_events_org_idempotency_key
  on public.automation_events (organization_id, idempotency_key)
  where idempotency_key is not null;

-- 2. create_automation_event -------------------------------------------------
--
-- The only sanctioned way to insert an automation_events row. Resolves the
-- organization from the caller's own membership (auth.uid()), validates
-- event_type/entity_type/payload shape, and enforces idempotency at the
-- database level via the unique index above (INSERT ... ON CONFLICT DO
-- NOTHING, then fetch the pre-existing row on conflict) rather than an
-- application-level check-then-insert race.
create or replace function public.create_automation_event(
  p_event_type text,
  p_entity_type text,
  p_entity_id uuid,
  p_payload jsonb,
  p_idempotency_key text
)
returns table (
  id uuid,
  organization_id uuid,
  event_type text,
  entity_type text,
  entity_id uuid,
  status text,
  payload jsonb,
  error_message text,
  processed_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  is_duplicate boolean
)
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_user_id uuid;
  v_org_id uuid;
  v_event_type text;
  v_entity_type text;
  v_payload jsonb;
  v_idempotency_key text;
  v_new_id uuid;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  select om.organization_id into v_org_id
  from public.organization_members om
  where om.user_id = v_user_id
  limit 1;

  if v_org_id is null then
    raise exception 'No organization membership found for user';
  end if;

  v_event_type := lower(trim(p_event_type));
  if v_event_type is null or v_event_type = '' or v_event_type !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' then
    raise exception 'Invalid event_type: expected lowercase dot-namespaced form, e.g. lead.created';
  end if;

  v_entity_type := nullif(lower(trim(p_entity_type)), '');
  if v_entity_type is not null and v_entity_type !~ '^[a-z][a-z0-9_]*$' then
    raise exception 'Invalid entity_type';
  end if;

  v_payload := coalesce(p_payload, '{}'::jsonb);
  if jsonb_typeof(v_payload) is distinct from 'object' then
    raise exception 'payload must be a JSON object';
  end if;

  v_idempotency_key := nullif(trim(p_idempotency_key), '');
  if v_idempotency_key is not null and length(v_idempotency_key) > 200 then
    raise exception 'idempotency_key is too long';
  end if;

  if v_idempotency_key is not null then
    insert into public.automation_events as ae (
      organization_id, event_type, entity_type, entity_id, payload, idempotency_key
    ) values (
      v_org_id, v_event_type, v_entity_type, p_entity_id, v_payload, v_idempotency_key
    )
    on conflict (organization_id, idempotency_key) where idempotency_key is not null
    do nothing
    returning ae.id into v_new_id;

    if v_new_id is null then
      -- Someone already created an event with this key for this org - this
      -- is the expected, safe outcome of a retried request or replayed
      -- webhook, not an error. Return the existing row so the caller can
      -- treat it exactly like the event it meant to create.
      return query
      select ae.id, ae.organization_id, ae.event_type, ae.entity_type, ae.entity_id,
             ae.status, ae.payload, ae.error_message, ae.processed_at, ae.created_at, ae.updated_at,
             true as is_duplicate
      from public.automation_events ae
      where ae.organization_id = v_org_id and ae.idempotency_key = v_idempotency_key;
      return;
    end if;
  else
    insert into public.automation_events as ae (
      organization_id, event_type, entity_type, entity_id, payload, idempotency_key
    ) values (
      v_org_id, v_event_type, v_entity_type, p_entity_id, v_payload, null
    )
    returning ae.id into v_new_id;
  end if;

  return query
  select ae.id, ae.organization_id, ae.event_type, ae.entity_type, ae.entity_id,
         ae.status, ae.payload, ae.error_message, ae.processed_at, ae.created_at, ae.updated_at,
         false as is_duplicate
  from public.automation_events ae
  where ae.id = v_new_id;
end;
$$;

revoke all on function public.create_automation_event(text, text, uuid, jsonb, text) from public;
revoke all on function public.create_automation_event(text, text, uuid, jsonb, text) from anon;
grant execute on function public.create_automation_event(text, text, uuid, jsonb, text) to authenticated;

-- 3. Workflow execution lifecycle -------------------------------------------
--
-- Each function re-derives the organization from the row being acted on
-- (never from a client-supplied organization_id) and checks it against the
-- caller's own membership via the existing is_org_member() helper, exactly
-- as RLS would, since SECURITY DEFINER bypasses RLS and must re-apply that
-- check explicitly. A row that exists in another org and a row that doesn't
-- exist at all return the same generic error, so the function can't be used
-- to enumerate other organizations' automation event/execution ids.

-- start_workflow_execution: also the retry entrypoint. Moves the parent
-- automation_event from pending/failed into processing (rejecting a start
-- while it's already processing, which prevents duplicate concurrent work
-- on the same event) and derives the next attempt number from the existing
-- workflow_executions rows for that event rather than trusting a
-- client-supplied attempt number.
create or replace function public.start_workflow_execution(
  p_automation_event_id uuid,
  p_workflow_name text,
  p_metadata jsonb
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
  v_next_attempt int;
  v_execution public.workflow_executions;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select ae.organization_id, ae.status into v_org_id, v_event_status
  from public.automation_events ae
  where ae.id = p_automation_event_id;

  if v_org_id is null or not public.is_org_member(v_org_id) then
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

  select coalesce(max(we.attempt), 0) + 1 into v_next_attempt
  from public.workflow_executions we
  where we.automation_event_id = p_automation_event_id;

  update public.automation_events
  set status = 'processing'
  where id = p_automation_event_id;

  insert into public.workflow_executions (
    organization_id, automation_event_id, workflow_name, status, attempt, started_at, metadata
  ) values (
    v_org_id, p_automation_event_id, v_workflow_name, 'running', v_next_attempt, now(), v_metadata
  )
  returning * into v_execution;

  return v_execution;
end;
$$;

revoke all on function public.start_workflow_execution(uuid, text, jsonb) from public;
revoke all on function public.start_workflow_execution(uuid, text, jsonb) from anon;
grant execute on function public.start_workflow_execution(uuid, text, jsonb) to authenticated;

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
  v_status text;
  v_event_id uuid;
  v_execution public.workflow_executions;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select we.organization_id, we.status, we.automation_event_id
  into v_org_id, v_status, v_event_id
  from public.workflow_executions we
  where we.id = p_execution_id;

  if v_org_id is null or not public.is_org_member(v_org_id) then
    raise exception 'Execution not found';
  end if;

  if v_status <> 'running' then
    raise exception 'Execution is not running';
  end if;

  update public.workflow_executions
  set status = 'completed',
      completed_at = now(),
      metadata = coalesce(p_metadata, metadata)
  where id = p_execution_id
  returning * into v_execution;

  update public.automation_events
  set status = 'completed',
      processed_at = now()
  where id = v_event_id and status = 'processing';

  return v_execution;
end;
$$;

revoke all on function public.complete_workflow_execution(uuid, jsonb) from public;
revoke all on function public.complete_workflow_execution(uuid, jsonb) from anon;
grant execute on function public.complete_workflow_execution(uuid, jsonb) to authenticated;

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
  v_status text;
  v_event_id uuid;
  v_error text;
  v_execution public.workflow_executions;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select we.organization_id, we.status, we.automation_event_id
  into v_org_id, v_status, v_event_id
  from public.workflow_executions we
  where we.id = p_execution_id;

  if v_org_id is null or not public.is_org_member(v_org_id) then
    raise exception 'Execution not found';
  end if;

  if v_status <> 'running' then
    raise exception 'Execution is not running';
  end if;

  v_error := left(nullif(trim(p_error_message), ''), 2000);

  update public.workflow_executions
  set status = 'failed',
      completed_at = now(),
      error_message = v_error
  where id = p_execution_id
  returning * into v_execution;

  update public.automation_events
  set status = 'failed',
      error_message = v_error
  where id = v_event_id and status = 'processing';

  return v_execution;
end;
$$;

revoke all on function public.fail_workflow_execution(uuid, text) from public;
revoke all on function public.fail_workflow_execution(uuid, text) from anon;
grant execute on function public.fail_workflow_execution(uuid, text) to authenticated;

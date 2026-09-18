-- Phase 4.2: Inbound Customer Reply -> AI Qualification & Conversation.
--
-- The inbound SMS webhook (app/api/webhooks/sms/inbound) has no Supabase
-- Auth session - Twilio authenticates it via HMAC signature, not a user JWT
-- - so it connects with the service-role client, exactly like the n8n
-- callback route already does. create_automation_event and
-- start_workflow_execution were built for authenticated end-user sessions
-- only (createLead's call chain) and both raise on a null auth.uid().
--
-- Rather than re-implementing event/execution creation a second time
-- directly against the tables from the webhook (a duplicate, divergent
-- state-transition system - exactly what this project's rules forbid), this
-- migration extends both RPCs to also accept the service_role Postgres role
-- as a legitimate caller, the same pattern the n8n_callback_execution_access
-- migration already established for complete_workflow_execution and
-- fail_workflow_execution. auth.role() reflects which literal API key
-- opened the connection - never something a request body or client-supplied
-- parameter can influence - so this recognizes a second real caller
-- identity rather than weakening the check.
--
-- create_automation_event gains one new, optional, default-null parameter:
-- p_organization_id. It is used, and required, only for the service_role
-- path - a service-role caller has no auth.uid()/organization_members row
-- to derive an org from, so it must supply the org id it already resolved
-- itself (the inbound webhook derives it from organizations.sms_phone_number
-- before ever calling this). The existing authenticated-user path is
-- completely unchanged: it still derives org from auth.uid() and ignores
-- this parameter entirely, so every existing 5-argument call site keeps
-- working with no code change.
--
-- start_workflow_execution needs no new parameter: it already derives the
-- organization from the automation_events row itself (set correctly by
-- create_automation_event above), so only its is_org_member() authorization
-- check needs the same service_role bypass.
--
-- No table, column, RLS policy, or grant is touched - service_role always
-- bypasses RLS and GRANT/REVOKE by design.

create or replace function public.create_automation_event(
  p_event_type text,
  p_entity_type text,
  p_entity_id uuid,
  p_payload jsonb,
  p_idempotency_key text,
  p_organization_id uuid default null
)
returns table(
  id uuid,
  organization_id uuid,
  event_type text,
  entity_type text,
  entity_id uuid,
  status text,
  payload jsonb,
  error_message text,
  processed_at timestamp with time zone,
  created_at timestamp with time zone,
  updated_at timestamp with time zone,
  is_duplicate boolean
)
language plpgsql
security definer
set search_path to 'public'
as $function$
#variable_conflict use_column
declare
  v_user_id uuid;
  v_org_id uuid;
  v_is_service_role boolean;
  v_event_type text;
  v_entity_type text;
  v_payload jsonb;
  v_idempotency_key text;
  v_new_id uuid;
begin
  v_is_service_role := (auth.role() = 'service_role');

  if v_is_service_role then
    if p_organization_id is null then
      raise exception 'organization_id is required for service-role calls';
    end if;
    v_org_id := p_organization_id;
  else
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
$function$;

-- CREATE OR REPLACE cannot "replace" a function whose parameter list grew a
-- new type in its signature - Postgres treats the 6-argument version above
-- as a distinct overload of the 5-argument original, not a replacement of
-- it, even though the 6th parameter has a default. Left alone, PostgREST
-- (and therefore every existing 5-argument call site, i.e. the unchanged
-- authenticated-user lead.created path) becomes ambiguous between the two
-- overloads and starts failing with PGRST203 "Could not choose the best
-- candidate function". This drop removes the now-stale original overload so
-- only the 6-argument version remains - callable with either 5 or 6 named
-- arguments via its default, exactly as originally intended.
drop function if exists public.create_automation_event(text, text, uuid, jsonb, text);

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

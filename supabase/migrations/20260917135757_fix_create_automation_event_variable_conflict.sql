-- Fixes a PL/pgSQL naming collision in create_automation_event: the function's
-- RETURNS TABLE implicitly declares organization_id (among others) as a local
-- variable, which collided with the organization_id column referenced
-- unqualified in the INSERT target list and ON CONFLICT (organization_id, ...)
-- clause, causing every call to fail with "column reference \"organization_id\"
-- is ambiguous" (confirmed in postgres_logs for every prior lead.created test
-- in this project). Adding #variable_conflict use_column tells the parser to
-- prefer the table column over the same-named OUT parameter in this function.
-- No other logic, signature, or return shape changes.

create or replace function public.create_automation_event(
  p_event_type text,
  p_entity_type text,
  p_entity_id uuid,
  p_payload jsonb,
  p_idempotency_key text
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
$function$;

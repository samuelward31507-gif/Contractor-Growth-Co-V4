-- Payment Gate V1, part 3: close the SECURITY DEFINER RPC bypass.
--
-- 20260921150000_payment_gate_rls_enforcement.sql closed direct table
-- access (PostgREST/session-client reads and writes) to 20 gated tables.
-- A follow-up static audit (see the accompanying report) found 12
-- authenticated-user-callable SECURITY DEFINER functions that read/write
-- those same gated tables from inside their own function body - since
-- SECURITY DEFINER functions bypass RLS by design (the same mechanism
-- organization_payment_active() itself relies on), none of the 20 new
-- restrictive policies constrain what these functions do internally. Every
-- one of the 12 already had its own authorization check (is_org_member/
-- is_org_admin, or a service_role branch) before this migration - none of
-- that is touched here. This migration adds exactly one additional guard
-- per function: after the existing authorization check succeeds, and only
-- for the authenticated (non-service_role) path where one exists, require
-- organization_payment_active(<the same org id the function already
-- authorized against>). It reuses the exact helper introduced in
-- 20260921150000, rather than re-implementing the payment check - the
-- only new logic added by this migration is a single organization_payment_active()
-- call per function, positioned after the existing checks. No existing
-- line of authorization logic in any of the 12 functions is modified,
-- removed, or reordered relative to itself.
--
-- ORG ID RESOLUTION AND SERVICE-ROLE PRESERVATION, PER FUNCTION:
--
--   merge_contacts(p_organization_id, ...): org id is the caller-supplied
--   p_organization_id, already authoritative only because it's gated by
--   is_org_admin(p_organization_id) first. No service_role branch exists -
--   this function always requires auth.uid(). Guard added unconditionally
--   after the existing is_org_admin check.
--
--   acknowledge_automation_incident(p_incident_id) /
--   resolve_automation_incident(p_incident_id): org id is resolved from the
--   automation_incidents row itself (select organization_id ... where id =
--   p_incident_id), never client-supplied. No service_role branch - always
--   requires auth.uid(). Guard added unconditionally after the existing
--   is_org_admin check.
--
--   resolve_automation_incidents_by_fingerprint(p_organization_id, ...) /
--   record_automation_incident_signal(p_organization_id, ...): both have a
--   real service_role branch (v_is_service_role), used by the automation
--   health/incident pipeline running under lib/supabase/service.ts. The
--   guard is added ONLY inside the existing `if not v_is_service_role`
--   block, after the existing is_org_member(p_organization_id) check -
--   service_role calls are completely untouched.
--
--   create_automation_event(...): service_role branch requires and trusts
--   p_organization_id directly (the public lead-capture endpoint and other
--   server-only dispatch paths call it this way). The authenticated-user
--   branch never trusts p_organization_id at all - it resolves v_org_id
--   from the caller's own organization_members row. The guard is added
--   ONLY in the authenticated-user branch, after v_org_id is resolved and
--   confirmed non-null, using that server-resolved v_org_id.
--
--   start_workflow_execution(p_automation_event_id, ...) /
--   complete_workflow_execution(p_execution_id, ...) /
--   fail_workflow_execution(p_execution_id, ...): org id is resolved from
--   the automation_events/workflow_executions row itself, never client-
--   supplied. Each already has a service_role branch (this is the same
--   dispatch/callback machinery n8n and the automation engine drive via
--   service_role). The guard is added ONLY inside each function's existing
--   `if not v_is_service_role and not is_org_member(...)` gate, as an
--   additional `if not v_is_service_role and not organization_payment_active(...)`
--   check placed immediately after it - service_role calls are completely
--   untouched.
--
--   create_automation_audit_event(p_organization_id, ...) /
--   create_organization_audit_event(p_organization_id, ...): org id is the
--   caller-supplied p_organization_id, authoritative only because it's
--   gated by is_org_admin(p_organization_id) first. No service_role
--   branch. Guard added unconditionally after the existing is_org_admin
--   check.
--
--   create_review_referral_audit_event(p_organization_id, ...): org id is
--   the caller-supplied p_organization_id, authoritative only because it's
--   gated by is_org_member(p_organization_id) first. No service_role
--   branch. Guard added unconditionally after the existing is_org_member
--   check.
--
-- RECURSION: organization_payment_active() (from 20260921150000) only
-- queries public.organizations by primary key and is itself SECURITY
-- DEFINER - calling it from inside another SECURITY DEFINER function
-- introduces no new recursion risk than the is_org_member()/is_org_admin()
-- calls these same 12 functions already make.
--
-- FAIL-CLOSED: organization_payment_active() returns false (not true, not
-- null) for a null or nonexistent org id, so every new guard below fails
-- closed exactly like the existing is_org_member()/is_org_admin() checks
-- already do.
--
-- NOT CHANGED BY THIS MIGRATION: resolve_stale_stuck_incidents() (hard-
-- requires auth.role() = 'service_role', not authenticated-user-callable
-- at all) and is_org_member()/is_org_admin()/is_agency_admin()/
-- bootstrap_organization()/guard_organizations_payment_status() (none read
-- or write a gated table).

create or replace function public.merge_contacts(p_organization_id uuid, p_source_contact_id uuid, p_target_contact_id uuid, p_reason text default null::text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user_id uuid;
  v_source record;
  v_target record;
  v_counts jsonb := '{}'::jsonb;
  v_n int;
  v_source_open_conv record;
  v_target_has_open boolean;
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

  if not public.organization_payment_active(p_organization_id) then
    raise exception 'Organization payment is not active';
  end if;

  if p_source_contact_id is null or p_target_contact_id is null then
    raise exception 'source and target contact ids are required';
  end if;

  if p_source_contact_id = p_target_contact_id then
    raise exception 'Cannot merge a contact into itself';
  end if;

  select * into v_source from public.contacts
    where id = p_source_contact_id and organization_id = p_organization_id
    for update;
  if not found then
    raise exception 'Source contact not found in this organization';
  end if;

  select * into v_target from public.contacts
    where id = p_target_contact_id and organization_id = p_organization_id
    for update;
  if not found then
    raise exception 'Target contact not found in this organization';
  end if;

  if v_source.merged_into_id is not null then
    raise exception 'Source contact has already been merged';
  end if;
  if v_target.merged_into_id is not null then
    raise exception 'Target contact has already been merged - merge into its current survivor instead';
  end if;

  update public.contacts set
    merged_into_id = p_target_contact_id,
    merged_at = now()
  where id = p_source_contact_id;

  update public.contacts set
    first_name = coalesce(nullif(trim(v_target.first_name), ''), v_source.first_name),
    last_name = coalesce(nullif(trim(v_target.last_name), ''), v_source.last_name),
    company_name = coalesce(nullif(trim(v_target.company_name), ''), v_source.company_name),
    notes = coalesce(nullif(trim(v_target.notes), ''), v_source.notes),
    phone = case when v_target.phone is not null and trim(v_target.phone) <> '' then v_target.phone else v_source.phone end,
    phone_normalized = case when v_target.phone is not null and trim(v_target.phone) <> '' then v_target.phone_normalized else v_source.phone_normalized end,
    email = case when v_target.email is not null and trim(v_target.email) <> '' then v_target.email else v_source.email end,
    email_normalized = case when v_target.email is not null and trim(v_target.email) <> '' then v_target.email_normalized else v_source.email_normalized end
  where id = p_target_contact_id;

  update public.ai_interactions set contact_id = p_target_contact_id where contact_id = p_source_contact_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('ai_interactions', v_n);

  update public.appointments set contact_id = p_target_contact_id where contact_id = p_source_contact_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('appointments', v_n);

  update public.estimates set contact_id = p_target_contact_id where contact_id = p_source_contact_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('estimates', v_n);

  update public.jobs set contact_id = p_target_contact_id where contact_id = p_source_contact_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('jobs', v_n);

  update public.leads set contact_id = p_target_contact_id where contact_id = p_source_contact_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('leads', v_n);

  update public.referral_requests set contact_id = p_target_contact_id where contact_id = p_source_contact_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('referral_requests', v_n);

  update public.review_requests set contact_id = p_target_contact_id where contact_id = p_source_contact_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('review_requests', v_n);

  for v_source_open_conv in
    select id, channel from public.conversations
    where contact_id = p_source_contact_id and status = 'open'
  loop
    select exists (
      select 1 from public.conversations
      where contact_id = p_target_contact_id
        and channel = v_source_open_conv.channel
        and status = 'open'
    ) into v_target_has_open;

    if v_target_has_open then
      update public.conversations set status = 'closed' where id = v_source_open_conv.id;
    end if;
  end loop;

  update public.conversations set contact_id = p_target_contact_id where contact_id = p_source_contact_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('conversations', v_n);

  insert into public.audit_log (
    organization_id, user_id, action, entity_type, entity_id, automation_id, metadata
  ) values (
    p_organization_id, v_user_id, 'contact_merged', 'contact', p_target_contact_id, null,
    jsonb_build_object(
      'source_contact_id', p_source_contact_id,
      'target_contact_id', p_target_contact_id,
      'reason', p_reason,
      'reassigned_counts', v_counts
    )
  );

  return jsonb_build_object(
    'ok', true,
    'source_contact_id', p_source_contact_id,
    'target_contact_id', p_target_contact_id,
    'reassigned_counts', v_counts
  );
end;
$$;

create or replace function public.acknowledge_automation_incident(p_incident_id uuid)
returns automation_incidents
language plpgsql
security definer
set search_path to 'public'
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

  if not public.organization_payment_active(v_org_id) then
    raise exception 'Organization payment is not active';
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

create or replace function public.resolve_automation_incident(p_incident_id uuid)
returns automation_incidents
language plpgsql
security definer
set search_path to 'public'
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

  if not public.organization_payment_active(v_org_id) then
    raise exception 'Organization payment is not active';
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

create or replace function public.resolve_automation_incidents_by_fingerprint(p_organization_id uuid, p_fingerprints text[])
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_is_service_role boolean;
  v_count integer;
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
    if not public.organization_payment_active(p_organization_id) then
      raise exception 'Organization payment is not active';
    end if;
  end if;

  if p_fingerprints is null or array_length(p_fingerprints, 1) is null then
    return 0;
  end if;

  update public.automation_incidents
  set status = 'resolved', resolved_at = now(), updated_at = now()
  where organization_id = p_organization_id
    and fingerprint = any(p_fingerprints)
    and status in ('open', 'acknowledged');

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.record_automation_incident_signal(p_organization_id uuid, p_category text, p_severity text, p_fingerprint text, p_title text, p_description text default null::text, p_automation_id text default null::text, p_workflow_execution_id uuid default null::uuid, p_metadata jsonb default '{}'::jsonb)
returns automation_incidents
language plpgsql
security definer
set search_path to 'public'
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
    if not public.organization_payment_active(p_organization_id) then
      raise exception 'Organization payment is not active';
    end if;
  end if;

  v_category := nullif(trim(p_category), '');
  if v_category is null or v_category not in (
    'workflow_failed', 'workflow_stuck',
    'n8n_dispatch_failed', 'n8n_callback_failed',
    'sms_send_failed', 'sms_delivery_failed'
  ) then
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

create or replace function public.create_automation_event(p_event_type text, p_entity_type text, p_entity_id uuid, p_payload jsonb, p_idempotency_key text, p_organization_id uuid default null::uuid)
returns table(id uuid, organization_id uuid, event_type text, entity_type text, entity_id uuid, status text, payload jsonb, error_message text, processed_at timestamp with time zone, created_at timestamp with time zone, updated_at timestamp with time zone, is_duplicate boolean)
language plpgsql
security definer
set search_path to 'public'
as $$
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

    select om.organization_id
    into v_org_id
    from public.organization_members om
    where om.user_id = v_user_id
    limit 1;

    if v_org_id is null then
      raise exception 'No organization membership found for user';
    end if;

    if not public.organization_payment_active(v_org_id) then
      raise exception 'Organization payment is not active';
    end if;
  end if;

  v_event_type := lower(trim(p_event_type));

  if v_event_type is null
     or v_event_type = ''
     or v_event_type !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' then
    raise exception 'Invalid event_type: expected lowercase dot-namespaced form, e.g. lead.created';
  end if;

  v_entity_type := nullif(lower(trim(p_entity_type)), '');

  if v_entity_type is not null
     and v_entity_type !~ '^[a-z][a-z0-9_]*$' then
    raise exception 'Invalid entity_type';
  end if;

  v_payload := coalesce(p_payload, '{}'::jsonb);

  if jsonb_typeof(v_payload) is distinct from 'object' then
    raise exception 'payload must be a JSON object';
  end if;

  v_idempotency_key := nullif(trim(p_idempotency_key), '');

  if v_idempotency_key is not null
     and length(v_idempotency_key) > 200 then
    raise exception 'idempotency_key is too long';
  end if;

  if v_idempotency_key is not null then

    insert into public.automation_events as ae (
      organization_id,
      event_type,
      entity_type,
      entity_id,
      payload,
      idempotency_key
    )
    values (
      v_org_id,
      v_event_type,
      v_entity_type,
      p_entity_id,
      v_payload,
      v_idempotency_key
    )
    on conflict (organization_id, idempotency_key)
      where idempotency_key is not null
    do nothing
    returning ae.id into v_new_id;

    if v_new_id is null then

      return query
      select
        ae.id,
        ae.organization_id,
        ae.event_type,
        ae.entity_type,
        ae.entity_id,
        ae.status,
        ae.payload,
        ae.error_message,
        ae.processed_at,
        ae.created_at,
        ae.updated_at,
        true as is_duplicate
      from public.automation_events ae
      where ae.organization_id = v_org_id
        and ae.idempotency_key = v_idempotency_key;

      return;
    end if;

  else

    insert into public.automation_events as ae (
      organization_id,
      event_type,
      entity_type,
      entity_id,
      payload,
      idempotency_key
    )
    values (
      v_org_id,
      v_event_type,
      v_entity_type,
      p_entity_id,
      v_payload,
      null
    )
    returning ae.id into v_new_id;

  end if;

  return query
  select
    ae.id,
    ae.organization_id,
    ae.event_type,
    ae.entity_type,
    ae.entity_id,
    ae.status,
    ae.payload,
    ae.error_message,
    ae.processed_at,
    ae.created_at,
    ae.updated_at,
    false as is_duplicate
  from public.automation_events ae
  where ae.id = v_new_id;

end;
$$;

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

create or replace function public.complete_workflow_execution(p_execution_id uuid, p_metadata jsonb)
returns workflow_executions
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_execution public.workflow_executions;
  v_is_service_role boolean;
begin
  v_is_service_role := (auth.role() = 'service_role');

  if auth.uid() is null and not v_is_service_role then
    raise exception 'Not authenticated';
  end if;

  select *
  into v_execution
  from public.workflow_executions
  where id = p_execution_id;

  if not found then
    raise exception 'Execution not found';
  end if;

  if not v_is_service_role
     and not public.is_org_member(v_execution.organization_id) then
    raise exception 'Not authorized';
  end if;

  if not v_is_service_role
     and not public.organization_payment_active(v_execution.organization_id) then
    raise exception 'Organization payment is not active';
  end if;

  update public.workflow_executions
  set
    status = 'completed',
    completed_at = now(),
    metadata = coalesce(p_metadata, metadata)
  where id = p_execution_id
    and status = 'running'
  returning *
  into v_execution;

  if not found then
    raise exception 'Execution is not running';
  end if;

  update public.automation_events
  set
    status = 'completed',
    processed_at = now(),
    updated_at = now()
  where id = v_execution.automation_event_id
    and status = 'processing';

  return v_execution;
end;
$$;

create or replace function public.fail_workflow_execution(p_execution_id uuid, p_error_message text)
returns workflow_executions
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_execution public.workflow_executions;
  v_is_service_role boolean;
begin
  v_is_service_role := (auth.role() = 'service_role');

  if auth.uid() is null and not v_is_service_role then
    raise exception 'Not authenticated';
  end if;

  select *
  into v_execution
  from public.workflow_executions
  where id = p_execution_id;

  if not found then
    raise exception 'Execution not found';
  end if;

  if not v_is_service_role
     and not public.is_org_member(v_execution.organization_id) then
    raise exception 'Not authorized';
  end if;

  if not v_is_service_role
     and not public.organization_payment_active(v_execution.organization_id) then
    raise exception 'Organization payment is not active';
  end if;

  update public.workflow_executions
  set
    status = 'failed',
    completed_at = now(),
    error_message = p_error_message
  where id = p_execution_id
    and status = 'running'
  returning *
  into v_execution;

  if not found then
    raise exception 'Execution is not running';
  end if;

  update public.automation_events
  set
    status = 'failed',
    processed_at = now(),
    updated_at = now()
  where id = v_execution.automation_event_id
    and status = 'processing';

  return v_execution;
end;
$$;

create or replace function public.create_automation_audit_event(p_organization_id uuid, p_action text, p_automation_id text, p_metadata jsonb default '{}'::jsonb, p_entity_id uuid default null::uuid)
returns audit_log
language plpgsql
security definer
set search_path to 'public'
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

  if not public.organization_payment_active(p_organization_id) then
    raise exception 'Organization payment is not active';
  end if;

  v_action := nullif(trim(p_action), '');
  if v_action is null or v_action not in (
    'automation_enabled',
    'automation_disabled',
    'automation_manual_run_requested',
    'automation_dry_run_requested',
    'automation_retry_requested',
    'automation_retry_succeeded',
    'automation_retry_rejected',
    'automation_config_updated'
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
    p_organization_id, v_user_id, v_action, 'automation', p_entity_id, v_automation_id, v_metadata
  )
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.create_organization_audit_event(p_organization_id uuid, p_action text, p_metadata jsonb default '{}'::jsonb)
returns audit_log
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user_id uuid;
  v_action text;
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

  if not public.organization_payment_active(p_organization_id) then
    raise exception 'Organization payment is not active';
  end if;

  v_action := nullif(trim(p_action), '');
  if v_action is null or v_action not in ('organization_sms_number_updated', 'organization_sms_number_cleared') then
    raise exception 'Unsupported audit action';
  end if;

  v_metadata := coalesce(p_metadata, '{}'::jsonb);
  if jsonb_typeof(v_metadata) is distinct from 'object' then
    raise exception 'metadata must be a JSON object';
  end if;

  insert into public.audit_log (
    organization_id, user_id, action, entity_type, entity_id, automation_id, metadata
  ) values (
    p_organization_id, v_user_id, v_action, 'organization', p_organization_id, null, v_metadata
  )
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.create_review_referral_audit_event(p_organization_id uuid, p_action text, p_entity_type text, p_entity_id uuid, p_metadata jsonb default '{}'::jsonb)
returns audit_log
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user_id uuid;
  v_action text;
  v_entity_type text;
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

  if not public.is_org_member(p_organization_id) then
    raise exception 'Not authorized';
  end if;

  if not public.organization_payment_active(p_organization_id) then
    raise exception 'Organization payment is not active';
  end if;

  v_action := nullif(trim(p_action), '');
  if v_action is null or v_action not in (
    'review_marked_completed', 'review_marked_declined',
    'referral_marked_converted', 'referral_marked_declined'
  ) then
    raise exception 'Unsupported audit action';
  end if;

  v_entity_type := nullif(trim(p_entity_type), '');
  if v_entity_type is null or v_entity_type not in ('review_request', 'referral_request') then
    raise exception 'Unsupported entity type';
  end if;

  if p_entity_id is null then
    raise exception 'entity_id is required';
  end if;

  v_metadata := coalesce(p_metadata, '{}'::jsonb);
  if jsonb_typeof(v_metadata) is distinct from 'object' then
    raise exception 'metadata must be a JSON object';
  end if;

  insert into public.audit_log (
    organization_id, user_id, action, entity_type, entity_id, automation_id, metadata
  ) values (
    p_organization_id, v_user_id, v_action, v_entity_type, p_entity_id, null, v_metadata
  )
  returning * into v_row;

  return v_row;
end;
$$;

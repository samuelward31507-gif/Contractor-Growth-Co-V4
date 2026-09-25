-- HANDOFF-01 (pre-launch lead-leak audit): adds exactly one new
-- automation_incidents category, human_escalation_requested, representing
-- "AI determined that a human needs to intervene in this conversation."
--
-- Purely additive: widens the existing category CHECK constraint and the
-- matching allowlist inside record_automation_incident_signal to accept the
-- new value. No new table, no new column, no RLS change, no backfill, and no
-- change to any existing category's stored data or behavior. Every existing
-- mechanism is reused as-is for the new category too: dedup via the
-- existing partial unique index on (organization_id, fingerprint) WHERE
-- status IN ('open','acknowledged'), resolution via the existing
-- acknowledge_automation_incident/resolve_automation_incident RPCs
-- (unchanged by this migration), and read access via the existing
-- automation_incidents_select policy (unchanged by this migration).
--
-- Deliberately NOT added to 'repeated_workflow_failure'-style escalation:
-- record_automation_incident_signal's own repeated-failure reclassification
-- logic only ever fires for category = 'workflow_failed', so a human
-- escalation can never be auto-reclassified into a different category by
-- that logic - confirmed by re-reading the function body below, unchanged.

alter table public.automation_incidents
  drop constraint automation_incidents_category_check;

alter table public.automation_incidents
  add constraint automation_incidents_category_check check (category in (
    'workflow_failed', 'repeated_workflow_failure', 'workflow_stuck',
    'n8n_dispatch_failed', 'n8n_callback_failed',
    'sms_send_failed', 'sms_delivery_failed',
    'human_escalation_requested'
  ));

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
    'sms_send_failed', 'sms_delivery_failed',
    'human_escalation_requested'
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
    -- Deterministic repeated-failure threshold, unchanged by this migration -
    -- only ever reclassifies an active 'workflow_failed' incident. A
    -- 'human_escalation_requested' incident's category/severity never
    -- changes on conflict.
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

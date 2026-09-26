-- Pass 5C Batch 7, Item 2: the automation-degraded owner alert.
--
-- Adds exactly one new automation_incidents category,
-- scheduled_automation_stale, representing "Trackpr's own scheduled
-- (cron-dependent) automations have gone stale platform-wide" - the exact
-- gap the Pass 5C Batch 6 completion audit identified as the one real
-- missing proactive alert. Purely additive, following
-- 20260924110000_human_escalation_incident_category.sql's own established
-- pattern exactly: widens the existing category CHECK constraint and the
-- matching allowlist inside record_automation_incident_signal, reusing
-- every existing mechanism as-is (dedup via the existing partial unique
-- index on (organization_id, fingerprint) WHERE status IN
-- ('open','acknowledged'), resolution via the existing
-- resolve_automation_incidents_by_fingerprint RPC, read access via the
-- existing automation_incidents_select policy) - none of them are changed
-- by this migration.
--
-- NOTE (observed, not corrected by this migration - out of this task's
-- scope per its own explicit "do not change payment behavior" instruction):
-- the CURRENT LIVE record_automation_incident_signal body (confirmed via
-- pg_get_functiondef before writing this migration, not assumed from
-- migration file order) does not include the organization_payment_active
-- check that 20260921160000_payment_gate_rpc_enforcement.sql added - the
-- later 20260924110000_human_escalation_incident_category.sql migration's
-- own CREATE OR REPLACE FUNCTION did not carry that check forward. This
-- migration reproduces the function's actual current live body exactly
-- (widening only the category allowlist), so as to introduce no further,
-- unrelated behavior change - it neither reintroduces nor removes that
-- check.
--
-- Also adds notification_settings.notify_on_automation_degraded, following
-- the existing notify_on_hot_lead/notify_on_ai_escalation/
-- notify_on_missed_call/notify_on_appointment_booked columns' own exact
-- shape and default (boolean not null default true) - the smallest
-- persistent-state addition genuinely required so an owner can opt out of
-- this new notification kind exactly like every existing one, via the
-- existing Settings > Notifications form. No new table, no RLS change (the
-- existing notification_settings_select/insert/update policies already
-- cover every column, since none of them enumerate specific columns).

alter table public.automation_incidents
  drop constraint automation_incidents_category_check;

alter table public.automation_incidents
  add constraint automation_incidents_category_check check (category in (
    'workflow_failed', 'repeated_workflow_failure', 'workflow_stuck',
    'n8n_dispatch_failed', 'n8n_callback_failed',
    'sms_send_failed', 'sms_delivery_failed',
    'human_escalation_requested',
    'scheduled_automation_stale'
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
    'human_escalation_requested',
    'scheduled_automation_stale'
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
    -- 'scheduled_automation_stale' incident's category/severity never
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

alter table public.notification_settings
  add column if not exists notify_on_automation_degraded boolean not null default true;

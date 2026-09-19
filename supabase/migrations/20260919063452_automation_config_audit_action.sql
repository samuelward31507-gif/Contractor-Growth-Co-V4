-- Automation Configuration V1 - adds automation_config_updated to
-- create_automation_audit_event's action whitelist.
--
-- Same signature as the live function (5 args, matching the Phase E
-- migration - see 20260919052345_automation_retry_audit_actions.sql) - only
-- the allowlist inside the function body changes, so this is a plain
-- CREATE OR REPLACE, not a new overload. No drop/grant/revoke changes are
-- needed: PostgREST already resolves calls to this exact signature, and the
-- existing revoke/grant (authenticated only, never anon/public) already
-- covers this replacement.
create or replace function public.create_automation_audit_event(
  p_organization_id uuid,
  p_action text,
  p_automation_id text,
  p_metadata jsonb default '{}'::jsonb,
  p_entity_id uuid default null
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

  -- Automation Configuration V1 adds automation_config_updated to the same,
  -- still explicit allowlist established in prior phases - never a
  -- generic/arbitrary action string.
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

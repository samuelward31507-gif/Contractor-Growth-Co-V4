-- Automation Control Center V2 - Phase E: retry audit actions + entity_id.
--
-- REQUIRED, NOT YET APPLIED - see the Phase E report for why this migration
-- is necessary and the explicit instruction to stop and report before
-- applying it.
--
-- Two changes to create_automation_audit_event:
--
-- 1. Action whitelist widened to include the three retry actions Phase E's
--    audit logging requirement needs (automation_retry_requested,
--    automation_retry_succeeded, automation_retry_rejected) - calling the
--    RPC with any of them today would fail with "Unsupported audit action".
--
-- 2. New optional p_entity_id uuid parameter (default null). Every prior
--    caller of this RPC (enable/disable, manual run, dry run) has no real
--    database row to point entity_id at and keeps getting null via the
--    default - unchanged. Retry is different: a real workflow_executions
--    row exists for every retry action, and per this codebase's own
--    established convention (entity_id always holds a real row's UUID when
--    one is relevant - see automation_events.entity_id, and the Phase A
--    migration's own note that audit_log.entity_id "continues representing
--    a real database entity/execution/event when applicable"), the
--    execution's id belongs in entity_id, not buried in metadata.
--
-- Adding a parameter grows the signature - a new overload, not a
-- replacement (the same situation documented in the Phase D and Phase C.1
-- migrations for this same function) - the old 4-argument overload is
-- dropped below so PostgREST is never ambiguous about which one to call.

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

  -- Phase E adds the three retry actions to the same, still explicit
  -- allowlist Phase C.1/D established - never a generic/arbitrary action
  -- string.
  v_action := nullif(trim(p_action), '');
  if v_action is null or v_action not in (
    'automation_enabled',
    'automation_disabled',
    'automation_manual_run_requested',
    'automation_dry_run_requested',
    'automation_retry_requested',
    'automation_retry_succeeded',
    'automation_retry_rejected'
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

drop function if exists public.create_automation_audit_event(uuid, text, text, jsonb);

revoke all on function public.create_automation_audit_event(uuid, text, text, jsonb, uuid) from public;
revoke all on function public.create_automation_audit_event(uuid, text, text, jsonb, uuid) from anon;
grant execute on function public.create_automation_audit_event(uuid, text, text, jsonb, uuid) to authenticated;

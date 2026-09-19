-- Automation Control Center V2 - Phase C.1: secure audit logging for
-- automation enable/disable.
--
-- audit_log has no client-facing INSERT policy (RLS grants SELECT only,
-- via audit_log_select -> is_org_member) - confirmed by inspection, and
-- deliberately left that way here too, per explicit instruction never to
-- add a broad client INSERT policy. The one write pattern this codebase
-- already trusts for a table in that exact shape is a narrowly-scoped
-- SECURITY DEFINER RPC that re-derives and re-verifies everything itself
-- (create_automation_event/start_workflow_execution/complete_workflow_
-- execution/fail_workflow_execution all follow this shape - none of their
-- underlying tables have a client INSERT/UPDATE policy either). This
-- migration adds exactly one such RPC, scoped to the two audit actions
-- Phase C needs, not a generic arbitrary audit-event writer.
--
-- Authorization model: unlike create_automation_event/start_workflow_
-- execution, this RPC has no service-role caller in its design at all -
-- automation enable/disable is only ever performed by a real, logged-in
-- org admin through app/(app)/automations/actions.ts, never from a
-- webhook/cron context - so there is no auth.role() = 'service_role'
-- branch here, unlike its siblings. The actor is always auth.uid();
-- authorization is always public.is_org_admin(p_organization_id), the same
-- authority automation_settings' own RLS and Phase B's assertOrgAdmin()
-- already use - never is_agency_admin(), which remains read-only
-- everywhere in this codebase. A normal org member, a cross-org caller,
-- and an agency admin with no owner/admin membership in this exact
-- organization are all rejected identically by the same is_org_admin()
-- check - no special-casing, no bypass surface, matching assertOrgAdmin's
-- own documented design.

create or replace function public.create_automation_audit_event(
  p_organization_id uuid,
  p_action text,
  p_automation_id text,
  p_metadata jsonb default '{}'::jsonb
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

  -- The sole authority check. Deliberately not is_agency_admin() and
  -- deliberately not a second, separately-maintained membership/role
  -- lookup - is_org_admin() already re-derives everything from auth.uid()
  -- itself, so reimplementing that here would just be a second source of
  -- truth that could drift from it.
  if not public.is_org_admin(p_organization_id) then
    raise exception 'Not authorized';
  end if;

  -- Scoped to exactly the two Phase C actions - anything else (including a
  -- typo, or a future caller trying to reuse this RPC for something it was
  -- never reviewed for) is rejected outright rather than silently accepted.
  v_action := nullif(trim(p_action), '');
  if v_action is null or v_action not in ('automation_enabled', 'automation_disabled') then
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

  -- user_id is always auth.uid(), captured above - never a caller-supplied
  -- value. entity_id is always null: enable/disable has no workflow
  -- execution or automation_events row of its own to point at.
  insert into public.audit_log (
    organization_id, user_id, action, entity_type, entity_id, automation_id, metadata
  ) values (
    p_organization_id, v_user_id, v_action, 'automation', null, v_automation_id, v_metadata
  )
  returning * into v_row;

  return v_row;
end;
$$;

-- Same three-statement grant pattern used for every other RPC in this
-- family (see automation_core_foundation.sql) - explicit revoke from
-- public/anon, explicit grant to authenticated only. No service_role
-- grant: this RPC has no legitimate service-role caller (see above), so
-- none is given.
revoke all on function public.create_automation_audit_event(uuid, text, text, jsonb) from public;
revoke all on function public.create_automation_audit_event(uuid, text, text, jsonb) from anon;
grant execute on function public.create_automation_audit_event(uuid, text, text, jsonb) to authenticated;
